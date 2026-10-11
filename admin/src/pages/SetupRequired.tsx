/**
 * Shown when the admin was built without Supabase env.
 * Those three values stay in the environment — they are how the server boots.
 */
export function SetupRequired() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg space-y-6">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-faint">
            First run
          </p>
          <h1 className="mt-2 text-2xl font-medium tracking-tight text-ink">
            Connect Supabase to start
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            The project URL, anon key, and service role key stay in environment files.
            They are required before sign-in. They are not stored under API keys, and the
            service role key must never be added to the admin build.
          </p>
        </div>
        <ol className="panel list-decimal space-y-3 p-6 pl-10 text-sm leading-relaxed text-ink-muted">
          <li>Create a Supabase project.</li>
          <li>
            Apply the migrations with{' '}
            <code className="font-mono text-xs text-ink">npm run setup:db</code> (see the
            README).
          </li>
          <li>
            Copy <code className="font-mono text-xs text-ink">.env.example</code> to{' '}
            <code className="font-mono text-xs text-ink">.env</code> and set{' '}
            <code className="font-mono text-xs text-ink">SUPABASE_URL</code>,{' '}
            <code className="font-mono text-xs text-ink">SUPABASE_ANON_KEY</code>, and{' '}
            <code className="font-mono text-xs text-ink">SUPABASE_SERVICE_ROLE_KEY</code>.
          </li>
          <li>
            Copy <code className="font-mono text-xs text-ink">admin/.env.example</code> to{' '}
            <code className="font-mono text-xs text-ink">admin/.env</code> and set{' '}
            <code className="font-mono text-xs text-ink">VITE_SUPABASE_URL</code> and{' '}
            <code className="font-mono text-xs text-ink">VITE_SUPABASE_ANON_KEY</code>.
          </li>
          <li>
            Restart <code className="font-mono text-xs text-ink">npm run dev</code>. Create a
            user under Authentication in Supabase, sign in, then add Apify, Groq, Resend, and
            Gmail under Settings → API keys.
          </li>
        </ol>
      </div>
    </div>
  );
}
