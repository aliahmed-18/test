# Getit – Questions Box

A live classroom question box. The instructor creates a session and shares a 6-character code, students submit questions from their phones, and the questions appear on the instructor's dashboard in real time. Claude groups questions that ask about the same underlying concept, like *"What is a constructor?"*, *"When does a constructor run?"* and *"What does `new Student()` do?"*, and shows how many questions each group has.

**Stack:** React + TypeScript + Tailwind CSS (Vite) · Supabase (Postgres, Row Level Security, Realtime, Edge Functions) · Claude via the Anthropic SDK, called only from the Edge Function.

```
Student browser ──insert──▶ questions (Postgres) ──Realtime──▶ Instructor dashboard
       │                          ▲
       └─invoke (fire & forget)─▶ Edge Function: classify-questions ──▶ Claude
                                  (per-session lock; drains pending queue,
                                   assigns group or creates a new one)
```

## Quick start (local)

Prerequisites: Node 20+, Docker (for the local Supabase stack), and an Anthropic API key.

```bash
npm install

# 1. Start Supabase locally. This applies supabase/migrations automatically.
npm run db:start
#    Copy "API URL" and the "anon"/"publishable" key from the output.

# 2. Frontend env
cp .env.example .env            # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY

# 3. Edge Function secrets
cp supabase/functions/.env.example supabase/functions/.env   # set ANTHROPIC_API_KEY
npm run functions:serve         # keep running in its own terminal

# 4. App
npm run dev                     # http://localhost:5173
```

### Try the end-to-end flow

1. **Window 1:** open http://localhost:5173 and click **Create Live Session**. The dashboard shows the session code.
2. **Window 2** (or your phone): open `/join`, enter the code, type a question and your name, then click **Submit Question**.
3. The question appears in **Recent Questions** right away, marked *Analyzing…*. After a moment it gets a group title, and the group appears under **Question Groups** with its count.
4. Click **Generate Test Questions** on the dashboard to add 12 classroom questions about classes, attributes, constructors, getters and object creation. They go through the same AI pipeline as real student questions. No groups are hard-coded.

> To test from phones on the same Wi-Fi, run `npm run dev -- --host` and use your laptop's LAN IP.

## Deploying to hosted Supabase

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
npm run deploy                  # pushes the migration + deploys the Edge Function
```

Put the project URL and anon/publishable key in `.env` (or in your static host's env settings), then run `npm run build` and deploy `dist/` to any static host. Configure the host to serve `index.html` for all routes (SPA fallback).

## How the AI aggregation works

`supabase/functions/classify-questions/`

- **`index.ts`**: the worker. When a student submits, the browser saves the question and then invokes the function without waiting for it. The function takes a **per-session lock** (`try_acquire_classifier_lock`) and processes pending questions one at a time, oldest first. If several students submit at once, only one worker runs; the others return `busy` and their questions are handled in the same run. This means two paraphrases can't each create their own "Constructors" group.
- **`classifier.ts`**: one Claude call per question. Claude sees the existing groups (title, representative question and up to 5 example questions each) and returns structured JSON: the closest group, a **0–1 similarity score** for the *underlying concept*, a 1–4 word title and a representative question. The prompt tells Claude to group by concept rather than keywords. For example, *"How can I retrieve a private attribute?"* belongs with getters, while *"What is a getter?"* and *"What is a constructor?"* stay apart even though they share wording.
- **`config.ts`**: tunable settings. The code decides whether a question joins a group. It joins the closest group only if the similarity is at or above **`SIMILARITY_THRESHOLD` (default `0.65`)**. Otherwise a new group is created.

### Tuning the threshold

```bash
# local: add to supabase/functions/.env and restart functions:serve
SIMILARITY_THRESHOLD=0.75
# hosted:
npx supabase secrets set SIMILARITY_THRESHOLD=0.75
```

| Threshold | Behaviour |
|---|---|
| `0.9` | Only near-identical rewordings merge |
| `0.65` (default) | Same concept, different aspect (what/when/why of constructors) merges |
| `0.4` | Related topics merge (constructors + getters). Too coarse |

The function logs each decision, including the similarity, the threshold and a one-line reason (`npx supabase functions logs classify-questions` when hosted). You can use these logs to calibrate the threshold. Other settings: `CLASSIFIER_MODEL` (default `claude-opus-5`), `CLASSIFIER_EFFORT` (default `low`), `CLASSIFIER_MAX_ATTEMPTS` and `CLASSIFIER_EXAMPLES_PER_GROUP`.

## Reliability and error handling

| Situation | Behaviour |
|---|---|
| Invalid code | "No session found with code …" |
| Ended session | Students see "This session has ended". RLS also rejects inserts into ended sessions |
| Empty or too-long question | Validated in the browser and by a database `CHECK` constraint |
| Double-click or retry after a network drop | Each draft has a `client_request_id` (unique). A retried insert is treated as success and never duplicated. Re-asking the same text is blocked with a message |
| AI fails or is unavailable | The question stays visible, goes back to `pending` with the error recorded and is retried up to 3 times. After that the dashboard shows **Classification pending** and a **Retry now** button |
| Worker crashes mid-question | A question stuck in `processing` for more than 2 minutes is picked up again. The lock lease expires on its own |
| Student closed the tab before the worker was triggered | The dashboard notices questions waiting too long and triggers the worker again |
| Dashboard loses its connection | A "Reconnecting…" indicator appears. On reconnect or `online`, all data is refetched so nothing is missed |

## Data model

`supabase/migrations/20260928000000_init.sql`

- `sessions`: `id, code (6 chars, unique), status (active|ended), created_at`
- `participants`: `id, session_id → sessions, display_name, created_at`
- `questions`: `id, session_id → sessions, participant_id → participants, text, created_at, group_id → question_groups (nullable: at most one group), classification_status (pending|processing|classified)`, plus retry bookkeeping and `client_request_id`
- `question_groups`: `id, session_id → sessions, title, representative_question, created_at, updated_at`
- `session_host_keys`: a secret created with each session and kept in the instructor's browser. Only that browser can end the session. The anon role can't read it.

**Security model (MVP, no accounts):** with the anon key, anyone can read session data (Realtime needs this), join an *active* session and submit questions. Only the Edge Function, using the service role, can create groups or change classification. The Anthropic key exists only as an Edge Function secret.

## Project layout

```
src/
  pages/        HomePage, HostDashboardPage, StudentJoinPage, StudentAskPage
  components/   Logo, QuestionViews (group + question cards), SetupNotice
  hooks/        useLiveSession: initial load + Realtime sync + reconnect catch-up
  lib/          api.ts (all Supabase calls), questionState.ts, types.ts, storage.ts
supabase/
  migrations/   schema, RLS, RPCs, realtime publication
  functions/classify-questions/   AI worker (index.ts, classifier.ts, config.ts)
```
