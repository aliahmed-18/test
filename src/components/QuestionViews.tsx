import { formatTime, type QuestionState } from '../lib/questionState'
import type { Question, QuestionGroup } from '../lib/types'

export function StatusBadge({ state }: { state: QuestionState }) {
  if (state.kind === 'grouped') {
    return (
      <span className="inline-flex max-w-full items-center truncate rounded-md bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">
        {state.group.title}
      </span>
    )
  }
  if (state.kind === 'analyzing') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
        Analyzing…
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
      title={state.reason ?? 'The AI has not classified this question yet'}
    >
      Classification pending
    </span>
  )
}

const FRESH_MS = 5_000

export function QuestionCard({
  question,
  author,
  state,
  now,
}: {
  question: Question
  author: string
  state: QuestionState
  now: number
}) {
  const fresh = now - new Date(question.created_at).getTime() < FRESH_MS
  return (
    <li className={`card px-4 py-3 ${fresh ? 'animate-arrive' : ''}`}>
      <p className="text-[15px] leading-snug whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{question.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="font-medium text-ink/80">{author}</span>
        <span aria-hidden>·</span>
        <time dateTime={question.created_at} title={new Date(question.created_at).toLocaleString()}>
          {formatTime(question.created_at, now)}
        </time>
        <span className="ml-auto">
          <StatusBadge state={state} />
        </span>
      </div>
    </li>
  )
}

export function GroupCard({
  group,
  questions,
  authorOf,
  expanded,
  onToggle,
  now,
}: {
  group: QuestionGroup
  questions: Question[]
  authorOf: (q: Question) => string
  expanded: boolean
  onToggle: () => void
  now: number
}) {
  const count = questions.length
  return (
    <li className="card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-4 px-5 py-4 text-left transition hover:bg-canvas"
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold text-ink">{group.title}</h3>
          <p className="mt-1 text-[15px] leading-snug text-muted">“{group.representative_question}”</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-lg bg-brand px-2.5 py-1 text-sm font-bold text-white tabular-nums">
            {count} <span className="font-medium opacity-80">question{count === 1 ? '' : 's'}</span>
          </span>
          <span className="text-xs text-muted">{expanded ? 'Hide ▲' : 'Show ▼'}</span>
        </div>
      </button>
      {expanded && (
        <ul className="divide-y divide-line border-t border-line bg-canvas/60">
          {questions.map((q) => (
            <li key={q.id} className="px-5 py-2.5">
              <p className="text-sm leading-snug whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{q.text}</p>
              <p className="mt-0.5 text-xs text-muted">
                {authorOf(q)} · {formatTime(q.created_at, now)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
