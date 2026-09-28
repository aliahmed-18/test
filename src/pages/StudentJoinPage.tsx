import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { findSessionByCode, normalizeCode, UserFacingError } from '../lib/api'

export function StudentJoinPage() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setChecking(true)
    setError(null)
    try {
      const session = await findSessionByCode(code)
      if (session.status === 'ended') {
        setError('This session has ended. Ask your instructor for a new code.')
        setChecking(false)
        return
      }
      navigate(`/join/${session.code}`)
    } catch (err) {
      setError(err instanceof UserFacingError ? err.message : 'Could not join that session.')
      setChecking(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-8">
      <header className="text-center">
        <Logo />
      </header>
      <form onSubmit={handleSubmit} className="card mt-10 p-6" noValidate>
        <h1 className="text-2xl font-semibold">Join a Session</h1>
        <label htmlFor="code" className="mt-6 block text-sm font-medium text-muted">
          Enter session code
        </label>
        <input
          id="code"
          className="field mt-2 text-center font-mono text-2xl tracking-[0.3em] uppercase"
          value={code}
          onChange={(e) => setCode(normalizeCode(e.target.value))}
          placeholder="ABC123"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          maxLength={6}
          autoFocus
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
        <button type="submit" className="btn-primary mt-6 w-full py-3 text-base" disabled={checking || code.length !== 6}>
          {checking ? 'Checking…' : 'Join Session'}
        </button>
      </form>
    </main>
  )
}
