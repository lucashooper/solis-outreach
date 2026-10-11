/**
 * Pure reply-matching for the outreach mailbox.
 * Replies arrive at studioowner@gmail.com (Resend reply_to).
 * Gmail ignores dots in the local part, so studio.owner@gmail.com is the
 * same mailbox — do not add a second Google account.
 *
 * British English comments. No network, no secrets.
 */

export const DEFAULT_OWN_ADDRESSES = [
  'studioowner@gmail.com',
  'outreach@example.com',
];

const RESTORABLE_STATUSES = [
  'pending',
  'pending_review',
  'queued',
  'sent',
  'archived',
];

const BLAST_CONTACTED = new Set(['sent', 'opened', 'replied']);

/** Pull a bare email address out of a From header. Empty when none. */
export function normaliseEmail(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  const angled = raw.match(/<([^>]+)>/);
  let addr = (angled ? angled[1] : raw).trim();
  addr = addr.replace(/^mailto:/, '').split(/[>,;\s]/)[0].trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return '';
  return addr;
}

function splitEmail(email) {
  const n = normaliseEmail(email);
  const at = n.lastIndexOf('@');
  if (at < 1) return null;
  return { local: n.slice(0, at), domain: n.slice(at + 1), email: n };
}

/** Gmail dot-and-plus canonical form, used only to recognise our own mailbox. */
function gmailDotCanonical(email) {
  const parts = splitEmail(email);
  if (!parts) return '';
  if (parts.domain !== 'gmail.com' && parts.domain !== 'googlemail.com') return '';
  const local = parts.local.replace(/\./g, '').split('+')[0];
  return `${local}@gmail.com`;
}

/**
 * Lead match key. Gmail plus-tags collapse (user+tag@gmail.com → user@gmail.com).
 * Dots are kept so two different people are not treated as one lead.
 */
export function leadEmailKey(email) {
  const parts = splitEmail(email);
  if (!parts) return '';
  if (parts.domain === 'gmail.com' || parts.domain === 'googlemail.com') {
    return `${parts.local.split('+')[0]}@gmail.com`;
  }
  return parts.email;
}

export function isOwnMailbox(email, ownAddresses = DEFAULT_OWN_ADDRESSES) {
  const n = normaliseEmail(email);
  if (!n) return false;
  const own = ownAddresses.map((a) => normaliseEmail(a)).filter(Boolean);
  if (own.includes(n)) return true;
  const canon = gmailDotCanonical(n);
  if (!canon) return false;
  return own.some((a) => gmailDotCanonical(a) === canon);
}

export function isAutomatedSender(email) {
  const parts = splitEmail(email);
  if (!parts) return true;
  if (parts.domain === 'google.com' || parts.domain.endsWith('.google.com')) {
    return true;
  }
  const flat = parts.local.replace(/\./g, '');
  if (
    /^(noreply|no-reply|mailer-daemon|mailerdaemon|postmaster|notifications?|notify|bounce|donotreply)$/.test(
      flat,
    )
  ) {
    return true;
  }
  if (
    flat.includes('noreply') ||
    flat.includes('no-reply') ||
    flat.includes('donotreply') ||
    flat.includes('mailerdaemon')
  ) {
    return true;
  }
  return false;
}

export function normaliseSubject(subject) {
  let text = String(subject || '').trim();
  let prev = '';
  while (text && text !== prev) {
    prev = text;
    text = text.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  }
  return text.toLowerCase();
}

export function subjectsRelate(replySubject, campaignSubject) {
  const reply = normaliseSubject(replySubject);
  const campaign = normaliseSubject(campaignSubject);
  if (!reply || !campaign) return false;
  return reply === campaign || reply.includes(campaign) || campaign.includes(reply);
}

export function missingGmailEnv(env = {}) {
  const missing = [];
  if (!String(env.GMAIL_CLIENT_ID || '').trim()) missing.push('GMAIL_CLIENT_ID');
  if (!String(env.GMAIL_CLIENT_SECRET || '').trim()) missing.push('GMAIL_CLIENT_SECRET');
  if (!String(env.GMAIL_REFRESH_TOKEN || '').trim()) missing.push('GMAIL_REFRESH_TOKEN');
  return missing;
}

export function gmailNotConfiguredMessage(missing) {
  const list = (missing || []).join(', ') || 'GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN';
  return (
    `Gmail sync is not configured (missing ${list}). ` +
    'Manual mark-as-replied still works. See docs/webhook-setup.md for the Google Cloud steps.'
  );
}

const GMAIL_ENABLE_LINK =
  'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=465091512038';

function decodeBase64Url(data) {
  const raw = String(data || '').trim();
  if (!raw) return '';
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function collectMimeParts(part, acc) {
  if (!part || typeof part !== 'object') return;
  if (part.mimeType && part.body?.data) acc.push(part);
  for (const child of part.parts || []) collectMimeParts(child, acc);
}

/** Prefer text/plain. Fall back to tags stripped from text/html. */
export function decodeGmailBody(payload) {
  const parts = [];
  collectMimeParts(payload, parts);
  const plain = parts.find((part) => String(part.mimeType).toLowerCase() === 'text/plain');
  if (plain?.body?.data) return decodeBase64Url(plain.body.data).trim();
  const html = parts.find((part) => String(part.mimeType).toLowerCase() === 'text/html');
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));
  if (payload?.body?.data) {
    const mime = String(payload.mimeType || '').toLowerCase();
    const text = decodeBase64Url(payload.body.data);
    return mime === 'text/html' ? stripHtml(text) : text.trim();
  }
  return '';
}

export function messageIdsFromHeader(value) {
  const text = String(value || '');
  const ids = [];
  const re = /<([^>]+)>/g;
  let match = re.exec(text);
  while (match) {
    const id = String(match[1] || '').trim().toLowerCase();
    if (id) ids.push(id);
    match = re.exec(text);
  }
  if (ids.length === 0 && text.trim()) {
    ids.push(text.trim().replace(/^<|>$/g, '').toLowerCase());
  }
  return ids;
}

/**
 * Google 403s often only expose PERMISSION_DENIED. Keep the full message,
 * and point at the enable page when the Gmail API itself is switched off.
 */
export function formatGmailApiError(status, parsed) {
  const err = parsed?.error && typeof parsed.error === 'object' ? parsed.error : {};
  const googleMessage = String(err.message || parsed?.error_description || '').trim();
  const reasons = [];
  if (err.status) reasons.push(String(err.status));
  for (const detail of err.details || []) {
    if (detail?.reason) reasons.push(String(detail.reason));
  }
  for (const item of err.errors || []) {
    if (item?.reason) reasons.push(String(item.reason));
  }
  const blob = `${googleMessage} ${reasons.join(' ')}`.toLowerCase();
  const disabled =
    blob.includes('service_disabled') ||
    blob.includes('accessnotconfigured') ||
    blob.includes('access_not_configured');
  if (disabled) {
    const google = googleMessage ? ` Google said: ${googleMessage}` : '';
    return (
      `The Gmail API is turned off for this Google Cloud project. ` +
      `Enable it at ${GMAIL_ENABLE_LINK} and try again in a few minutes.${google}`
    );
  }
  const detail = [err.status, googleMessage].filter(Boolean).join(': ');
  return `Gmail API ${status}${detail ? `: ${detail}` : ''}`;
}

/** Map a Gmail messages.get payload onto the fields reply matching needs. */
export function inboundFromGmailPayload(raw) {
  const headers = raw?.payload?.headers || [];
  const read = (name) => {
    const row = headers.find(
      (h) => String(h?.name || '').toLowerCase() === name.toLowerCase(),
    );
    return row?.value ? String(row.value) : '';
  };
  const internal = Number(raw?.internalDate);
  return {
    id: raw?.id ? String(raw.id) : '',
    threadId: raw?.threadId ? String(raw.threadId) : '',
    from: read('From'),
    subject: read('Subject'),
    inReplyTo: read('In-Reply-To'),
    references: read('References'),
    snippet: raw?.snippet ? String(raw.snippet) : '',
    body: decodeGmailBody(raw?.payload),
    receivedAt: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : null,
  };
}

/**
 * Manual CRM toggle. Sets outreach_status to replied, or restores the status
 * saved in ai_variables.status_before_reply (falls back to sent).
 */
export function planManualReplyToggle(creator, replied) {
  const ai = { ...(creator?.ai_variables || {}) };
  const current = String(creator?.outreach_status || '');
  if (replied) {
    if (current === 'replied') {
      return { outreach_status: 'replied', ai_variables: ai, changed: false };
    }
    ai.status_before_reply = current;
    return { outreach_status: 'replied', ai_variables: ai, changed: true };
  }
  if (current !== 'replied') {
    return { outreach_status: current, ai_variables: ai, changed: false };
  }
  const back = ai.status_before_reply;
  delete ai.status_before_reply;
  const restored =
    typeof back === 'string' && RESTORABLE_STATUSES.includes(back) ? back : 'sent';
  return { outreach_status: restored, ai_variables: ai, changed: true };
}

function campaignSubject(campaigns, campaignId) {
  if (!campaignId) return '';
  const row = campaigns.find((c) => c.id === campaignId);
  return row?.email_subject ? String(row.email_subject) : '';
}

function headerMatchesProvider(headerIds, providerId) {
  const key = String(providerId || '').trim().toLowerCase().replace(/^<|>$/g, '');
  if (key.length < 8) return false;
  return headerIds.some(
    (id) => id === key || id.startsWith(`${key}@`) || id.includes(key),
  );
}

function threadHits(message, outbound, creators, blasts) {
  const headerIds = [
    ...messageIdsFromHeader(message?.inReplyTo),
    ...messageIdsFromHeader(message?.references),
  ];
  if (headerIds.length === 0) return { creators: [], blasts: [] };
  const creatorIds = new Set();
  const blastIds = new Set();
  for (const row of outbound || []) {
    if (!headerMatchesProvider(headerIds, row?.provider_message_id)) continue;
    if (row.creator_id) creatorIds.add(row.creator_id);
    if (row.blast_id) blastIds.add(row.blast_id);
  }
  return {
    creators: (creators || []).filter((creator) => creatorIds.has(creator.id)),
    blasts: (blasts || []).filter((blast) => blastIds.has(blast.id)),
  };
}

/**
 * Decide which existing leads a batch of inbound messages should mark.
 * Idempotent: message ids in seenIds produce no writes. Unknown senders,
 * our own mailbox, and automated mail never mark a lead.
 *
 * @param {Array<{id: string, from: string, subject?: string}>} messages
 * @param {{
 *   creators: Array<{id: string, email?: string|null, outreach_status?: string, ai_variables?: object|null, campaign_id?: string|null}>,
 *   blasts: Array<{id: string, email?: string|null, status?: string, replied_at?: string|null, campaign_id?: string|null}>,
 *   campaigns: Array<{id: string, email_subject?: string|null}>,
 *   seenIds?: string[],
 *   ownAddresses?: string[],
 *   outbound?: Array<{ provider_message_id?: string|null, creator_id?: string|null, blast_id?: string|null }>,
 * }} input
 */
export function planReplySync(messages, input) {
  const seenSet = new Set(input.seenIds || []);
  const own = input.ownAddresses?.length ? input.ownAddresses : DEFAULT_OWN_ADDRESSES;
  const campaigns = input.campaigns || [];
  const creatorUpdates = [];
  const blastUpdates = [];
  const seen = [];
  const skipped = [];
  const creatorsTouched = new Set();
  const blastsTouched = new Set();

  for (const message of messages || []) {
    const id = String(message?.id || '').trim();
    if (!id) continue;
    if (seenSet.has(id)) {
      skipped.push({ id, reason: 'already_seen' });
      continue;
    }

    const fromEmail = normaliseEmail(message.from);
    const subject = String(message.subject || '').slice(0, 500);
    const recordSeen = (matchedCreatorIds, matchedBlastIds, reason) => {
      seen.push({
        gmail_message_id: id,
        from_email: fromEmail,
        subject,
        matched_creator_ids: matchedCreatorIds,
        matched_blast_ids: matchedBlastIds,
      });
      skipped.push({ id, reason });
      seenSet.add(id);
    };

    if (!fromEmail || !leadEmailKey(fromEmail)) {
      recordSeen([], [], 'no_sender');
      continue;
    }
    if (isOwnMailbox(fromEmail, own)) {
      recordSeen([], [], 'own_mailbox');
      continue;
    }
    if (isAutomatedSender(fromEmail)) {
      recordSeen([], [], 'automated');
      continue;
    }

    const fromKey = leadEmailKey(fromEmail);
    const fromCreators = (input.creators || []).filter(
      (c) => c.email && leadEmailKey(c.email) === fromKey,
    );
    const fromBlasts = (input.blasts || []).filter(
      (b) =>
        b.email &&
        leadEmailKey(b.email) === fromKey &&
        BLAST_CONTACTED.has(String(b.status || '')),
    );
    const threaded = threadHits(message, input.outbound, input.creators, input.blasts);
    const creatorHits = [...fromCreators];
    const blastHits = [...fromBlasts];
    for (const creator of threaded.creators) {
      if (!creatorHits.some((row) => row.id === creator.id)) creatorHits.push(creator);
    }
    for (const blast of threaded.blasts) {
      if (!blastHits.some((row) => row.id === blast.id)) blastHits.push(blast);
    }

    if (creatorHits.length === 0 && blastHits.length === 0) {
      recordSeen([], [], 'no_matching_lead');
      continue;
    }

    const creatorsBySubject = creatorHits.filter((c) =>
      subjectsRelate(subject, campaignSubject(campaigns, c.campaign_id)),
    );
    const blastsBySubject = blastHits.filter((b) =>
      subjectsRelate(subject, campaignSubject(campaigns, b.campaign_id)),
    );
    const narrowed = creatorsBySubject.length + blastsBySubject.length > 0;
    const chosenCreators = narrowed ? creatorsBySubject : creatorHits;
    const chosenBlasts = narrowed ? blastsBySubject : blastHits;

    const matchedCreatorIds = [];
    const matchedBlastIds = [];

    for (const creator of chosenCreators) {
      matchedCreatorIds.push(creator.id);
      if (creator.outreach_status === 'replied' || creatorsTouched.has(creator.id)) {
        continue;
      }
      const ai = { ...(creator.ai_variables || {}) };
      if (ai.status_before_reply == null || ai.status_before_reply === '') {
        ai.status_before_reply = creator.outreach_status || 'sent';
      }
      creatorUpdates.push({
        id: creator.id,
        outreach_status: 'replied',
        ai_variables: ai,
      });
      creatorsTouched.add(creator.id);
    }

    for (const blast of chosenBlasts) {
      matchedBlastIds.push(blast.id);
      if (blast.replied_at || blastsTouched.has(blast.id)) continue;
      blastUpdates.push({ id: blast.id });
      blastsTouched.add(blast.id);
    }

    seen.push({
      gmail_message_id: id,
      from_email: fromEmail,
      subject,
      matched_creator_ids: matchedCreatorIds,
      matched_blast_ids: matchedBlastIds,
    });
    skipped.push({ id, reason: 'matched' });
    seenSet.add(id);
  }

  return { creatorUpdates, blastUpdates, seen, skipped };
}
