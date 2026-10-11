import { json, handleOptions } from '../lib/blastShared.mjs';
import { searchAppStore } from '../lib/appStore.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const q = String(
    event.queryStringParameters?.q || event.queryStringParameters?.term || '',
  ).trim();
  if (!q) {
    return json(400, { error: 'Enter an app name, bundle ID, or track ID.' });
  }
  try {
    const results = await searchAppStore(q);
    return json(200, { ok: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'App Store lookup failed';
    return json(502, { error: message });
  }
}
