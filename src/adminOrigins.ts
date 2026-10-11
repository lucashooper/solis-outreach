/** Browser origins that may call the API and receive an OAuth return. */
export const ADMIN_ORIGINS = [
  'https://admin.example.com',
  'https://your-admin.example.com',
  'https://your-admin-alias.example.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

export const DEFAULT_ADMIN_ORIGIN = 'https://admin.example.com';

function configuredAdminOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const origins = new Set<string>(ADMIN_ORIGINS);
  const extras = [env.ADMIN_BASE_URL, ...String(env.CORS_ORIGINS ?? '').split(',')];
  for (const raw of extras) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      /* ignore values that are not URLs */
    }
  }
  return origins;
}

/** Origin only, and only when it is one of the admin hosts (or CORS / admin base). */
export function allowedAdminOrigin(
  value: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return configuredAdminOrigins(env).has(origin) ? origin : null;
  } catch {
    return null;
  }
}
