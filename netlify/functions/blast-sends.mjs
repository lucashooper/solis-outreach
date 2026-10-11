import { getCampaignId, handleOptions, json, serviceClient } from '../lib/blastShared.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const sb = serviceClient();
  if (!sb) return json(500, { error: 'Supabase not configured on server' });

  const campaignId = getCampaignId(event);
  if (!campaignId) return json(400, { error: 'campaignId is required' });

  const { data, error } = await sb
    .from('blast_sends')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false });
  if (error) return json(500, { error: error.message });

  const rows = data ?? [];
  const counts = { sent: 0, failed: 0, opened: 0 };
  for (const r of rows) {
    const s = String(r.status);
    if (s === 'sent') counts.sent += 1;
    else if (s === 'failed') counts.failed += 1;
    else if (s === 'opened') counts.opened += 1;
  }
  return json(200, { ok: true, counts, sends: rows });
}
