# Getit – Questions Box

A live classroom question box. The instructor creates a session and shares a 6-character code, students submit questions from their phones, and the questions appear on the instructor's dashboard in real time. Claude groups questions that ask about the same underlying concept, like *"What is a constructor?"*, *"When does a constructor run?"* and *"What does `new Student()` do?"*, and shows how many questions each group has.

**Stack**
- Frontend: React + TypeScript + Tailwind CSS (Vite)
- Backend: **Go** (`net/http`, `pgx`), with **Postgres** for storage and **Server-Sent Events** for live updates
- AI: Claude, called through the official Anthropic Go SDK from the server only. The API key never reaches the browser.

```
Student phone ──POST /questions──▶ Go server ──insert──▶ Postgres
                                     │  │
             SSE /events ◀──publish──┘  └─kick──▶ classification worker ──▶ Claude
Instructor dashboard ◀── live updates (question, group, participant, session)
```

## Quick start

### Option A: Docker (one command)

```bash
cp .env.example .env               # set ANTHROPIC_API_KEY
docker compose up --build          # http://localhost:8080
```

### Option B: run locally

Prerequisites: Go 1.25+, Node 20+, Postgres 14+.

```bash
createdb getit                     # or use any Postgres database
npm install

# Terminal 1: API server (applies DB migrations on startup)
export ANTHROPIC_API_KEY=sk-ant-...
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/getit?sslmode=disable"
npm run server                     # = cd server && go run .   → :8080

# Terminal 2: frontend with hot reload (proxies /api to :8080)
npm run dev                        # http://localhost:5173
```

For a single-process setup, run `npm run build` once. The Go server then also serves the built app from `../dist` on port 8080.

> **Phones in the classroom:** the server listens on all interfaces. Students on the same Wi-Fi can open `http://<your-laptop-ip>:8080/join`, or `:5173` if you run `npm run dev -- --host`.

### Try the end-to-end flow

1. **Window 1:** open the app and click **Create Live Session**. The dashboard shows the code and a green **Live** indicator.
2. **Window 2** (or a phone): open `/join`, enter the code, type a question and your name, then click **Submit Question**.
3. The question appears on the dashboard right away, marked *Analyzing…*. A moment later it gets a group title, and the group appears under **Question Groups** with its count. No page refresh is needed.
4. Click **Generate Test Questions** to add 12 classroom questions about classes, attributes, constructors, getters and object creation. The server inserts them one by one through the same AI pipeline as real questions. No groups are hard-coded.

## API

| Method & path | Purpose |
|---|---|
| `POST /api/sessions` | Create a session → `{session, host_key}` |
| `GET /api/sessions/{code}` | Look up a session (404 = invalid code) |
| `GET /api/sessions/{code}/snapshot` | Session + participants + questions + groups |
| `GET /api/sessions/{code}/events` | **Live stream (SSE)**. The first message is a snapshot; after that, `{type, data}` upserts. With `?scope=session`, only session status is sent (students use this) |
| `POST /api/sessions/{code}/participants` | `{display_name}` → participant |
| `POST /api/sessions/{code}/questions` | `{participant_id, text, client_request_id}` → 201, or 200 if the same `client_request_id` was already stored |
| `POST /api/sessions/{code}/end` | Header `X-Host-Key`: ends the session |
| `POST /api/sessions/{code}/retry-classification` | Re-queue questions whose automatic attempts ran out |
| `POST /api/sessions/{code}/demo` | Insert the demo questions |
| `GET /healthz` | Health check |

## How the AI aggregation works

`server/worker.go`, `server/classifier.go`

- When a question is stored, the server **responds to the student immediately** and signals the worker.
- The worker runs **at most one goroutine per session**. It processes that session's pending questions oldest-first. So when many students submit at once, two paraphrases can't each create their own "Constructors" group.
- For each question, Claude sees the existing groups (title, representative question and up to 5 example questions each) and returns structured JSON: the closest group, a **0–1 similarity score** for the *underlying concept*, a 1–4 word title and a representative question. The prompt tells Claude to group by concept rather than keywords. For example, *"How can I retrieve a private attribute?"* belongs with getters, while *"What is a constructor?"* and *"What is a getter?"* stay apart despite the shared wording.
- **The code decides whether a question joins a group.** It joins the closest group only if the similarity is at or above `SIMILARITY_THRESHOLD`. Otherwise a new group is created.
- Every change (question analyzing → classified, new or updated group) is published to the SSE stream, so the dashboard updates live.

### Tuning

All settings are environment variables (see `server/config.go`):

| Variable | Default | Meaning |
|---|---|---|
| `SIMILARITY_THRESHOLD` | `0.65` | `0.9` = only rewordings merge · `0.65` = same concept (what/when/why) merges · `0.4` = related topics merge (too coarse) |
| `CLASSIFIER_MODEL` | `claude-opus-5` | Claude model id |
| `CLASSIFIER_EFFORT` | `low` | `low` / `medium` / `high` |
| `CLASSIFIER_MAX_ATTEMPTS` | `3` | Automatic attempts before "Classification pending" |
| `CLASSIFIER_EXAMPLES_PER_GROUP` | `5` | Example questions per group shown to Claude |

The server logs every decision, for example `classified "When is a constructor called?" -> existing "Constructors" (similarity 0.86, threshold 0.65): …`. Use these logs to calibrate the threshold.

## Reliability and error handling

| Situation | Behaviour |
|---|---|
| Invalid code | "No session found with code …" |
| Ended session | Students see "This session has ended" live. The API rejects new participants and questions (409) |
| Empty or too-long question | Validated in the browser, by the API and by a database `CHECK` constraint |
| Double-click or retry after a network drop | Each draft has a `client_request_id` (unique). A retried submit returns the stored question and is never duplicated. Re-asking the same text from the same browser is blocked with a message |
| AI fails or is unavailable | The question stays visible, goes back to `pending` with the error recorded and is retried (up to 3 attempts). When the AI service is down, the worker pauses. A sweep every 20 s resumes it. After the attempts run out, the dashboard shows **Classification pending** and a **Retry now** button |
| Server restarts mid-classification | Questions left `processing` are reset to `pending` on startup and picked up again |
| Dashboard loses its connection | A "Reconnecting…" indicator appears. The browser reconnects automatically and receives a fresh snapshot, so nothing is missed |

## Data model

Migrations live in `server/migrations/` and are applied automatically on startup.

- `sessions`: `id, code (6 chars, unique), status (active|ended), host_key, created_at, ended_at`
- `participants`: `id, session_id → sessions, display_name, created_at`
- `questions`: `id, session_id → sessions, participant_id → participants, text, created_at, group_id → question_groups (nullable: at most one group), classification_status (pending|processing|classified)`, plus retry bookkeeping and `client_request_id`
- `question_groups`: `id, session_id → sessions, title, representative_question, created_at, updated_at`

**Security model (MVP, no accounts):** anyone with a session code can view it, join and submit questions. Only the browser that created a session holds its `host_key`, and only that browser can end it. Students' event streams carry only session status, never other students' questions.

**Scaling note:** live updates fan out in memory inside one server process, which is plenty for a classroom. Running several replicas would need a shared pub/sub, such as Postgres `LISTEN/NOTIFY`.

## Project layout

```
server/                 Go backend
  main.go               wiring, static file serving, CORS, graceful shutdown
  api.go, demo.go       HTTP handlers + SSE stream
  hub.go                in-memory live-update fan-out
  worker.go             per-session classification queue, sweep and recovery
  classifier.go         Claude prompt + structured output + threshold decision
  store.go              Postgres queries (pgx); migrations/ embedded SQL
  config.go             environment configuration
src/
  pages/                HomePage, HostDashboardPage, StudentJoinPage, StudentAskPage
  components/           Logo, QuestionViews (group + question cards)
  hooks/useLiveSession  EventSource subscription: snapshot + upserts + reconnect
  lib/                  api.ts (all HTTP calls), questionState.ts, types.ts, storage.ts
```
