import {
  getCampaignId,
  applyBlastTemplate,
  handleOptions,
  json,
  loadBlastCampaign,
  sendBlastEmail,
  serviceClient,
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

  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
  if (!to || !to.includes('@')) {
    return json(400, { error: 'to (email) is required' });
  }

  const loaded = await loadBlastCampaign(sb, campaignId);
  if (loaded.error) return json(loaded.status, { error: loaded.error });
  const campaign = loaded.campaign;

  try {
    const gate = await lookupSuppression(sb, { email: to, override: true });
    if (gate.skip) return json(409, { ok: false, error: gate.reason });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : 'Could not check the block list' });
  }

  const appName =
    (campaign.app_name || '').trim() ||
    (process.env.APP_NAME || '').trim() ||
    'Solis';
  const sample = {
    display_name: 'Alex',
    creator_name: 'Alex',
    creator_handle: 'alexfits',
    hook: 'Your training clips feel like a natural fit.',
    app_name: appName,
    platform: 'tiktok',
    recent_video_topic: 'morning workout',
  };
  const subject = applyBlastTemplate(String(campaign.email_subject ?? ''), sample);
  const emailBody = applyBlastTemplate(String(campaign.email_body ?? ''), sample);

  if (!subject.trim() || !emailBody.trim()) {
    return json(400, {
      error: 'Campaign needs email_subject and email_body before testing',
    });
  }

  const result = await sendBlastEmail({
    to,
    subject: `[TEST] ${subject}`,
    body: emailBody,
    campaignId: campaign.id,
  });

  if (!result.ok) return json(502, { ok: false, error: result.error });
  return json(200, {
    ok: true,
    to,
    providerMessageId: result.providerMessageId,
    dryRun: Boolean(result.dryRun),
    note: result.error,
  });
}
