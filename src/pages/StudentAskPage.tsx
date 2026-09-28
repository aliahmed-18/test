import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { findSessionByCode, getStoredParticipant, normalizeCode, submitQuestion, UserFacingError } from '../lib/api'
import { readJSON, uuid, writeJSON } from '../lib/storage'
import { supabase } from '../lib/supabase'
import type { Session } from '../lib/types'

const NAME_KEY = 'getit.displayName'
const askedKey = (sessionId: string) => `getit.asked.${sessionId}`
const normalizeText = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

export function StudentAskPage() {
  const code = normalizeCode(useParams().code ?? '')
  const [session, setSession] = useState<Session | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState(() => readJSON<string>(NAME_KEY, ''))
  const [text, setText] = useState('')
  const [requestId, setRequestId] = useState(uuid)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    findSessionByCode(code)
      .then((s) => {
        if (cancelled) return
        setSession(s)
        const stored = getStoredParticipant(s.id)
        if (stored) setName((current) => current || stored.name)
      })
      .catch((err) => !cancelled && setLoadError(err instanceof UserFacingError ? err.message : 'Could not load session.'))
    return () => {
      cancelled = true
    }
  }, [code])

  // Close the form live if the instructor ends the session.
  const sessionId = session?.id
  useEffect(() => {
    if (!sessionId) return
    const channel = supabase
      .channel(`student-session:${sessionId}`)
      .on<Session>(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` },
        (payload) => setSession(payload.new as Session),
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [sessionId])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!session || submitting) return
    setError(null)

    if (!text.trim()) return setError('Please type a question first.')
    if (!name.trim()) return setError('Please enter your name.')
    const asked = readJSON<string[]>(askedKey(session.id), [])
    if (asked.includes(normalizeText(text))) return setError('You already submitted this question.')

    setSubmitting(true)
    try {
      await submitQuestion({ session, displayName: name, text, requestId })
      writeJSON(NAME_KEY, name.trim())
      writeJSON(askedKey(session.id), [...asked, normalizeText(text)])
      setSubmitted(text.trim())
      setText('')
      setRequestId(uuid())
    } catch (err) {
      // Keep the draft and the same requestId so a retry can't create a duplicate.
      setError(err instanceof UserFacingError ? err.message : 'Your question could not be submitted.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-6">
      <header className="flex items-center justify-between">
        <Logo />
        {session && (
          <span className="rounded-md bg-brand-soft px-2.5 py-1 font-mono text-sm font-semibold tracking-widest text-brand">
            {session.code}
          </span>
        )}
      </header>

      {loadError && (
        <div className="card mt-10 p-6">
          <p role="alert" className="text-red-600">
            {loadError}
          </p>
          <Link to="/join" className="btn-secondary mt-4 w-full">
            Try another code
          </Link>
        </div>
      )}

      {!session && !loadError && <p className="mt-10 text-center text-muted">Joining session…</p>}

      {session?.status === 'ended' && (
        <div className="card mt-10 p-6 text-center">
          <h1 className="text-xl font-semibold">This session has ended</h1>
          <p className="mt-2 text-sm text-muted">Thanks for your questions! Ask your instructor for a new code.</p>
          <Link to="/join" className="btn-secondary mt-6 w-full">
            Join another session
          </Link>
        </div>
      )}

      {session?.status === 'active' && submitted && (
        <div className="card mt-8 p-6 text-center" role="status">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-soft text-2xl text-accent">
            ✓
          </div>
          <h1 className="mt-4 text-xl font-semibold">Question submitted</h1>
          <p className="mt-3 rounded-lg bg-canvas px-4 py-3 text-left text-sm text-ink">“{submitted}”</p>
          <p className="mt-3 text-sm text-muted">Your instructor can see it now.</p>
          <button className="btn-primary mt-6 w-full py-3 text-base" onClick={() => setSubmitted(null)}>
            Ask another question
          </button>
        </div>
      )}

      {session?.status === 'active' && !submitted && (
        <form onSubmit={handleSubmit} className="mt-8 flex flex-col" noValidate>
          <label htmlFor="question" className="text-2xl font-semibold">
            What's your question?
          </label>
          <textarea
            id="question"
            className="field mt-4 min-h-36 resize-y leading-relaxed"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setError(null)
            }}
            placeholder="Type your question…"
            maxLength={1000}
            rows={5}
            autoFocus
          />
          <div className="mt-1 text-right text-xs text-muted">{text.length}/1000</div>

          <label htmlFor="name" className="mt-3 text-sm font-medium text-muted">
            Your name
          </label>
          <input
            id="name"
            className="field mt-2"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            placeholder="e.g. Alex"
            maxLength={60}
            autoComplete="given-name"
          />

          {error && (
            <p role="alert" className="mt-4 text-sm text-red-600">
              {error}
            </p>
          )}

          <button type="submit" className="btn-primary mt-6 w-full py-3.5 text-base" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit Question'}
          </button>
        </form>
      )}
    </main>
  )
}
