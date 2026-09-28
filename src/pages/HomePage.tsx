import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { createSession, UserFacingError } from '../lib/api'

export function HomePage() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    setCreating(true)
    setError(null)
    try {
      const { code } = await createSession()
      navigate(`/host/${code}`)
    } catch (err) {
      setError(err instanceof UserFacingError ? err.message : 'Could not create a session.')
      setCreating(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <Logo size="lg" />
        <p className="mt-2 text-lg font-medium text-muted">Questions Box</p>
        <p className="mx-auto mt-6 max-w-sm text-sm leading-relaxed text-muted">
          Collect questions from your class in real time. AI groups similar questions so you can see what everyone is
          wondering about.
        </p>

        <div className="card mt-10 p-6 text-left">
          <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">Instructor</h2>
          <button className="btn-primary mt-4 w-full py-3 text-base" onClick={handleCreate} disabled={creating}>
            {creating ? 'Creating session…' : 'Create Live Session'}
          </button>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {error}
            </p>
          )}
        </div>

        <p className="mt-6 text-sm text-muted">
          Student?{' '}
          <Link to="/join" className="font-semibold text-brand hover:underline">
            Join a session
          </Link>
        </p>
      </div>
    </main>
  )
}
