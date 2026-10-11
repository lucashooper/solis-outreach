/**
 * Gmail inbox poll for the outreach mailbox (studioowner@gmail.com).
 * Uses a refresh token. Fails clearly when OAuth env is missing.
 * Service-role Supabase client is passed in (Netlify function or Express).
 */
import {
  DEFAULT_OWN_ADDRESSES,
  formatGmailApiError,
  gmailNotConfiguredMessage,
  inboundFromGmailPayload,
  missingGmailEnv,
  normaliseEmail,
  planReplySync,
} from './replySync.mjs';
import { ensureRuntimeSecrets } from './runtimeSecrets.mjs';

const GMAIL_LIST = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Newest inbox messages kept on each poll. One page of 20 dropped replies under a busy inbox. */
export const GMAIL_INBOX_QUERY = 'in:inbox newer_than:30d';
export const GMAIL_LIST_LIMIT = 80;
export const GMAIL_PAGE_SIZE = 40;

/** Next Gmail list URL, or null once the cap is reached. */
export function gmailListPageUrl(collectedCount, pageToken = '') {
  const room = GMAIL_LIST_LIMIT - collectedCount;
  if (room <= 0) return null;
  const max = Math.min(GMAIL_PAGE_SIZE, room);
  const query = encodeURIComponent(GMAIL_INBOX_QUERY);
  const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
  return `${GMAIL_LIST}?maxResults=${max}&q=${query}${page}`;
}

function ownAddressesFromEnv(env) {
  const extra = [env.RESEND_REPLY_TO, env.RESEND_FROM_EMAIL, env.GMAIL_MAILBOX]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return [...DEFAULT_OWN_ADDRESSES, ...extra];
}

function headerValue(headers, name) {
  if (!headers) return '';
  const found = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!found) return '';
  const value = headers[found];
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

export async function authoriseGmailSync({ headers, supabase, env }) {
  const secret = String(env.WEBHOOK_SHARED_SECRET || '').trim();
  const headerSecret = headerValue(headers, 'x-webhook-secret');
  const authorization = headerValue(headers, 'authorization');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';

  if (secret && (headerSecret === secret || bearer === secret)) {
    return { ok: true };
  }

  if (bearer) {
    try {
      if (supabase?.auth?.getUser) {
        const { data, error } = await supabase.auth.getUser(bearer);
        if (!error && data?.user?.id) return { ok: true };
      }
    } catch {
      /* try the Auth REST endpoint below */
    }
    const url = String(env.SUPABASE_URL || '').trim().replace(/\/$/, '');
    const key = String(env.SUPABASE_ANON_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (url && key) {
      try {
        const res = await fetch(`${url}/auth/v1/user`, {
          headers: {
            Authorization: `Bearer ${bearer}`,
            apikey: key,
          },
        });
        if (res.ok) {
          const user = await res.json().catch(() => null);
          if (user?.id) return { ok: true };
        }
      } catch {
        /* fall through to unauthorised */
      }
    }
  }

  return {
    ok: false,
    error:
      'Unauthorised. Sign in to the admin, or send the x-webhook-secret header.',
  };
}

async function readJson(res) {
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { text, parsed };
}

async function refreshAccessToken(env) {
  const body = new URLSearchParams({
    client_id: String(env.GMAIL_CLIENT_ID).trim(),
    client_secret: String(env.GMAIL_CLIENT_SECRET).trim(),
    refresh_token: String(env.GMAIL_REFRESH_TOKEN).trim(),
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const { parsed } = await readJson(res);
  if (!res.ok) {
    const code = parsed?.error ? ` (${parsed.error})` : '';
    throw new Error(
      `Gmail token refresh failed (${res.status})${code}. Check the OAuth client and refresh token.`,
    );
  }
  const token = parsed?.access_token;
  if (!token) throw new Error('Gmail token refresh returned no access_token');
  return token;
}

async function gmailGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { parsed } = await readJson(res);
  if (!res.ok) {
    throw new Error(formatGmailApiError(res.status, parsed));
  }
  return parsed || {};
}

async function listInbound(token) {
  const ids = [];
  let pageToken = '';
  let pages = 0;
  while (ids.length < GMAIL_LIST_LIMIT && pages < 5) {
    pages += 1;
    const url = gmailListPageUrl(ids.length, pageToken);
    if (!url) break;
    const listed = await gmailGet(url, token);
    const page = listed.messages || [];
    for (const message of page) {
      if (message?.id && ids.length < GMAIL_LIST_LIMIT) ids.push(message.id);
    }
    const next = listed.nextPageToken ? String(listed.nextPageToken) : '';
    if (!next || next === pageToken || page.length === 0) break;
    pageToken = next;
  }
  const messages = [];
  for (let i = 0; i < ids.length; i += 5) {
    const chunk = ids.slice(i, i + 5);
    const part = await Promise.all(
      chunk.map(async (id) => {
        const raw = await gmailGet(
          `${GMAIL_LIST}/${encodeURIComponent(id)}?format=full`,
          token,
        );
        return inboundFromGmailPayload(raw);
      }),
    );
    messages.push(...part);
  }
  return messages;
}

function displayName(from) {
  const match = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</);
  return match ? match[1].trim() : '';
}

function replyText(message) {
  const text = String(message.body || message.snippet || '').trim();
  return text ? text.slice(0, 20000) : null;
}

async function storeEmailReplies(sb, messages, plan, creators, blasts, storedSeen) {
  const hidden = new Set(
    (plan.skipped || [])
      .filter((row) => row.reason === 'automated' || row.reason === 'own_mailbox' || row.reason === 'no_sender')
      .map((row) => row.id),
  );
  const seenById = new Map((plan.seen || []).map((row) => [row.gmail_message_id, row]));
  const creatorById = new Map(creators.map((row) => [row.id, row]));
  const blastById = new Map(blasts.map((row) => [row.id, row]));
  const emails = [
    ...new Set(messages.map((message) => normaliseEmail(message.from)).filter(Boolean)),
  ];
  let members = [];
  if (emails.length) {
    const { data, error } = await sb
      .from('audience_members')
      .select('id, email, group_id')
      .in('email', emails);
    if (!error) members = data || [];
  }
  const memberByEmail = new Map(
    members.map((row) => [normaliseEmail(row.email), row]),
  );

  const candidateIds = [];
  for (const message of messages) {
    const id = String(message.id || '').trim();
    if (id && !hidden.has(id) && normaliseEmail(message.from)) candidateIds.push(id);
  }
  const existingIds = new Set();
  if (candidateIds.length) {
    const { data, error } = await sb
      .from('email_replies')
      .select('gmail_message_id')
      .in('gmail_message_id', candidateIds);
    if (!error) {
      for (const row of data || []) {
        if (row.gmail_message_id) existingIds.add(row.gmail_message_id);
      }
    }
  }

  const rows = [];
  const refreshes = [];
  for (const message of messages) {
    const id = String(message.id || '').trim();
    if (!id || hidden.has(id)) continue;
    const fromEmail = normaliseEmail(message.from);
    if (!fromEmail) continue;
    const text = replyText(message);
    const snippet = message.snippet ? String(message.snippet).slice(0, 500) : null;
    if (existingIds.has(id)) {
      refreshes.push({ id, snippet, text });
      continue;
    }
    const seen = seenById.get(id) || storedSeen?.get(id) || null;
    const creatorId = seen?.matched_creator_ids?.[0] || null;
    const blastId = seen?.matched_blast_ids?.[0] || null;
    const creator = creatorId ? creatorById.get(creatorId) : null;
    const blast = blastId ? blastById.get(blastId) : null;
    const member = memberByEmail.get(fromEmail) || null;
    rows.push({
      gmail_message_id: id,
      from_email: fromEmail,
      from_name: displayName(message.from) || null,
      subject: message.subject ? String(message.subject).slice(0, 500) : null,
      snippet,
      body: text,
      body_text: text,
      received_at: message.receivedAt || new Date().toISOString(),
      creator_id: creatorId,
      audience_member_id: member?.id || null,
      campaign_id: blast?.campaign_id || creator?.campaign_id || null,
      app_id: creator?.app_id || null,
    });
  }
  if (rows.length) {
    const { error } = await sb.from('email_replies').upsert(rows, {
      onConflict: 'gmail_message_id',
    });
    if (error && !/email_replies|schema cache/i.test(error.message)) {
      throw new Error(`email_replies: ${error.message}`);
    }
  }
  for (const row of refreshes) {
    const { error } = await sb
      .from('email_replies')
      .update({ snippet: row.snippet, body: row.text, body_text: row.text })
      .eq('gmail_message_id', row.id);
    if (error && !/email_replies|schema cache/i.test(error.message)) {
      throw new Error(`email_replies: ${error.message}`);
    }
  }
}

function schemaError(message) {
  return /gmail_seen_messages|replied_at|schema cache/i.test(message);
}

function storageMissingMessage() {
  return (
    'Reply sync storage is missing. Apply supabase/migrations/20260930120000_gmail_reply_sync.sql ' +
    'in the Supabase SQL editor. Manual mark-as-replied still works.'
  );
}

async function rowsOrThrow(query, label) {
  const { data, error } = await query;
  if (error) {
    const message = String(error.message || error);
    if (schemaError(message)) {
      const err = new Error(storageMissingMessage());
      err.status = 500;
      throw err;
    }
    throw new Error(`${label}: ${message}`);
  }
  return data || [];
}

/**
 * Poll Gmail and mark matching creators / blast sends.
 * Returns { ok: false, status, error } when credentials or storage are missing.
 */
async function storedRefreshToken(sb) {
  try {
    const { data, error } = await sb
      .from('integration_secrets')
      .select('value')
      .eq('key', 'gmail_refresh_token')
      .maybeSingle();
    if (error || !data?.value) return '';
    return String(data.value).trim();
  } catch {
    return '';
  }
}

export async function runGmailReplySync(sb, env = process.env) {
  await ensureRuntimeSecrets();
  const next = { ...(env === process.env ? process.env : env) };
  if (!String(next.GMAIL_REFRESH_TOKEN || '').trim()) {
    const stored = await storedRefreshToken(sb);
    if (stored) next.GMAIL_REFRESH_TOKEN = stored;
  }
  const missing = missingGmailEnv(next);
  if (missing.length) {
    return { ok: false, status: 503, error: gmailNotConfiguredMessage(missing) };
  }

  try {
    const token = await refreshAccessToken(next);
    const messages = await listInbound(token);
    const ids = messages.map((m) => m.id).filter(Boolean);

    const [creators, blasts, campaigns, logs] = await Promise.all([
      rowsOrThrow(
        sb.from('creators').select('id, email, outreach_status, ai_variables, campaign_id, app_id'),
        'creators',
      ),
      rowsOrThrow(
        sb
          .from('blast_sends')
          .select('id, email, status, replied_at, campaign_id, provider_message_id'),
        'blast_sends',
      ),
      rowsOrThrow(sb.from('campaigns').select('id, email_subject'), 'campaigns'),
      rowsOrThrow(
        sb
          .from('outreach_logs')
          .select('creator_id, provider_message_id')
          .not('provider_message_id', 'is', null)
          .limit(2000),
        'outreach_logs',
      ),
    ]);
    const outbound = [
      ...blasts
        .filter((row) => row.provider_message_id)
        .map((row) => ({
          provider_message_id: row.provider_message_id,
          blast_id: row.id,
          creator_id: null,
        })),
      ...logs
        .filter((row) => row.provider_message_id)
        .map((row) => ({
          provider_message_id: row.provider_message_id,
          creator_id: row.creator_id,
          blast_id: null,
        })),
    ];

    const storedSeen = new Map();
    let seenIds = [];
    if (ids.length) {
      const seenRows = await rowsOrThrow(
        sb
          .from('gmail_seen_messages')
          .select('gmail_message_id, matched_creator_ids, matched_blast_ids')
          .in('gmail_message_id', ids),
        'gmail_seen_messages',
      );
      seenIds = seenRows.map((r) => r.gmail_message_id).filter(Boolean);
      for (const row of seenRows) {
        if (row.gmail_message_id) storedSeen.set(row.gmail_message_id, row);
      }
    }

    const plan = planReplySync(messages, {
      creators,
      blasts,
      campaigns,
      seenIds,
      ownAddresses: ownAddressesFromEnv(env),
      outbound,
    });

    const repliedAt = new Date().toISOString();
    for (const update of plan.creatorUpdates) {
      const { error } = await sb
        .from('creators')
        .update({
          outreach_status: update.outreach_status,
          ai_variables: update.ai_variables,
        })
        .eq('id', update.id);
      if (error) throw new Error(`creator update: ${error.message}`);
    }

    for (const update of plan.blastUpdates) {
      const { error } = await sb
        .from('blast_sends')
        .update({ replied_at: repliedAt })
        .eq('id', update.id)
        .is('replied_at', null);
      if (error) {
        if (schemaError(error.message)) throw new Error(storageMissingMessage());
        throw new Error(`blast update: ${error.message}`);
      }
    }

    if (plan.seen.length) {
      const { error } = await sb.from('gmail_seen_messages').upsert(plan.seen, {
        onConflict: 'gmail_message_id',
        ignoreDuplicates: true,
      });
      if (error) {
        if (schemaError(error.message)) throw new Error(storageMissingMessage());
        throw new Error(`seen insert: ${error.message}`);
      }
    }

    await storeEmailReplies(sb, messages, plan, creators, blasts, storedSeen);

    const syncedAt = new Date().toISOString();
    const { error: syncStampError } = await sb.from('integration_secrets').upsert({
      key: 'gmail_last_synced_at',
      value: syncedAt,
      updated_at: syncedAt,
    });
    if (syncStampError) {
      console.warn('[gmail-reply-sync] last synced stamp:', syncStampError.message);
    }

    const count = (reason) => plan.skipped.filter((s) => s.reason === reason).length;
    return {
      ok: true,
      scanned: messages.length,
      alreadySeen: count('already_seen'),
      markedCreators: plan.creatorUpdates.length,
      markedBlasts: plan.blastUpdates.length,
      unmatched: count('no_matching_lead'),
      skippedAutomated: count('automated') + count('own_mailbox'),
      syncedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err && err.status ? err.status : schemaError(message) ? 500 : 502;
    const error = schemaError(message) ? storageMissingMessage() : message;
    return { ok: false, status, error };
  }
}
