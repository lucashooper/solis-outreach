import { handleOptions, json, serviceClient } from '../lib/blastShared.mjs';
import { ensureRuntimeSecrets } from '../lib/runtimeSecrets.mjs';
import {
  DISCOVERY_UNCONFIGURED,
  discoveryConfigured,
  startDiscoveryJob,
} from '../../src/discovery/discoveryJobs.js';

interface NetlifyEvent {
  httpMethod?: string;
  body?: string | null;
}

function noStore(statusCode: number, body: unknown) {
  const res = json(statusCode, body);
  res.headers['Cache-Control'] = 'no-store, max-age=0';
  res.headers.Pragma = 'no-cache';
  return res;
}

export async function handler(event: NetlifyEvent) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod === 'GET') {
    await ensureRuntimeSecrets();
    const configured = discoveryConfigured();
    return noStore(200, {
      ok: true,
      configured,
      message: configured ? null : DISCOVERY_UNCONFIGURED,
    });
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }
  const sb = serviceClient();
  if (!sb) return json(500, { error: 'Supabase is not configured on the server' });
  let body: unknown = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const result = await startDiscoveryJob(sb, body);
  return noStore(result.statusCode, result.body);
}
