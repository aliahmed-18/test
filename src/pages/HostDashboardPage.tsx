import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { GroupCard, QuestionCard } from '../components/QuestionViews'
import { ANALYZING_GRACE_MS, questionState, useNow } from '../lib/questionState'
import { useLiveSession, type ConnectionState } from '../hooks/useLiveSession'
import { endSession, generateTestQuestions, getHostKey, normalizeCode, triggerClassification, UserFacingError } from '../lib/api'
import type { Question } from '../lib/types'

export function HostDashboardPage() {
  const code = normalizeCode(useParams().code ?? '')
  const { session, participants, questions, groups, loading, error, connection, reload } = useLiveSession(code)
  const now = useNow()

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const [demoProgress, setDemoProgress] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const namesById = useMemo(() => new Map(participants.map((p) => [p.id, p.display_name])), [participants])
  const authorOf = (q: Question) => namesById.get(q.participant_id) ?? 'Student'

  const recent = useMemo(() => [...questions].reverse(), [questions])

  const groupedQuestions = useMemo(() => {
    const map = new Map<string, Question[]>()
    for (const q of questions) {
      if (q.classification_status !== 'classified' || !q.group_id) continue
      const list = map.get(q.group_id) ?? []
      list.push(q)
      map.set(q.group_id, list)
    }
    return map
  }, [questions])

  const sortedGroups = useMemo(
    () =>
      groups
        .map((group) => ({ group, items: groupedQuestions.get(group.id) ?? [] }))
        .filter(({ items }) => items.length > 0)
        .sort((a, b) => b.items.length - a.items.length || b.group.updated_at.localeCompare(a.group.updated_at)),
    [groups, groupedQuestions],
  )

  const pendingCount = questions.filter((q) => questionState(q, groupsById, now).kind === 'pending').length

  // Safety net: if a question has been waiting a while (e.g. the student's
  // browser closed before the worker was invoked), nudge the worker again.
  const lastNudge = useRef(0)
  useEffect(() => {
    if (!session || session.status !== 'active') return
    const stuck = questions.some(
      (q) =>
        q.classification_status === 'pending' &&
        !q.classification_error &&
        now - new Date(q.created_at).getTime() > ANALYZING_GRACE_MS / 2,
    )
    if (stuck && now - lastNudge.current > 30_000) {
      lastNudge.current = now
      void triggerClassification(session.id)
    }
  }, [questions, now, session])

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setActionError('Copy failed – select the code and copy it manually.')
    }
  }

  async function runDemo() {
    if (!session) return
    setActionError(null)
    setDemoProgress('Starting…')
    try {
      await generateTestQuestions(session, (done, total) => setDemoProgress(`${done}/${total}`))
    } catch (err) {
      setActionError(err instanceof UserFacingError ? err.message : 'Could not generate test questions.')
    } finally {
      setDemoProgress(null)
    }
  }

  async function handleEnd() {
    if (!session || !window.confirm('End this session? Students will no longer be able to submit questions.')) return
    try {
      await endSession(session.id)
    } catch (err) {
      setActionError(err instanceof UserFacingError ? err.message : 'Could not end the session.')
    }
  }

  function toggle(groupId: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  if (loading) {
    return <FullPageMessage>Loading session…</FullPageMessage>
  }
  if (!session) {
    return (
      <FullPageMessage>
        <p className="text-red-600">{error ?? 'Session not found.'}</p>
        <div className="mt-4 flex justify-center gap-3">
          <button className="btn-secondary" onClick={() => void reload()}>
            Try again
          </button>
          <Link to="/" className="btn-primary">
            Create a new session
          </Link>
        </div>
      </FullPageMessage>
    )
  }

  const active = session.status === 'active'
  const isHost = Boolean(getHostKey(session.id))

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center gap-x-7 gap-y-4 px-6 py-4">
          <Link to="/" className="flex items-baseline gap-3">
            <Logo />
            <span className="text-base font-medium text-muted">Questions Box</span>
          </Link>

          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-brand-soft px-4 py-2">
              <div className="text-[11px] font-semibold tracking-wider text-brand/80 uppercase">Session Code</div>
              <div className="font-mono text-3xl leading-tight font-bold tracking-[0.18em] text-brand">{session.code}</div>
            </div>
            <div className="flex flex-col gap-1.5">
              <button className="btn-secondary px-3 py-1.5 text-xs" onClick={copyCode}>
                {copied ? 'Copied ✓' : 'Copy Code'}
              </button>
              <a className="btn-secondary px-3 py-1.5 text-xs" href={`/join/${session.code}`} target="_blank" rel="noreferrer">
                Join as Student ↗
              </a>
            </div>
          </div>

          <dl className="flex gap-6">
            <Stat label={participants.length === 1 ? 'Student' : 'Students'} value={participants.length} />
            <Stat label={questions.length === 1 ? 'Question' : 'Questions'} value={questions.length} />
            <Stat label={sortedGroups.length === 1 ? 'Group' : 'Groups'} value={sortedGroups.length} />
          </dl>

          <div className="ml-auto flex items-center gap-3">
            <ConnectionPill state={connection} ended={!active} />
            {active && (
              <button className="btn-secondary" onClick={runDemo} disabled={demoProgress !== null}>
                {demoProgress ? `Adding questions ${demoProgress}` : 'Generate Test Questions'}
              </button>
            )}
            {active && isHost && (
              <button className="btn-ghost" onClick={handleEnd}>
                End Session
              </button>
            )}
          </div>
        </div>
      </header>

      {(actionError || pendingCount > 0) && (
        <div className="mx-auto max-w-[1480px] space-y-2 px-6 pt-4">
          {actionError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {actionError}
            </div>
          )}
          {pendingCount > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              <span>
                {pendingCount} question{pendingCount === 1 ? ' is' : 's are'} waiting for AI classification. They stay
                visible in Recent Questions.
              </span>
              <button
                className="ml-auto font-semibold underline underline-offset-2 hover:text-amber-950"
                onClick={() => void triggerClassification(session.id, { retryFailed: true })}
              >
                Retry now
              </button>
            </div>
          )}
        </div>
      )}

      <main className="mx-auto grid max-w-[1480px] gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-labelledby="groups-heading">
          <h2 id="groups-heading" className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">
            Question Groups
          </h2>
          {sortedGroups.length === 0 ? (
            <EmptyState>
              {questions.length === 0
                ? 'Groups of similar questions will appear here as students ask.'
                : 'The AI is grouping the first questions…'}
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {sortedGroups.map(({ group, items }) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  questions={items}
                  authorOf={authorOf}
                  expanded={expanded.has(group.id)}
                  onToggle={() => toggle(group.id)}
                  now={now}
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="recent-heading" className="lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto">
          <h2 id="recent-heading" className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">
            Recent Questions
          </h2>
          {recent.length === 0 ? (
            <EmptyState>
              {active ? (
                <>
                  Waiting for questions. Students join at <strong>{window.location.host}/join</strong> with code{' '}
                  <strong className="font-mono">{session.code}</strong>.
                </>
              ) : (
                'This session has ended.'
              )}
            </EmptyState>
          ) : (
            <ul className="space-y-2" aria-live="polite">
              {recent.map((q) => (
                <QuestionCard key={q.id} question={q} author={authorOf(q)} state={questionState(q, groupsById, now)} now={now} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="text-2xl leading-tight font-bold text-ink tabular-nums">{value}</dd>
      <dt className="text-xs text-muted">{label}</dt>
    </div>
  )
}

function ConnectionPill({ state, ended }: { state: ConnectionState; ended: boolean }) {
  if (ended) {
    return <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">Session ended</span>
  }
  const live = state === 'live'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
        live ? 'bg-accent-soft text-accent' : 'bg-amber-50 text-amber-700'
      }`}
    >
      <span className={`size-2 rounded-full ${live ? 'bg-accent' : 'animate-pulse bg-amber-500'}`} />
      {live ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
    </span>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center text-sm text-muted">{children}</div>
}

function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="text-center text-muted">{children}</div>
    </main>
  )
}
