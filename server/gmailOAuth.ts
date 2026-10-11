import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { allowedAdminOrigin } from '../src/adminOrigins.js';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SECRET_KEY = 'gmail_refresh_token';
const MAILBOX = 'studioowner@gmail.com';

const pending = new Map<string, { expires: number; returnOrigin: string }>();

export function gmailMailbox(): string {
  return (
    process.env.GMAIL_MAILBOX?.trim() ||
    process.env.RESEND_REPLY_TO?.trim() ||
    MAILBOX
  );
}

export function publicApiBase(fallbackHost: string): string {
  const explicit = process.env.PUBLIC_API_URL?.trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (domain) return `https://${domain}`;
  return fallbackHost.replace(/\/$/, '');
}

export function gmailRedirectUri(base: string): string {
  return `${base}/api/gmail/oauth/callback`;
}

const LAST_SYNC_KEY = 'gmail_last_synced_at';

async function readSecret(sb: SupabaseClient, key: string): Promise<string> {
  const { data, error } = await sb
    .from('integration_secrets')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error || !data?.value) return '';
  return String(data.value).trim();
}

export async function readStoredRefreshToken(sb: SupabaseClient): Promise<string> {
  return readSecret(sb, SECRET_KEY);
}

export async function gmailConnectionStatus(sb: SupabaseClient | null): Promise<{
  configured: boolean;
  email: string;
  missing: string[];
  lastSynced: string | null;
}> {
  const missing: string[] = [];
  if (!process.env.GMAIL_CLIENT_ID?.trim()) missing.push('GMAIL_CLIENT_ID');
  if (!process.env.GMAIL_CLIENT_SECRET?.trim()) missing.push('GMAIL_CLIENT_SECRET');
  const envToken = process.env.GMAIL_REFRESH_TOKEN?.trim() ?? '';
  const stored = !envToken && sb ? await readStoredRefreshToken(sb) : '';
  if (!envToken && !stored) missing.push('GMAIL_REFRESH_TOKEN');
  const raw = sb ? await readSecret(sb, LAST_SYNC_KEY) : '';
  const lastSynced = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : null;
  return {
    configured: missing.length === 0,
    email: MAILBOX,
    missing,
    lastSynced,
  };
}

export function gmailReturnOrigin(state: string): string {
  const encoded = state.split('.')[1] || '';
  if (!encoded) return '';
  try {
    return allowedAdminOrigin(Buffer.from(encoded, 'base64url').toString('utf8')) || '';
  } catch {
    return '';
  }
}

export function beginGmailOAuth(
  base: string,
  returnTo?: string | null,
): { url: string } | { error: string } {
  const clientId = process.env.GMAIL_CLIENT_ID?.trim();
  if (!clientId || !process.env.GMAIL_CLIENT_SECRET?.trim()) {
    return {
      error:
        'Add the Gmail client ID and secret under Settings → API keys before Connect can start.',
    };
  }
  const returnOrigin = allowedAdminOrigin(returnTo) || '';
  const nonce = randomBytes(24).toString('hex');
  const state = returnOrigin
    ? `${nonce}.${Buffer.from(returnOrigin).toString('base64url')}`
    : nonce;
  pending.set(nonce, {
    expires: Date.now() + 10 * 60 * 1000,
    returnOrigin,
  });
  const url = new URL(AUTH);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', gmailRedirectUri(base));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('login_hint', MAILBOX);
  url.searchParams.set('state', state);
  return { url: url.toString() };
}

export async function finishGmailOAuth(
  sb: SupabaseClient,
  base: string,
  code: string,
  state: string,
): Promise<{ returnOrigin: string }> {
  const nonce = state.split('.')[0] || state;
  const row = pending.get(nonce);
  pending.delete(nonce);
  if (!row || row.expires < Date.now()) {
    throw new Error('That Gmail connection expired. Start again from Connectors.');
  }
  const body = new URLSearchParams({
    code,
    client_id: String(process.env.GMAIL_CLIENT_ID).trim(),
    client_secret: String(process.env.GMAIL_CLIENT_SECRET).trim(),
    redirect_uri: gmailRedirectUri(base),
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const parsed = (await res.json().catch(() => ({}))) as {
    refresh_token?: string;
    error?: string;
  };
  if (!res.ok || !parsed.refresh_token) {
    throw new Error(
      parsed.error
        ? `Google did not return a refresh token (${parsed.error}).`
        : 'Google did not return a refresh token. Remove the app’s access and connect again.',
    );
  }
  const { error } = await sb.from('integration_secrets').upsert({
    key: SECRET_KEY,
    value: parsed.refresh_token,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return { returnOrigin: row.returnOrigin || gmailReturnOrigin(state) };
}
