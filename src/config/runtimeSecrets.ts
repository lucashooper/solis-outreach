/**
 * Server-side API keys.
 * Saved rows in integration_secrets win. Empty rows fall back to the
 * environment captured at boot, so an env-based deploy keeps working.
 * Values are never logged or returned in full.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { INTEGRATION_FIELDS, integrationField, type IntegrationField } from './integrationKeys.js';
import { isDiscordWebhook } from '../pipeline/discordNotify.js';

export const RUNTIME_SECRETS_TTL_MS = 15_000;

const GLOBAL_KEY = '__outreachRuntimeSecrets';

export interface PublicIntegrationField {
  id: string;
  env: string;
  label: string;
  hint: string;
  group: IntegrationField['group'];
  secret: boolean;
  testable: boolean;
  set: boolean;
  source: 'settings' | 'env' | null;
  display: string;
  detail: string;
}

interface SecretRow {
  key?: string;
  value?: string;
}

interface SecretsQuery {
  from(table: string): {
    select(columns: string): {
      in(
        column: string,
        values: string[],
      ): Promise<{ data: SecretRow[] | null; error: { message?: string } | null }>;
    };
    upsert(
      row: { key: string; value: string; updated_at: string },
      options?: { onConflict?: string },
    ): Promise<{ error: { message?: string } | null }>;
    delete(): {
      eq(column: string, value: string): Promise<{ error: { message?: string } | null }>;
    };
  };
  auth: {
    getUser(jwt: string): Promise<{
      data: { user: { id?: string } | null };
      error: { message?: string } | null;
    }>;
  };
}

interface Slot {
  bootCaptured: boolean;
  boot: Record<string, string | undefined>;
  supabaseUrl: string;
  supabaseKey: string;
  cache: { at: number; stored: Record<string, string> } | null;
  inflight: Promise<void> | null;
  ensureTs: ((options?: EnsureOptions) => Promise<void>) | null;
}

export interface EnsureOptions {
  force?: boolean;
  client?: SecretsQuery | null;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

function slot(): Slot {
  const root = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Slot };
  if (!root[GLOBAL_KEY]) {
    root[GLOBAL_KEY] = {
      bootCaptured: false,
      boot: {},
      supabaseUrl: '',
      supabaseKey: '',
      cache: null,
      inflight: null,
      ensureTs: null,
    };
  }
  return root[GLOBAL_KEY];
}

function readRaw(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

/** Remember the process environment before any settings overlay. */
export function captureBootEnv(env: NodeJS.ProcessEnv = process.env): void {
  const state = slot();
  if (state.bootCaptured) return;
  state.supabaseUrl = (readRaw(env, 'SUPABASE_URL') ?? '').trim();
  state.supabaseKey = (readRaw(env, 'SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  const boot: Record<string, string | undefined> = {};
  for (const field of INTEGRATION_FIELDS) {
    boot[field.env] = readRaw(env, field.env);
  }
  state.boot = boot;
  state.bootCaptured = true;
}

export function invalidateRuntimeSecrets(): void {
  const state = slot();
  state.cache = null;
  state.inflight = null;
}

export function resetRuntimeSecretsForTests(): void {
  const state = slot();
  state.bootCaptured = false;
  state.boot = {};
  state.supabaseUrl = '';
  state.supabaseKey = '';
  state.cache = null;
  state.inflight = null;
}

export function primeRuntimeSecretsForTests(input: {
  boot?: Record<string, string | undefined>;
  stored?: Record<string, string>;
}): void {
  const state = slot();
  state.bootCaptured = true;
  state.boot = { ...(input.boot ?? {}) };
  state.cache = { at: Date.now(), stored: { ...(input.stored ?? {}) } };
  state.inflight = null;
}

/** `set ••••1234` — last four characters only. */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return `set ••••${trimmed.slice(-4)}`;
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    out = out.split(trimmed).join('[redacted]');
  }
  return out;
}

export function applyStoredToEnv(
  stored: Record<string, string>,
  env: NodeJS.ProcessEnv,
  boot: Record<string, string | undefined>,
): void {
  for (const field of INTEGRATION_FIELDS) {
    const value = (stored[field.id] ?? '').trim();
    if (value) {
      env[field.env] = value;
      continue;
    }
    const original = boot[field.env];
    if (original === undefined) delete env[field.env];
    else env[field.env] = original;
  }
}

function resolvedValue(
  field: IntegrationField,
  stored: Record<string, string>,
  boot: Record<string, string | undefined>,
): { value: string; source: 'settings' | 'env' | null } {
  const saved = (stored[field.id] ?? '').trim();
  if (saved) return { value: saved, source: 'settings' };
  const fromEnv = (boot[field.env] ?? '').trim();
  if (fromEnv) return { value: fromEnv, source: 'env' };
  return { value: '', source: null };
}

export function buildPublicFields(): PublicIntegrationField[] {
  const state = slot();
  const stored = state.cache?.stored ?? {};
  return INTEGRATION_FIELDS.map((field) => {
    const { value, source } = resolvedValue(field, stored, state.boot);
    let detail = '';
    if (field.id === 'apify_tokens' && value) {
      const count = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean).length;
      detail = count === 1 ? '1 account' : `${count} accounts`;
    }
    return {
      id: field.id,
      env: field.env,
      label: field.label,
      hint: field.hint,
      group: field.group,
      secret: field.secret,
      testable: Boolean(field.test),
      set: Boolean(value),
      source,
      display: !value ? '' : field.secret ? maskSecret(value) : value,
      detail,
    };
  });
}

function serviceClient(): SecretsQuery | null {
  const state = slot();
  if (!state.supabaseUrl || !state.supabaseKey) return null;
  return createClient(state.supabaseUrl, state.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SecretsQuery;
}

async function readStored(client: SecretsQuery): Promise<Record<string, string>> {
  const ids = INTEGRATION_FIELDS.map((field) => field.id);
  const { data, error } = await client.from('integration_secrets').select('key, value').in('key', ids);
  if (error) {
    console.warn('[settings] API keys could not be read. Using the environment.');
    return slot().cache?.stored ?? {};
  }
  const stored: Record<string, string> = {};
  for (const row of data ?? []) {
    if (!row.key) continue;
    stored[row.key] = String(row.value ?? '');
  }
  return stored;
}

async function load(options: EnsureOptions): Promise<void> {
  const state = slot();
  const env = options.env ?? process.env;
  captureBootEnv(env);
  const client = options.client === undefined ? serviceClient() : options.client;
  let stored = state.cache?.stored ?? {};
  if (client) {
    try {
      stored = await readStored(client);
    } catch {
      console.warn('[settings] API keys could not be read. Using the environment.');
    }
  }
  state.cache = { at: options.now ?? Date.now(), stored };
  applyStoredToEnv(stored, env, state.boot);
}

/**
 * Refresh saved keys when the cache is older than the TTL.
 * Safe to call often. Failures leave the previous overlay in place.
 */
export async function ensureRuntimeSecrets(options: EnsureOptions = {}): Promise<void> {
  const state = slot();
  const now = options.now ?? Date.now();
  if (!options.force && state.cache && now - state.cache.at < RUNTIME_SECRETS_TTL_MS) return;
  if (state.inflight) {
    await state.inflight;
    if (!options.force && state.cache && now - state.cache.at < RUNTIME_SECRETS_TTL_MS) return;
  }
  const run = load(options).finally(() => {
    if (state.inflight === run) state.inflight = null;
  });
  state.inflight = run;
  await run;
}

slot().ensureTs = ensureRuntimeSecrets;

export function currentSecret(id: string, draft?: string | null): string {
  const field = integrationField(id);
  if (!field) return '';
  const trimmed = draft?.trim() ?? '';
  if (draft !== undefined && draft !== null && trimmed) return trimmed;
  const state = slot();
  return resolvedValue(field, state.cache?.stored ?? {}, state.boot).value;
}

function validateField(field: IntegrationField, value: string): string | null {
  if (value.length > 8000) return 'That value is too long.';
  if (!value) return null;
  if (field.id === 'discord_webhook_url' && !isDiscordWebhook(value)) {
    return 'Paste a Discord webhook URL.';
  }
  if (field.id === 'slack_webhook_url') {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'hooks.slack.com') {
        return 'Paste a Slack incoming webhook URL.';
      }
    } catch {
      return 'Paste a Slack incoming webhook URL.';
    }
  }
  return null;
}

export async function saveIntegrationField(
  client: SecretsQuery,
  id: string,
  value: string | null,
): Promise<void> {
  const field = integrationField(id);
  if (!field) throw new Error('Unknown setting.');
  const next = (value ?? '').trim();
  const invalid = validateField(field, next);
  if (invalid) throw new Error(invalid);
  if (!next) {
    const { error } = await client.from('integration_secrets').delete().eq('key', id);
    if (error) throw new Error('Could not clear that setting.');
  } else {
    const { error } = await client.from('integration_secrets').upsert(
      { key: id, value: next, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) throw new Error('Could not save that setting.');
  }
  invalidateRuntimeSecrets();
  await ensureRuntimeSecrets({ force: true, client });
}

export async function requireSignedInUser(
  client: SecretsQuery,
  authorization: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const header = String(authorization ?? '').trim();
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!bearer) return { ok: false, error: 'Sign in to manage API keys.' };
  try {
    const { data, error } = await client.auth.getUser(bearer);
    if (error || !data?.user?.id) return { ok: false, error: 'Sign in to manage API keys.' };
    return { ok: true, userId: data.user.id };
  } catch {
    return { ok: false, error: 'Sign in to manage API keys.' };
  }
}

export type KeyTestResult = { ok: boolean; message: string };

async function probe(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(12_000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

function statusMessage(
  ok: boolean,
  status: number,
  success: string,
  failure: string,
  offline: string,
): KeyTestResult {
  if (ok) return { ok: true, message: success };
  if (!status) return { ok: false, message: offline };
  return { ok: false, message: `${failure} (HTTP ${status}).` };
}

async function testApify(tokens: string[], fetchImpl: typeof fetch): Promise<KeyTestResult> {
  const unique = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
  if (!unique.length) return { ok: false, message: 'Save an Apify token first.' };
  let passed = 0;
  let lastStatus = 0;
  for (const token of unique) {
    const url = `https://api.apify.com/v2/users/me/limits?token=${encodeURIComponent(token)}`;
    const result = await probe(fetchImpl, url, { method: 'GET' });
    if (result.ok) passed += 1;
    else lastStatus = result.status;
  }
  if (passed === unique.length) {
    const noun = unique.length === 1 ? 'account' : 'accounts';
    return { ok: true, message: `Apify accepted ${unique.length} ${noun}.` };
  }
  const failed = unique.length - passed;
  const suffix = lastStatus ? ` (HTTP ${lastStatus})` : '';
  return {
    ok: false,
    message: `Apify rejected ${failed} of ${unique.length}${suffix}.`,
  };
}

async function testGmail(clientId: string, clientSecret: string, fetchImpl: typeof fetch): Promise<KeyTestResult> {
  if (!clientId || !clientSecret) {
    return { ok: false, message: 'Gmail needs both a client ID and a client secret.' };
  }
  const body = new URLSearchParams({
    code: 'settings-test',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: 'http://localhost/api/gmail/oauth/callback',
    grant_type: 'authorization_code',
  });
  let errorCode = '';
  let status = 0;
  try {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    status = res.status;
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    errorCode = String(parsed.error ?? '');
  } catch {
    return { ok: false, message: 'Could not reach Google.' };
  }
  if (errorCode === 'invalid_client' || errorCode === 'unauthorized_client') {
    return { ok: false, message: 'Google rejected the OAuth client.' };
  }
  if (
    status === 200 ||
    errorCode === 'invalid_grant' ||
    errorCode === 'redirect_uri_mismatch' ||
    errorCode === 'invalid_request'
  ) {
    return { ok: true, message: 'Google accepted the OAuth client.' };
  }
  return { ok: false, message: status ? `Google rejected the OAuth client (HTTP ${status}).` : 'Google rejected the OAuth client.' };
}

/**
 * Check one saved key. A draft is used only for this request and is not stored.
 * The result never includes the secret.
 */
export async function runIntegrationTest(input: {
  id: string;
  draft?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<KeyTestResult> {
  const field = integrationField(input.id);
  if (!field?.test) return { ok: false, message: 'That setting has no connection test.' };
  const fetchImpl = input.fetchImpl ?? fetch;
  const draft = input.draft?.trim() ?? '';
  const value = currentSecret(field.id, draft || null);
  if (!value) return { ok: false, message: 'Save a value, or set the environment variable, first.' };

  if (field.test === 'apify') {
    const tokens =
      field.id === 'apify_tokens' ? value.split(',') : [value];
    return testApify(tokens, fetchImpl);
  }

  if (field.test === 'groq') {
    const base = (currentSecret('llm_base_url') || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    const result = await probe(fetchImpl, `${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${value}` },
    });
    return statusMessage(
      result.ok,
      result.status,
      'Groq accepted the key.',
      'Groq rejected the key',
      'Could not reach Groq.',
    );
  }

  if (field.test === 'resend') {
    const result = await probe(fetchImpl, 'https://api.resend.com/domains', {
      method: 'GET',
      headers: { Authorization: `Bearer ${value}` },
    });
    return statusMessage(
      result.ok,
      result.status,
      'Resend accepted the key.',
      'Resend rejected the key',
      'Could not reach Resend.',
    );
  }

  if (field.test === 'gmail') {
    const clientId = field.id === 'gmail_client_id' ? value : currentSecret('gmail_client_id');
    const clientSecret = field.id === 'gmail_client_secret' ? value : currentSecret('gmail_client_secret');
    return testGmail(clientId, clientSecret, fetchImpl);
  }

  if (field.test === 'discord') {
    if (!isDiscordWebhook(value)) return { ok: false, message: 'Paste a Discord webhook URL.' };
    const result = await probe(fetchImpl, value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'API keys test from Settings.' }),
    });
    return statusMessage(
      result.ok,
      result.status,
      'Discord accepted the webhook.',
      'Discord rejected the webhook',
      'Could not reach Discord.',
    );
  }

  if (field.test === 'slack') {
    const result = await probe(fetchImpl, value, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'API keys test from Settings.' }),
    });
    return statusMessage(
      result.ok,
      result.status,
      'Slack accepted the webhook.',
      'Slack rejected the webhook',
      'Could not reach Slack.',
    );
  }

  if (field.test === 'instantly') {
    const result = await probe(fetchImpl, 'https://api.instantly.ai/api/v2/campaigns?limit=1', {
      method: 'GET',
      headers: { Authorization: `Bearer ${value}` },
    });
    return statusMessage(
      result.ok,
      result.status,
      'Instantly accepted the key.',
      'Instantly rejected the key',
      'Could not reach Instantly.',
    );
  }

  const result = await probe(
    fetchImpl,
    `https://server.smartlead.ai/api/v1/campaigns?api_key=${encodeURIComponent(value)}`,
    { method: 'GET' },
  );
  return statusMessage(
    result.ok,
    result.status,
    'Smartlead accepted the key.',
    'Smartlead rejected the key',
    'Could not reach Smartlead.',
  );
}

export function clientFromSupabase(client: SupabaseClient | null): SecretsQuery | null {
  return client as unknown as SecretsQuery | null;
}

export type { SecretsQuery };
