import { handleOptions, json, serviceClient } from '../lib/blastShared.mjs';
import { pollDiscoveryJob } from '../../src/discovery/discoveryJobs.js';

interface NetlifyEvent {
  httpMethod?: string;
  path?: string;
  rawUrl?: string;
  queryStringParameters?: { jobId?: string } | null;
}

function jobIdFrom(event: NetlifyEvent): string {
  const query = event.queryStringParameters?.jobId;
  if (query) return String(query).trim();
  const path = `${event.path || ''} ${event.rawUrl || ''}`;
  const match = path.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : '';
}

export async function handler(event: NetlifyEvent) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }
  const sb = serviceClient();
  if (!sb) return json(500, { error: 'Supabase is not configured on the server' });
  const jobId = jobIdFrom(event);
  if (!jobId) return json(400, { error: 'Search id is required.' });
  const result = await pollDiscoveryJob(sb, jobId);
  const res = json(result.statusCode, result.body);
  res.headers['Cache-Control'] = 'no-store, max-age=0';
  res.headers.Pragma = 'no-cache';
  return res;
}
