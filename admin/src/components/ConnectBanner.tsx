import { Link } from 'react-router-dom';
import { hasViteSupabaseEnv } from '../lib/settings';

/**
 * Soften / hide when Vite env already has Supabase keys (even before Settings save).
 */
export function ConnectBanner() {
  if (hasViteSupabaseEnv()) return null;

  return (
    <div className="card border-amber-500/30 bg-amber-500/5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-amber-200">
            Connect Supabase
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Run{' '}
            <code className="rounded bg-surface px-1 text-xs text-slate-300">
              npm run sync:admin-env
            </code>{' '}
            then restart{' '}
            <code className="rounded bg-surface px-1 text-xs text-slate-300">
              npm run dev
            </code>
            , or paste credentials in Settings /{' '}
            <code className="rounded bg-surface px-1 text-xs text-slate-300">
              admin/.env
            </code>
            .
          </p>
        </div>
        <Link to="/settings" className="btn-primary shrink-0">
          Open Settings
        </Link>
      </div>
    </div>
  );
}
