/**
 * Resolve the browser's Express API base.
 *
 * A production build must not collapse to "" when Vite baked an empty
 * VITE_EXPRESS_API_URL. Discovery, Gmail sync, and Approve & Pitch all
 * need a public host. Order:
 *   1. Non-empty public Vite URL (VITE_EXPRESS_API_URL, then VITE_API_BASE_URL)
 *   2. Settings / localStorage apiBaseUrl when that is a public https URL
 *   3. Production last resort: the Railway Express host
 * Local dev keeps an explicit URL, then http://localhost:3001.
 *
 * This stays a real function of its inputs so a bundler cannot fold
 * `(viteUrl, storedUrl, "")` into an empty string.
 */

export const PRODUCTION_EXPRESS_URL =
  'https://api.example.com';

export const LOCAL_EXPRESS_URL = 'http://localhost:3001';

export function cleanApiBase(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\/$/, '');
}

/** True for a public https origin. Localhost and blank values are not. */
export function isPublicHttpsApi(value: string | null | undefined): boolean {
  const raw = cleanApiBase(value);
  if (!raw) return false;
  if (/localhost|127\.0\.0\.1/i.test(raw)) return false;
  return /^https:\/\//i.test(raw);
}

export function resolveExpressApiUrl(input: {
  viteExpress?: string | null;
  viteApiBase?: string | null;
  storedApiBase?: string | null;
  production: boolean;
}): string {
  const fromVite = cleanApiBase(input.viteExpress) || cleanApiBase(input.viteApiBase);
  const stored = cleanApiBase(input.storedApiBase);

  if (input.production) {
    if (isPublicHttpsApi(fromVite)) return fromVite;
    if (isPublicHttpsApi(stored)) return stored;
    return PRODUCTION_EXPRESS_URL;
  }

  return fromVite || stored || LOCAL_EXPRESS_URL;
}
