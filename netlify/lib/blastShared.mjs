/**
 * Shared helpers for Netlify blast functions (service role + Resend).
 * Kept as plain ESM so Netlify can bundle without the monorepo TS pipeline.
 */
import { createClient } from '@supabase/supabase-js';
import { renderTemplate } from './templateTokens.mjs';
import { ensureRuntimeSecrets } from './runtimeSecrets.mjs';

/** Blast display override — keep RESEND_FROM_EMAIL in env but show this for blasts. */
export const BLAST_FROM = 'Alex from Example <outreach@example.com>';
export const BLAST_REPLY_TO = 'studioowner@gmail.com';
const LEGACY_ADDRESS = 'outreach@example.com';

export function resolveBlastFrom(env = process.env, explicit) {
  const direct = String(explicit || '').trim();
  if (direct && direct !== LEGACY_ADDRESS && direct !== BLAST_FROM) return direct;
  const from = String(env.RESEND_FROM_EMAIL || '').trim();
  if (from && from !== LEGACY_ADDRESS && from !== BLAST_FROM) {
    const name = String(env.RESEND_FROM_NAME || '').trim();
    if (name && !from.includes('<')) return `${name} <${from}>`;
    return from;
  }
  return BLAST_FROM;
}

export function resolveBlastReplyTo(env = process.env, explicit) {
  const direct = String(explicit || '').trim();
  if (direct) return direct;
  return String(env.RESEND_REPLY_TO || '').trim() || BLAST_REPLY_TO;
}

export function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Any admin origin, including https://admin.example.com and the Netlify aliases.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

export function handleOptions() {
  return json(204, {});
}

export function getCampaignId(event) {
  const q = event.queryStringParameters?.campaignId;
  if (q) return String(q).trim();

  const path = String(event.path || '');
  // /.netlify/functions/blast-sends/<uuid>  OR  /api/blasts/<uuid>/sends
  const fromApi = path.match(/\/api\/blasts\/([^/]+)/);
  if (fromApi) return fromApi[1];

  const parts = path.split('/').filter(Boolean);
  const fnNames = new Set([
    'blast-test',
    'blast-send',
    'blast-send-one',
    'blast-sends',
    '.netlify',
    'functions',
  ]);
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (seg && !fnNames.has(seg)) return seg;
  }

  // Fallback: original URL headers Netlify sometimes preserves
  const raw =
    event.rawUrl ||
    event.headers?.['x-forwarded-uri'] ||
    event.headers?.['x-original-url'] ||
    '';
  const m = String(raw).match(/\/api\/blasts\/([^/?]+)/);
  if (m) return m[1];
  return '';
}

export function serviceClient() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function applyBlastTemplate(template, vars = {}) {
  return renderTemplate(template, {
    displayName: vars.display_name,
    creatorName: vars.creator_name || vars.display_name,
    handle: vars.creator_handle,
    appName: vars.app_name,
    platform: vars.platform,
    hook: vars.hook,
    recentVideoTopic: vars.recent_video_topic,
    valueProp: vars.value_prop,
    videoHook: vars.video_hook,
    storeUrl: vars.store_url,
  });
}

export async function sendBlastEmail({ to, subject, body, campaignId }) {
  await ensureRuntimeSecrets();
  const from = resolveBlastFrom();
  const replyTo = resolveBlastReplyTo();
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(body);
  const html = looksLikeHtml ? body : body.replace(/\n/g, '<br>\n');
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();

  if (!apiKey) {
    return {
      ok: true,
      providerMessageId: `dry-run-blast-${Date.now()}`,
      dryRun: true,
      error: 'RESEND_API_KEY not set — blast recorded as dry-run',
    };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        reply_to: replyTo,
        to: [to.trim()],
        subject,
        html,
        tags: [
          { name: 'campaign_id', value: String(campaignId || 'blast').slice(0, 256) },
          { name: 'type', value: 'direct_blast' },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        providerMessageId: null,
        error: `Resend ${res.status}: ${JSON.stringify(data).slice(0, 300)}`,
      };
    }
    return {
      ok: true,
      providerMessageId: typeof data.id === 'string' ? data.id : null,
    };
  } catch (err) {
    return {
      ok: false,
      providerMessageId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function loadBlastCampaign(sb, campaignId) {
  const { data, error } = await sb
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) return { error: error.message, status: 500 };
  if (!data) return { error: 'Campaign not found', status: 404 };
  if (data.campaign_type !== 'direct_blast') {
    return {
      error: 'Campaign is not a direct_blast (set campaign_type=direct_blast)',
      status: 400,
    };
  }
  return { campaign: data };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEMPLATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asTemplateId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return TEMPLATE_ID_RE.test(id) ? id : null;
}

export async function insertSendRow(sb, table, row, { select = false } = {}) {
  const run = (payload) => {
    const query = sb.from(table).insert(payload);
    return select ? query.select().single() : query;
  };
  let result = await run(row);
  if (!result.error) return result;
  const message = result.error.message || '';
  const next = { ...row };
  let dropped = false;
  if (/template_id/i.test(message) && 'template_id' in next) {
    delete next.template_id;
    dropped = true;
  }
  if (/\bsubject\b/i.test(message) && 'subject' in next) {
    delete next.subject;
    dropped = true;
  }
  if (!dropped) return result;
  return run(next);
}
