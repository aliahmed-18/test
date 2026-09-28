import { Logo } from './Logo'

export function SetupNotice() {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <Logo />
      <div className="card mt-6 p-6">
        <h1 className="text-lg font-semibold">Supabase is not configured</h1>
        <p className="mt-2 text-sm text-muted">
          Copy <code className="rounded bg-brand-soft px-1">.env.example</code> to{' '}
          <code className="rounded bg-brand-soft px-1">.env</code> and set <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code>, then restart the dev server. See the README for the full setup.
        </p>
      </div>
    </main>
  )
}
