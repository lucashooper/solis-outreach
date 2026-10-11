/**
 * One polite bump for a sent lead that has not replied.
 * Threads with In-Reply-To when we stored a real message id.
 */
import { handleOptions, json, serviceClient, asTemplateId, insertSendRow } from '../lib/blastShared.mjs';
import { ensureRuntimeSecrets } from '../lib/runtimeSecrets.mjs';
import { renderTemplate } from '../lib/templateTokens.mjs';
import { lookupSuppression } from '../lib/suppression.mjs';

function asFollowUpDays(value) {
  return Number(value) === 4 ? 4 : 3;
}

function needsFollowUp(input) {
  if (input.doNotContact) return false;
  if (input.replied) return false;
  if (String(input.status ?? '') !== 'sent') return false;
  if (!input.lastSentAt) return false;
  const sent = Date.parse(input.lastSentAt);
  if (!Number.isFinite(sent)) return false;
  const days = asFollowUpDays(input.days);
  return Date.now() - sent >= days * 24 * 60 * 60 * 1000;
}

const DEFAULT_SUBJECT = 'Re: {{app_name}} and {{creator_handle}}';
const DEFAULT_BODY = `Hi {{creator_name}},

I sent a note a few days ago about {{app_name}} and did not want it to get buried.

{{custom_hook}}

If a short collaboration is not a fit, no need to reply. If it is, I would love to hear from you.

Cheers,
{{app_name}}`;

function messageIdHeader(value) {
  const raw = String(value || '').trim();
  if (!raw.includes('@')) return null;
  return raw.startsWith('<') ? raw : `<${raw}>`;
}

async function sendFollowUpEmail({ to, subject, body, inReplyTo }) {
  await ensureRuntimeSecrets();
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from =
    String(process.env.RESEND_FROM_EMAIL || '').trim() ||
    'Alex from Example <outreach@example.com>';
  const replyTo = String(process.env.RESEND_REPLY_TO || '').trim() || 'studioowner@gmail.com';
  const html = /<[a-z][\s\S]*>/i.test(body) ? body : body.replace(/\n/g, '<br>\n');
  if (!apiKey) {
    return { ok: true, dryRun: true, providerMessageId: `dry-run-follow-up-${Date.now()}` };
  }
  const payload = {
    from,
    reply_to: replyTo,
    to: [to],
    subject,
    html,
    tags: [{ name: 'type', value: 'follow_up' }],
  };
  if (inReplyTo) {
    payload.headers = {
      'In-Reply-To': inReplyTo,
      References: inReplyTo,
    };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, error: `Resend ${res.status}: ${JSON.stringify(data).slice(0, 300)}` };
  }
  return { ok: true, providerMessageId: typeof data.id === 'string' ? data.id : null };
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const sb = serviceClient();
  if (!sb) return json(500, { error: 'Supabase is not configured on the server' });

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const creatorId = typeof body.creatorId === 'string' ? body.creatorId.trim() : '';
  if (!creatorId) return json(400, { error: 'creatorId is required' });
  const days = asFollowUpDays(body.days);

  const { data: creator, error } = await sb.from('creators').select('*').eq('id', creatorId).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!creator) return json(404, { error: 'Creator not found' });
  if (!creator.email) return json(400, { error: 'This creator has no email address.' });

  const { data: logs, error: logError } = await sb
    .from('outreach_logs')
    .select('sent_at, provider_message_id, outcome, sequence_step')
    .eq('creator_id', creatorId)
    .order('sent_at', { ascending: false })
    .limit(8);
  if (logError) return json(500, { error: logError.message });
  const sentLogs = (logs ?? []).filter((row) => row.sent_at && row.outcome !== 'skipped');
  const last = sentLogs[0] || null;

  const due = needsFollowUp({
    status: creator.outreach_status,
    replied: creator.outreach_status === 'replied',
    doNotContact: creator.do_not_contact === true,
    lastSentAt: last?.sent_at ?? null,
    days,
  });
  if (!due) {
    return json(409, {
      error: creator.do_not_contact
        ? 'Blocked: this person is marked Do not contact.'
        : creator.outreach_status === 'replied'
          ? 'This lead has replied, so no follow-up is due.'
          : `A follow-up is due ${days} days after the last send, and only for a sent lead.`,
    });
  }

  let gate;
  try {
    gate = await lookupSuppression(sb, {
      email: creator.email,
      handle: creator.handle,
      doNotContact: creator.do_not_contact === true,
      override: true,
    });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : 'Could not check the block list' });
  }
  if (gate.skip) return json(409, { error: gate.reason });

  let appName = (process.env.APP_NAME || '').trim() || 'Solis';
  if (creator.app_id) {
    const { data: app } = await sb.from('apps').select('name').eq('id', creator.app_id).maybeSingle();
    if (app?.name) appName = app.name;
  }
  const videos = Array.isArray(creator.top_videos) ? creator.top_videos : [];
  const topic = videos.map((video) => video?.caption).find((caption) => typeof caption === 'string' && caption.trim());
  const hook = typeof creator.ai_variables?.hook === 'string' ? creator.ai_variables.hook : '';
  const context = {
    creatorName: creator.handle,
    displayName: creator.handle,
    handle: creator.handle,
    appName,
    platform: creator.platform,
    hook,
    recentVideoTopic: topic || '',
  };
  const subject = renderTemplate(
    typeof body.subject === 'string' && body.subject.trim() ? body.subject : DEFAULT_SUBJECT,
    context,
  );
  const emailBody = renderTemplate(
    typeof body.template === 'string' && body.template.trim() ? body.template : DEFAULT_BODY,
    context,
  );
  const inReplyTo = messageIdHeader(last?.provider_message_id);
  const result = await sendFollowUpEmail({
    to: creator.email,
    subject,
    body: emailBody,
    inReplyTo,
  });
  if (!result.ok) return json(502, { ok: false, error: result.error });

  const templateId = asTemplateId(body.templateId);
  const { error: insertError } = await insertSendRow(sb, 'outreach_logs', {
    creator_id: creator.id,
    message_body: emailBody,
    subject,
    sequence_step: 2,
    sent_at: new Date().toISOString(),
    provider: result.dryRun ? 'resend-dry-run' : 'resend',
    provider_message_id: result.providerMessageId,
    outcome: 'sent',
    webhook_events: [],
    ...(templateId ? { template_id: templateId } : {}),
  });
  if (insertError) return json(500, { error: insertError.message });

  return json(200, {
    ok: true,
    dryRun: Boolean(result.dryRun),
    threaded: Boolean(inReplyTo),
    subject,
    providerMessageId: result.providerMessageId,
  });
}
