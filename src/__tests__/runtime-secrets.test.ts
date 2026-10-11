import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_FIELDS } from '../config/integrationKeys.js';
import {
  applyStoredToEnv,
  buildPublicFields,
  ensureRuntimeSecrets,
  invalidateRuntimeSecrets,
  maskSecret,
  primeRuntimeSecretsForTests,
  requireSignedInUser,
  resetRuntimeSecretsForTests,
  RUNTIME_SECRETS_TTL_MS,
  runIntegrationTest,
  scrubSecrets,
  type SecretsQuery,
} from '../config/runtimeSecrets.js';
import { handleApiKeysGet, handleApiKeysPut } from '../config/apiKeyHandlers.js';

const SECRET = 'super-secret-value-9999';

function memoryClient(rows: Record<string, string>, calls: { n: number }): SecretsQuery {
  return {
    from() {
      return {
        select() {
          return {
            in() {
              calls.n += 1;
              return Promise.resolve({
                data: Object.entries(rows).map(([key, value]) => ({ key, value })),
                error: null,
              });
            },
          };
        },
        upsert() {
          return Promise.resolve({ error: null });
        },
        delete() {
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    auth: {
      getUser: async (jwt: string) =>
        jwt === 'good-session'
          ? { data: { user: { id: 'admin-1' } }, error: null }
          : { data: { user: null }, error: { message: 'bad' } },
    },
  };
}

describe('API key settings', () => {
  const previous: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetRuntimeSecretsForTests();
    for (const field of INTEGRATION_FIELDS) {
      previous[field.env] = process.env[field.env];
    }
  });

  afterEach(() => {
    for (const field of INTEGRATION_FIELDS) {
      const value = previous[field.env];
      if (value === undefined) delete process.env[field.env];
      else process.env[field.env] = value;
    }
    resetRuntimeSecretsForTests();
  });

  it('masks the last four characters and scrubs secrets out of text', () => {
    expect(maskSecret(SECRET)).toBe('set ••••9999');
    expect(maskSecret('')).toBe('');
    expect(scrubSecrets(`failed ${SECRET} again`, [SECRET])).toBe('failed [redacted] again');
  });

  it('prefers a saved value and restores the boot environment when cleared', () => {
    const boot = { APIFY_TOKEN: 'env-token-aaaa1111' };
    const env = { APIFY_TOKEN: 'env-token-aaaa1111' } as NodeJS.ProcessEnv;
    applyStoredToEnv({ apify_token: 'saved-token-bbbb2222' }, env, boot);
    expect(env.APIFY_TOKEN).toBe('saved-token-bbbb2222');
    applyStoredToEnv({}, env, boot);
    expect(env.APIFY_TOKEN).toBe('env-token-aaaa1111');
    const fresh = { GROQ_API_KEY: 'temp-key' } as NodeJS.ProcessEnv;
    applyStoredToEnv({}, fresh, {});
    expect(fresh.GROQ_API_KEY).toBeUndefined();
  });

  it('does not return a full secret from the public field list', () => {
    primeRuntimeSecretsForTests({
      boot: { RESEND_FROM_EMAIL: 'ada@example.com' },
      stored: { groq_api_key: SECRET },
    });
    const fields = buildPublicFields();
    const json = JSON.stringify(fields);
    expect(json.includes(SECRET)).toBe(false);
    const groq = fields.find((field) => field.id === 'groq_api_key');
    expect(groq?.display).toBe('set ••••9999');
    expect(groq?.source).toBe('settings');
    const from = fields.find((field) => field.id === 'resend_from_email');
    expect(from?.display).toBe('ada@example.com');
    expect(from?.source).toBe('env');
    expect(Object.prototype.hasOwnProperty.call(groq, 'value')).toBe(false);
  });

  it('caches the settings read and invalidates on demand', async () => {
    const calls = { n: 0 };
    const client = memoryClient({ groq_api_key: SECRET }, calls);
    const env = {} as NodeJS.ProcessEnv;
    await ensureRuntimeSecrets({ client, env, force: true, now: 1_000 });
    await ensureRuntimeSecrets({ client, env, now: 2_000 });
    expect(calls.n).toBe(1);
    expect(env.GROQ_API_KEY).toBe(SECRET);
    await ensureRuntimeSecrets({
      client,
      env,
      now: 1_000 + RUNTIME_SECRETS_TTL_MS + 1,
    });
    expect(calls.n).toBe(2);
    invalidateRuntimeSecrets();
    await ensureRuntimeSecrets({ client, env, now: 5_000 });
    expect(calls.n).toBe(3);
  });

  it('requires a signed-in admin and ignores a shared secret', async () => {
    const client = memoryClient({}, { n: 0 });
    const ok = await requireSignedInUser(client, 'Bearer good-session');
    expect(ok.ok).toBe(true);
    expect(await requireSignedInUser(client, 'Bearer shared-webhook-secret')).toEqual({
      ok: false,
      error: 'Sign in to manage API keys.',
    });
    expect((await requireSignedInUser(client, undefined)).ok).toBe(false);
  });

  it('refuses anonymous reads and does not echo a saved secret', async () => {
    const client = memoryClient({ apify_token: SECRET }, { n: 0 });
    const denied = await handleApiKeysGet(client, undefined, 'http://localhost:3001/api/gmail/oauth/callback');
    expect(denied.status).toBe(401);
    const allowed = await handleApiKeysGet(
      client,
      'Bearer good-session',
      'http://localhost:3001/api/gmail/oauth/callback',
    );
    expect(allowed.status).toBe(200);
    expect(JSON.stringify(allowed.body).includes(SECRET)).toBe(false);
    const saved = await handleApiKeysPut(client, 'Bearer good-session', {
      id: 'llm_model',
      value: 'openai/gpt-oss-20b',
    });
    expect(saved.status).toBe(200);
  });

  it('reports provider tests without the secret', async () => {
    primeRuntimeSecretsForTests({ stored: { apify_token: SECRET, groq_api_key: SECRET } });
    const apify = await runIntegrationTest({
      id: 'apify_token',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    expect(apify).toEqual({ ok: true, message: 'Apify accepted 1 account.' });
    const groq = await runIntegrationTest({
      id: 'groq_api_key',
      fetchImpl: async () => {
        throw new Error(`network ${SECRET}`);
      },
    });
    expect(groq.ok).toBe(false);
    expect(groq.message.includes(SECRET)).toBe(false);
    expect(groq.message).toBe('Could not reach Groq.');
  });

  it('treats invalid_grant as a Gmail client that Google recognised', async () => {
    primeRuntimeSecretsForTests({
      stored: { gmail_client_id: 'client-id-value', gmail_client_secret: SECRET },
    });
    const ok = await runIntegrationTest({
      id: 'gmail_client_id',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    });
    expect(ok.ok).toBe(true);
    const bad = await runIntegrationTest({
      id: 'gmail_client_secret',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
    });
    expect(bad.ok).toBe(false);
    expect(bad.message.includes(SECRET)).toBe(false);
  });

  it('keeps the Netlify loader in step with every settings field', () => {
    const src = readFileSync(new URL('../../netlify/lib/runtimeSecrets.mjs', import.meta.url), 'utf8');
    for (const field of INTEGRATION_FIELDS) {
      expect(src).toContain(`'${field.id}'`);
      expect(src).toContain(`'${field.env}'`);
    }
  });
});
