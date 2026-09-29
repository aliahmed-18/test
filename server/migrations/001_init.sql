-- Getit – Questions Box: core schema.
-- Sessions -> participants -> questions, plus AI-generated question groups.

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  status      text not null default 'active' check (status in ('active', 'ended')),
  -- Secret held by the instructor's browser; required to end the session.
  host_key    uuid not null default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create table participants (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id) on delete cascade,
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 60),
  created_at    timestamptz not null default now()
);
create index participants_session_idx on participants(session_id);

create table question_groups (
  id                       uuid primary key default gen_random_uuid(),
  session_id               uuid not null references sessions(id) on delete cascade,
  title                    text not null,
  representative_question  text not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index question_groups_session_idx on question_groups(session_id);

create table questions (
  id                        uuid primary key default gen_random_uuid(),
  session_id                uuid not null references sessions(id) on delete cascade,
  participant_id            uuid not null references participants(id) on delete cascade,
  text                      text not null check (char_length(btrim(text)) between 1 and 1000),
  created_at                timestamptz not null default now(),
  -- A question belongs to at most one group.
  group_id                  uuid references question_groups(id) on delete set null,
  classification_status     text not null default 'pending'
                              check (classification_status in ('pending', 'processing', 'classified')),
  classification_attempts   integer not null default 0,
  classification_error      text,
  classification_updated_at timestamptz not null default now(),
  -- Idempotency key from the submitting browser: a retried submit after a
  -- network blip can never create a second copy of the question.
  client_request_id         uuid unique
);
create index questions_session_idx on questions(session_id, created_at);
create index questions_unclassified_idx on questions(session_id, created_at)
  where classification_status <> 'classified';
create index questions_group_idx on questions(group_id);
