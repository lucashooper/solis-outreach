import { handleOptions, json, serviceClient } from '../lib/blastShared.mjs';
import { authoriseGmailSync, runGmailReplySync } from '../lib/gmailSync.mjs';

function flatHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/**
 * POST or GET /api/gmail/sync-replies
 * Polls the outreach mailbox and marks matching leads replied.
 * 503 when Gmail OAuth env is missing (not a fake success).
 */
export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'Method not allowed' });
  }

  const sb = serviceClient();
  if (!sb) {
    console.error('[gmail-reply-sync] Supabase not configured on server');
    return json(500, { ok: false, error: 'Supabase not configured on server' });
  }

  const auth = await authoriseGmailSync({
    headers: flatHeaders(event.headers),
    supabase: sb,
    env: process.env,
  });
  if (!auth.ok) {
    return json(401, { ok: false, error: auth.error });
  }

  const result = await runGmailReplySync(sb, process.env);
  if (!result.ok) {
    console.error('[gmail-reply-sync]', result.error);
    return json(result.status || 500, { ok: false, error: result.error });
  }

  console.log(
    `[gmail-reply-sync] scanned=${result.scanned} markedCreators=${result.markedCreators} markedBlasts=${result.markedBlasts}`,
  );
  return json(200, result);
}
