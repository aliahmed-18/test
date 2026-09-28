// Edge Function: classify-questions
//
// Invoked (fire-and-forget) by the browser after a question is inserted, and by
// the instructor dashboard to retry. It drains the session's queue of pending
// questions one at a time while holding a per-session lock, so concurrent
// submissions are classified sequentially and never create duplicate groups.
//
// POST { "session_id": "<uuid>", "retry_failed"?: boolean }

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { classifyQuestion, ClassifierUnavailableError, type GroupContext } from "./classifier.ts";
import { config } from "./config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { session_id?: unknown; retry_failed?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!UUID_RE.test(sessionId)) return json({ error: "session_id must be a UUID" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  if (body.retry_failed === true) {
    // Give questions that exhausted their automatic attempts another chance.
    const { error } = await supabase
      .from("questions")
      .update({ classification_attempts: 0, classification_error: null })
      .eq("session_id", sessionId)
      .neq("classification_status", "classified");
    if (error) return json({ error: error.message }, 500);
  }

  const startedAt = Date.now();
  let processed = 0;
  let acquiredOnce = false;

  // Loop so a question inserted right as we release the lock is not stranded.
  while (Date.now() - startedAt < config.workerBudgetMs) {
    const { data: acquired, error: lockError } = await supabase.rpc("try_acquire_classifier_lock", {
      p_session_id: sessionId,
      p_seconds: config.lockSeconds,
    });
    if (lockError) return json({ error: lockError.message }, 500);
    if (!acquired) {
      // Another worker is draining this session's queue and will pick up our question.
      return json({ status: acquiredOnce ? "done" : "busy", processed });
    }
    acquiredOnce = true;

    try {
      processed += await drainQueue(supabase, sessionId, startedAt);
    } finally {
      await supabase.rpc("release_classifier_lock", { p_session_id: sessionId });
    }

    if (!(await hasClassifiableWork(supabase, sessionId))) break;
  }

  return json({ status: "done", processed });
});

function staleCutoff(): string {
  return new Date(Date.now() - config.staleProcessingSeconds * 1000).toISOString();
}

/** Pending questions (or ones abandoned mid-processing) that still have attempts left. */
function classifiableQuery(supabase: SupabaseClient, sessionId: string) {
  return supabase
    .from("questions")
    .select("id, text, classification_attempts")
    .eq("session_id", sessionId)
    .lt("classification_attempts", config.maxAttempts)
    .or(
      `classification_status.eq.pending,and(classification_status.eq.processing,classification_updated_at.lt.${staleCutoff()})`,
    );
}

async function hasClassifiableWork(supabase: SupabaseClient, sessionId: string): Promise<boolean> {
  const { data } = await classifiableQuery(supabase, sessionId).limit(1);
  return (data?.length ?? 0) > 0;
}

async function drainQueue(supabase: SupabaseClient, sessionId: string, startedAt: number): Promise<number> {
  let processed = 0;

  while (Date.now() - startedAt < config.workerBudgetMs) {
    const { data: next, error } = await classifiableQuery(supabase, sessionId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!next) break;

    await supabase
      .from("questions")
      .update({
        classification_status: "processing",
        classification_attempts: next.classification_attempts + 1,
        classification_updated_at: new Date().toISOString(),
      })
      .eq("id", next.id);

    try {
      const groups = await loadGroups(supabase, sessionId);
      const decision = await classifyQuestion(next.text, groups);
      const now = new Date().toISOString();

      let groupId: string;
      if (decision.kind === "existing") {
        groupId = decision.groupId;
        await supabase
          .from("question_groups")
          .update({ representative_question: decision.representativeQuestion, updated_at: now })
          .eq("id", groupId);
      } else {
        const { data: created, error: createError } = await supabase
          .from("question_groups")
          .insert({
            session_id: sessionId,
            title: decision.title,
            representative_question: decision.representativeQuestion,
          })
          .select("id")
          .single();
        if (createError) throw createError;
        groupId = created.id;
      }

      const { error: updateError } = await supabase
        .from("questions")
        .update({
          group_id: groupId,
          classification_status: "classified",
          classification_error: null,
          classification_updated_at: now,
        })
        .eq("id", next.id);
      if (updateError) throw updateError;

      console.log(
        `classified ${next.id} -> ${decision.kind === "existing" ? "existing" : `new "${decision.title}"`} ` +
          `(similarity ${decision.similarity.toFixed(2)}, threshold ${config.similarityThreshold}): ${decision.reasoning}`,
      );
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`classification failed for ${next.id}:`, message);
      // Never lose the question: put it back to pending with the error recorded.
      await supabase
        .from("questions")
        .update({
          classification_status: "pending",
          classification_error: message.slice(0, 500),
          classification_updated_at: new Date().toISOString(),
        })
        .eq("id", next.id);

      if (err instanceof ClassifierUnavailableError) {
        // The AI service is down or misconfigured: stop hammering it. Remaining
        // questions stay pending and can be retried from the dashboard.
        break;
      }
    }

    await supabase.rpc("extend_classifier_lock", { p_session_id: sessionId, p_seconds: config.lockSeconds });
  }

  return processed;
}

async function loadGroups(supabase: SupabaseClient, sessionId: string): Promise<GroupContext[]> {
  const [{ data: groups, error: groupsError }, { data: members, error: membersError }] = await Promise.all([
    supabase
      .from("question_groups")
      .select("id, title, representative_question")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true }),
    supabase
      .from("questions")
      .select("group_id, text")
      .eq("session_id", sessionId)
      .not("group_id", "is", null)
      .order("created_at", { ascending: false }),
  ]);
  if (groupsError) throw groupsError;
  if (membersError) throw membersError;

  const byGroup = new Map<string, string[]>();
  for (const member of members ?? []) {
    const list = byGroup.get(member.group_id) ?? [];
    list.push(member.text);
    byGroup.set(member.group_id, list);
  }

  return (groups ?? []).map((group) => {
    const texts = byGroup.get(group.id) ?? [];
    return {
      id: group.id,
      title: group.title,
      representativeQuestion: group.representative_question,
      exampleQuestions: texts.slice(0, config.examplesPerGroup),
      questionCount: texts.length,
    };
  });
}
