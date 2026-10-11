/**
 * Send one blast email (Netlify free-tier safe).
 * Client orchestrates the loop with ~500ms delay between calls.
 */
import {
  getCampaignId,
  applyBlastTemplate,
  handleOptions,
  json,
  loadBlastCampaign,
  sendBlastEmail,
  serviceClient,
  asTemplateId,
  insertSendRow,
} from '../lib/blastShared.mjs';
import { lookupSuppression } from '../lib/suppression.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const sb = serviceClient();
  if (!sb) return json(500, { error: 'Supabase not configured on server' });

  const campaignId = getCampaignId(event);
  if (!campaignId) return json(400, { error: 'campaignId is required' });

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const memberId =
    typeof body.memberId === 'string' ? body.memberId.trim() : '';
  const isFirst = Boolean(body.isFirst);
  const isLast = Boolean(body.isLast);

  const loaded = await loadBlastCampaign(sb, campaignId);
  if (loaded.error) return json(loaded.status, { error: loaded.error });
  const campaign = loaded.campaign;

  const groupId = campaign.audience_group_id;
  if (!groupId) {
    return json(400, { error: 'Campaign has no audience_group_id' });
  }

  let member = null;
  if (memberId) {
    const { data, error } = await sb
      .from('audience_members')
      .select('id, email, display_name')
      .eq('id', memberId)
      .eq('group_id', groupId)
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    member = data;
  } else if (typeof body.email === 'string' && body.email.includes('@')) {
    const { data, error } = await sb
      .from('audience_members')
      .select('id, email, display_name')
      .eq('group_id', groupId)
      .eq('email', body.email.trim().toLowerCase())
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    member = data;
  }

  if (!member) {
    return json(400, { error: 'memberId or email (in audience) is required' });
  }

  const appName =
    (campaign.app_name || '').trim() ||
    (process.env.APP_NAME || '').trim() ||
    'Solis';
  const subjectTpl = String(campaign.email_subject ?? '');
  const bodyTpl = String(campaign.email_body ?? '');
  if (!subjectTpl.trim() || !bodyTpl.trim()) {
    return json(400, {
      error: 'Campaign needs email_subject and email_body before sending',
    });
  }

  if (isFirst) {
    await sb
      .from('campaigns')
      .update({ status: 'outreaching' })
      .eq('id', campaign.id);
  }

  let gate;
  try {
    gate = await lookupSuppression(sb, {
      email: member.email,
      override: Boolean(body.override),
    });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : 'Could not check the block list' });
  }
  if (gate.skip) {
    const templateId = asTemplateId(campaign.template_id);
    const { data: row, error: insErr } = await insertSendRow(
      sb,
      'blast_sends',
      {
        campaign_id: campaign.id,
        member_id: member.id,
        email: member.email,
        status: 'skipped',
        error: gate.reason,
        sent_at: null,
        ...(templateId ? { template_id: templateId } : {}),
      },
      { select: true },
    );
    if (insErr) return json(500, { error: insErr.message });
    if (isLast) {
      await sb.from('campaigns').update({ status: 'done' }).eq('id', campaign.id);
    }
    return json(200, {
      ok: true,
      status: 'skipped',
      email: member.email,
      display_name: member.display_name,
      error: gate.reason,
      send: row,
      campaignId: campaign.id,
    });
  }

  const vars = {
    display_name: member.display_name || 'there',
    creator_name: member.display_name || '',
    hook: '',
    app_name: appName,
    creator_handle: '',
    platform: '',
    recent_video_topic: '',
  };
  const subject = applyBlastTemplate(subjectTpl, vars);
  const emailBody = applyBlastTemplate(bodyTpl, vars);
  const result = await sendBlastEmail({
    to: String(member.email),
    subject,
    body: emailBody,
    campaignId: campaign.id,
  });

  const status = result.ok ? 'sent' : 'failed';
  const templateId = asTemplateId(campaign.template_id);
  const { data: row, error: insErr } = await insertSendRow(
    sb,
    'blast_sends',
    {
      campaign_id: campaign.id,
      member_id: member.id,
      email: member.email,
      status,
      error: result.ok
        ? result.dryRun
          ? result.error ?? null
          : null
        : result.error ?? 'send failed',
      provider_message_id: result.providerMessageId,
      sent_at: result.ok ? new Date().toISOString() : null,
      ...(templateId ? { template_id: templateId } : {}),
    },
    { select: true },
  );
  if (insErr) return json(500, { error: insErr.message });

  if (isLast) {
    await sb.from('campaigns').update({ status: 'done' }).eq('id', campaign.id);
  }

  return json(200, {
    ok: result.ok,
    status,
    email: member.email,
    display_name: member.display_name,
    subject,
    body: emailBody,
    dryRun: Boolean(result.dryRun),
    error: result.ok ? null : result.error,
    providerMessageId: result.providerMessageId,
    send: row,
    campaignId: campaign.id,
  });
}
