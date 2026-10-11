/**
 * Overlay integration_secrets onto process.env for Netlify functions.
 * Express registers the TypeScript loader on globalThis first and this
 * module delegates to it. A cold Netlify function uses the fallback.
 * Keep FIELD_PAIRS in step with src/config/integrationKeys.ts.
 * Values are never logged.
 */
import { createClient } from '@supabase/supabase-js';

const GLOBAL_KEY = '__outreachRuntimeSecrets';
const TTL_MS = 15_000;

const FIELD_PAIRS = [
  ['apify_token', 'APIFY_TOKEN'],
  ['apify_token_fallback', 'APIFY_TOKEN_FALLBACK'],
  ['apify_tokens', 'APIFY_TOKENS'],
  ['groq_api_key', 'GROQ_API_KEY'],
  ['llm_model', 'LLM_MODEL'],
  ['llm_base_url', 'LLM_BASE_URL'],
  ['llm_hook_model', 'LLM_HOOK_MODEL'],
  ['resend_api_key', 'RESEND_API_KEY'],
  ['resend_from_email', 'RESEND_FROM_EMAIL'],
  ['resend_from_name', 'RESEND_FROM_NAME'],
  ['resend_reply_to', 'RESEND_REPLY_TO'],
  ['gmail_client_id', 'GMAIL_CLIENT_ID'],
  ['gmail_client_secret', 'GMAIL_CLIENT_SECRET'],
  ['gmail_mailbox', 'GMAIL_MAILBOX'],
  ['discord_webhook_url', 'DISCORD_WEBHOOK_URL'],
  ['slack_webhook_url', 'SLACK_WEBHOOK_URL'],
  ['instantly_api_key', 'INSTANTLY_API_KEY'],
  ['instantly_campaign_id', 'INSTANTLY_CAMPAIGN_ID'],
  ['smartlead_api_key', 'SMARTLEAD_API_KEY'],
  ['smartlead_campaign_id', 'SMARTLEAD_CAMPAIGN_ID'],
  ['webhook_shared_secret', 'WEBHOOK_SHARED_SECRET'],
  ['public_api_url', 'PUBLIC_API_URL'],
  ['admin_base_url', 'ADMIN_BASE_URL'],
  ['app_name', 'APP_NAME'],
  ['app_value_prop', 'APP_VALUE_PROP'],
];

function slot() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      bootCaptured: false,
      boot: {},
      supabaseUrl: '',
      supabaseKey: '',
      cache: null,
      inflight: null,
      ensureTs: null,
    };
  }
  return globalThis[GLOBAL_KEY];
}

function capture(env) {
  const state = slot();
  if (state.bootCaptured) return;
  state.supabaseUrl = String(env.SUPABASE_URL || '').trim();
  state.supabaseKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const boot = {};
  for (const [, name] of FIELD_PAIRS) {
    boot[name] = typeof env[name] === 'string' ? env[name] : undefined;
  }
  state.boot = boot;
  state.bootCaptured = true;
}

function apply(stored, env, boot) {
  for (const [id, name] of FIELD_PAIRS) {
    const value = String(stored[id] || '').trim();
    if (value) {
      env[name] = value;
      continue;
    }
    if (boot[name] === undefined) delete env[name];
    else env[name] = boot[name];
  }
}

async function loadFallback() {
  const state = slot();
  const env = process.env;
  capture(env);
  let stored = state.cache?.stored ?? {};
  if (state.supabaseUrl && state.supabaseKey) {
    try {
      const sb = createClient(state.supabaseUrl, state.supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await sb
        .from('integration_secrets')
        .select('key, value')
        .in(
          'key',
          FIELD_PAIRS.map(([id]) => id),
        );
      if (!error && data) {
        stored = {};
        for (const row of data) {
          if (row?.key) stored[row.key] = String(row.value ?? '');
        }
      }
    } catch {
      /* keep the previous overlay */
    }
  }
  state.cache = { at: Date.now(), stored };
  apply(stored, env, state.boot);
}

export async function ensureRuntimeSecrets(options = {}) {
  const state = slot();
  if (typeof state.ensureTs === 'function') return state.ensureTs(options);
  const now = Date.now();
  if (!options.force && state.cache && now - state.cache.at < TTL_MS) return;
  if (state.inflight) {
    await state.inflight;
    if (!options.force && state.cache && now - state.cache.at < TTL_MS) return;
  }
  const run = loadFallback().finally(() => {
    if (state.inflight === run) state.inflight = null;
  });
  state.inflight = run;
  await run;
}

export function invalidateRuntimeSecrets() {
  const state = slot();
  state.cache = null;
  state.inflight = null;
}
