import {
  getCampaignId,
  applyBlastTemplate,
  handleOptions,
  json,
  loadBlastCampaign,
  sendBlastEmail,
  serviceClient,
  sleep,
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

  const loaded = await loadBlastCampaign(sb, campaignId);
  if (loaded.error) return json(loaded.status, { error: loaded.error });
  const campaign = loaded.campaign;

  const groupId = campaign.audience_group_id;
  if (!groupId) {
    return json(400, { error: 'Campaign has no audience_group_id' });
  }

  const { data: members, error: mErr } = await sb
    .from('audience_members')
    .select('id, email, display_name')
    .eq('group_id', groupId);
  if (mErr) return json(500, { error: mErr.message });
  if (!members?.length) {
    return json(400, { error: 'Audience has no members' });
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

  await sb.from('campaigns').update({ status: 'outreaching' }).eq('id', campaign.id);

  // Process inline (Netlify function lifetime). Cap for safety.
  const max = Math.min(members.length, 80);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < max; i++) {
    const member = members[i];
    const gate = await lookupSuppression(sb, { email: member.email });
    if (gate.skip) {
      skipped += 1;
      await insertSendRow(sb, 'blast_sends', {
        campaign_id: campaign.id,
        member_id: member.id,
        email: member.email,
        status: 'skipped',
        error: gate.reason,
        sent_at: null,
        ...(asTemplateId(campaign.template_id) ? { template_id: asTemplateId(campaign.template_id) } : {}),
      });
      if (i < max - 1) await sleep(400);
      continue;
    }
    const vars = {
      display_name: member.display_name || 'there',
      creator_name: member.display_name || '',
      hook: '',
      app_name: appName,
      creator_handle: '',
    };
    const subject = applyBlastTemplate(subjectTpl, vars);
    const body = applyBlastTemplate(bodyTpl, vars);
    const result = await sendBlastEmail({
      to: String(member.email),
      subject,
      body,
      campaignId: campaign.id,
    });
    const status = result.ok ? 'sent' : 'failed';
    if (result.ok) sent += 1;
    else failed += 1;
    await insertSendRow(sb, 'blast_sends', {
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
      ...(asTemplateId(campaign.template_id) ? { template_id: asTemplateId(campaign.template_id) } : {}),
    });
    if (i < max - 1) await sleep(400);
  }

  await sb.from('campaigns').update({ status: 'done' }).eq('id', campaign.id);

  return json(200, {
    ok: true,
    queued: members.length,
    processed: max,
    sent,
    failed,
    skipped,
    campaignId: campaign.id,
    note:
      members.length > max
        ? `Processed first ${max} of ${members.length} (function time limit)`
        : 'Blast finished',
  });
}
