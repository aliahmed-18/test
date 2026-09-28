// Tunable knobs for the AI aggregation pipeline. Every value can be overridden
// with an Edge Function secret (`supabase secrets set NAME=value`) so you can
// experiment during testing without redeploying code.

function numberFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  /**
   * Minimum similarity (0–1) the model must report for a question to join an
   * existing group. Lower = more aggressive merging, higher = more groups.
   *   ~0.9  only near-paraphrases merge
   *   ~0.65 same underlying concept merges (constructor "what/when/why")  <- default
   *   ~0.4  loosely related topics merge (constructor + getter) – too coarse
   */
  similarityThreshold: numberFromEnv("SIMILARITY_THRESHOLD", 0.65),

  /** Claude model used for classification. */
  model: Deno.env.get("CLASSIFIER_MODEL") ?? "claude-opus-5",

  /** Effort level – classification is a short, focused task, so keep it low. */
  effort: (Deno.env.get("CLASSIFIER_EFFORT") ?? "low") as "low" | "medium" | "high",

  /** How many example questions per group are shown to the model. */
  examplesPerGroup: numberFromEnv("CLASSIFIER_EXAMPLES_PER_GROUP", 5),

  /** Automatic attempts before a question is left as "Classification pending". */
  maxAttempts: numberFromEnv("CLASSIFIER_MAX_ATTEMPTS", 3),

  /** A question stuck in "processing" longer than this is considered abandoned. */
  staleProcessingSeconds: 120,

  /** Per-session lock lease; renewed after every question. */
  lockSeconds: 90,

  /** Stop picking up new work after this long (Edge Functions have a wall-clock limit). */
  workerBudgetMs: 120_000,
};
