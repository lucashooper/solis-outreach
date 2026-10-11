/**
 * Express API for campaign discovery + Visual CRM actions.
 *
 *   npm run server
 *   POST /api/campaigns  — create campaign (service role; bypasses RLS)
 *   POST /api/campaigns/:id/run  { "provider": "demo" | "apify" }
 *   POST /api/creators/:id/approve
 *   POST /api/creators/video-hooks  { ids, forceId? }  — preview only, does not send
 *   PATCH /api/creators/:id  { hook?, outreach_status? }
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import {
  approveAndPitchCreator,
  runCampaign,
} from '../src/pipeline/runCampaign.js';
import { readAppBranding } from '../src/pipeline/branding.js';
import type { DiscoveryProviderName } from '../src/discovery/types.js';
import { normaliseHashtags } from '../src/discovery/hashtags.js';
import { savedResultLimit } from '../src/discovery/funnel.js';
import { notifyDiscord } from '../src/pipeline/outreach.js';
import {
  isDiscordWebhook,
  loadDiscordSettings,
  notifyUnsentReplies,
  replyDiscordPayload,
  replySnippet,
  saveDiscordSettings,
  testDiscordPayload,
  maskWebhookUrl,
} from '../src/pipeline/discordNotify.js';
import {
  buildReplyClassificationPrompt,
  parseReplyClassification,
} from '../src/reply-classifier.js';
import { chatJson, isGroqConfigured } from '../src/llm/client.js';
import {
  emptyVideoHookProvenance,
  fillVideoHook,
  readStoredVideoHook,
  VIDEO_HOOK_SYSTEM,
  VIDEO_HOOK_VERSION,
  videoHookModel,
  type VideoCaption,
  type VideoHookDraft,
} from '../src/templates/videoHook.js';
import type { ReplySentiment } from '../src/types.js';
import { createClient } from '@supabase/supabase-js';
import {
  startAutopilotScheduler,
  runAutopilotForCampaign,
} from './autopilot.js';
import {
  registerAudienceBlastRoutes,
  buildDirectBlastPayload,
} from './audienceBlast.js';
import { summariseReplyMetrics } from '../admin/src/lib/replyMetrics.ts';
import { searchAppStore } from '../netlify/lib/appStore.mjs';
import { acceptCampaignBatch, undoCampaignBatch } from '../src/discovery/campaignBatch.js';
import { continueCampaignSearch } from '../src/discovery/continueCampaign.js';
import { readCampaignEligibleSuggestions } from '../src/discovery/eligibleSuggestions.js';
import {
  DISCOVERY_UNCONFIGURED,
  continueDiscoveryJob,
  discoveryConfigured,
  pollDiscoveryJob,
  readServerEnv,
  startDiscoveryJob,
} from '../src/discovery/discoveryJobs.js';
import { apifyConfigured, createApifyPool } from '../src/discovery/apifyPool.js';
import {
  authoriseGmailSync,
  runGmailReplySync,
} from '../netlify/lib/gmailSync.mjs';
import {
  beginGmailOAuth,
  finishGmailOAuth,
  gmailConnectionStatus,
  gmailRedirectUri,
  gmailReturnOrigin,
  publicApiBase,
} from './gmailOAuth.js';
import {
  captureBootEnv,
  clientFromSupabase,
  ensureRuntimeSecrets,
  invalidateRuntimeSecrets,
} from '../src/config/runtimeSecrets.js';
import {
  handleApiKeysGet,
  handleApiKeysPut,
  handleApiKeysTest,
} from '../src/config/apiKeyHandlers.js';
import { ADMIN_ORIGINS, allowedAdminOrigin, DEFAULT_ADMIN_ORIGIN } from '../src/adminOrigins.js';
import { handler as avatarHandler } from '../netlify/functions/avatar.mjs';
import { handler as followUpHandler } from '../netlify/functions/follow-up-send.mjs';
import { handler as templateTestHandler } from '../netlify/functions/template-test.mjs';

/** Load .env / .env.local.secrets from package root and cwd (Windows-safe). */
function loadEnvFiles(): void {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dirs = [packageRoot, process.cwd()];
  const names = ['.env', '.env.local.secrets'];
  for (const dir of dirs) {
    for (const name of names) {
      const path = resolve(dir, name);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
    }
  }
}

loadEnvFiles();
captureBootEnv();

const PORT = Number(process.env.PORT ?? 3001);

if (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
  console.log('Supabase client ready (service role)');
} else {
  console.warn(
    'Supabase not configured on server — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in root .env (run: npm run sync:env)',
  );
}

const app = express();

const DEFAULT_CORS_ORIGINS = [...ADMIN_ORIGINS];

function corsOrigins(): Set<string> {
  const extra = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_CORS_ORIGINS, ...extra]);
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsOrigins().has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'x-webhook-secret'],
  }),
);
app.use(express.json({ limit: '1mb' }));

app.use(async (_req, _res, next) => {
  try {
    await ensureRuntimeSecrets();
  } catch {
    console.warn('[settings] could not refresh API keys');
  }
  next();
});

function optionalMinCreators(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return savedResultLimit(n);
}

function serviceClient() {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

registerAudienceBlastRoutes(app, serviceClient);

/** Heuristic fallback when Groq is unavailable. */
function classifyReplyHeuristic(replyText: string): ReplySentiment {
  const lower = replyText.toLowerCase();
  let label: ReplySentiment = 'Not Interested';
  if (/unsub|stop email|remove me/.test(lower)) label = 'Unsubscribe';
  else if (/price|rate|budget|how much|paid/.test(lower))
    label = 'Price Question';
  else if (/interest|love to|sounds good|keen|let'?s chat|yes/.test(lower))
    label = 'Interested';
  return parseReplyClassification(JSON.stringify({ sentiment: label }));
}

async function classifyReplyWithGroq(
  replyText: string,
): Promise<ReplySentiment> {
  if (!isGroqConfigured()) {
    return classifyReplyHeuristic(replyText);
  }
  try {
    const prompt = buildReplyClassificationPrompt(replyText);
    const { content } = await chatJson({
      system:
        'You classify creator email replies. Reply with JSON only: {"sentiment":"Interested"|"Not Interested"|"Price Question"|"Unsubscribe"}',
      user: prompt,
      temperature: 0.2,
    });
    return parseReplyClassification(content);
  } catch (err) {
    console.warn(
      '[email-reply] Groq classification failed, using heuristic:',
      err instanceof Error ? err.message : err,
    );
    return classifyReplyHeuristic(replyText);
  }
}

app.get('/api/app-store', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q.trim()) {
    res.status(400).json({ error: 'Enter an app name, bundle ID, or track ID.' });
    return;
  }
  try {
    const results = await searchAppStore(q);
    res.json({ ok: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'App Store lookup failed';
    res.status(502).json({ error: message });
  }
});

async function relayFunction(
  handler: (event: {
    httpMethod: string;
    body?: string;
    queryStringParameters?: Record<string, string>;
  }) => Promise<{
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
    isBase64Encoded?: boolean;
  }>,
  req: { method: string; body?: unknown; query: Record<string, unknown> },
  res: { status: (code: number) => { set: (h: Record<string, string>) => { send: (b: Buffer | string) => void } } },
) {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') query[key] = value;
  }
  const result = await handler({
    httpMethod: req.method,
    body: JSON.stringify(req.body ?? {}),
    queryStringParameters: query,
  });
  const headers = result.headers ?? { 'Content-Type': 'application/json' };
  const payload = result.isBase64Encoded
    ? Buffer.from(result.body || '', 'base64')
    : result.body || '';
  res.status(result.statusCode).set(headers).send(payload);
}

app.get('/api/avatars', async (req, res) => {
  await relayFunction(avatarHandler, req, res);
});

app.post('/api/follow-up', async (req, res) => {
  await relayFunction(followUpHandler, req, res);
});

app.post('/api/email/test', async (req, res) => {
  await relayFunction(templateTestHandler, req, res);
});

app.get('/api/discovery/jobs', (_req, res) => {
  const configured = discoveryConfigured();
  res.json({
    ok: true,
    configured,
    message: configured ? null : DISCOVERY_UNCONFIGURED,
  });
});

app.get('/api/discovery/credit', async (_req, res) => {
  const pool = createApifyPool();
  if (!pool.configured) {
    res.json({ ok: true, configured: false, credit: null });
    return;
  }
  const summary = await pool.creditSummary();
  res.json({
    ok: true,
    configured: true,
    credit: summary
      ? {
          remainingUsd: summary.remainingUsd,
          maxUsd: summary.maxUsd,
          usedUsd: summary.usedUsd,
          accountCount: summary.accountCount,
          accounts: summary.accounts,
        }
      : null,
  });
});

app.post('/api/discovery/jobs', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase is not configured on the server' });
    return;
  }
  const result = await startDiscoveryJob(sb, req.body);
  res.status(result.statusCode).json(result.body);
});

app.get('/api/discovery/jobs/:jobId', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase is not configured on the server' });
    return;
  }
  const result = await pollDiscoveryJob(sb, req.params.jobId);
  res.status(result.statusCode).json(result.body);
});

app.post('/api/discovery/jobs/:jobId/continue', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase is not configured on the server' });
    return;
  }
  const result = await continueDiscoveryJob(sb, req.params.jobId, req.body);
  res.status(result.statusCode).json(result.body);
});

app.get('/api/replies', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase is not configured on the server' });
    return;
  }
  let query = sb
    .from('email_replies')
    .select('*')
    .order('received_at', { ascending: false })
    .limit(100);
  const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : '';
  const appId = typeof req.query.appId === 'string' ? req.query.appId : '';
  if (campaignId) query = query.eq('campaign_id', campaignId);
  else if (appId) query = query.or(`app_id.eq.${appId},app_id.is.null`);
  const { data, error } = await query;
  if (error) {
    if (/email_replies|schema cache/i.test(error.message)) {
      res.json({ replies: [] });
      return;
    }
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ replies: data ?? [] });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    apifyConfigured: apifyConfigured(),
    groqConfigured: isGroqConfigured(),
    llmModel: process.env.LLM_MODEL?.trim() || null,
    supabaseConfigured: Boolean(
      process.env.SUPABASE_URL?.trim() &&
        process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    ),
    resendConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
    resendFrom: process.env.RESEND_FROM_EMAIL?.trim() || null,
    discordConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
    autopilot: true,
    tiktokActor:
      process.env.APIFY_TIKTOK_ACTOR ?? 'clockworks/tiktok-scraper',
    instagramActor:
      process.env.APIFY_INSTAGRAM_ACTOR ?? 'apify/instagram-scraper',
  });
});


/**
 * Create campaign — preferred path for admin UI after login.
 * Uses service role so INSERT succeeds even when JWT is authenticated
 * and only anon RLS policies exist (or before authenticated policies are applied).
 */
app.post('/api/campaigns', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase not configured on server' });
    return;
  }

  const body = req.body ?? {};
  const campaignType =
    typeof body.campaign_type === 'string'
      ? body.campaign_type.trim().toLowerCase()
      : 'discovery';

  if (campaignType === 'direct_blast') {
    const built = buildDirectBlastPayload(body);
    if (!built.ok) {
      res.status(400).json({ error: built.error });
      return;
    }
    const { data, error } = await sb
      .from('campaigns')
      .insert(built.payload)
      .select()
      .single();
    if (error) {
      console.error('[POST /api/campaigns] direct_blast', error.message);
      const status = /row-level security|permission denied|42501/i.test(error.message)
        ? 403
        : 500;
      res.status(status).json({ error: error.message });
      return;
    }
    res.status(201).json(data);
    return;
  }

  if (campaignType !== 'discovery') {
    res.status(400).json({ error: "campaign_type must be 'discovery' or 'direct_blast'" });
    return;
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const niches = Array.isArray(body.niches)
    ? body.niches.map((n: unknown) => String(n).trim().toLowerCase()).filter(Boolean)
    : [];
  const hashtags = Array.isArray(body.hashtags)
    ? normaliseHashtags(body.hashtags.map((tag: unknown) => String(tag)))
    : [];
  const platforms = Array.isArray(body.platforms)
    ? body.platforms.map((p: unknown) => String(p).trim().toLowerCase()).filter(Boolean)
    : [];

  if (platforms.length === 0) {
    res.status(400).json({ error: 'Select at least one platform (tiktok / instagram)' });
    return;
  }
  const allowedPlatforms = new Set(['tiktok', 'instagram']);
  if (platforms.some((p: string) => !allowedPlatforms.has(p))) {
    res.status(400).json({ error: 'platforms must be tiktok and/or instagram' });
    return;
  }

  const solisDefaultValueProp =
    'helps creators monetise short-form content without ads';
  const appName =
    (typeof body.app_name === 'string' && body.app_name.trim()) ||
    process.env.APP_NAME?.trim() ||
    'Solis';
  const valueProp =
    (typeof body.value_prop === 'string' && body.value_prop.trim()) ||
    process.env.APP_VALUE_PROP?.trim() ||
    solisDefaultValueProp;

  const followerMin =
    body.follower_min !== '' && body.follower_min != null
      ? Number(body.follower_min)
      : null;
  const followerMax =
    body.follower_max !== '' && body.follower_max != null
      ? Number(body.follower_max)
      : null;
  const engagementRateMin =
    body.engagement_rate_min !== '' && body.engagement_rate_min != null
      ? Number(body.engagement_rate_min)
      : null;
  const resultLimit =
    body.result_limit !== '' && body.result_limit != null
      ? Number(body.result_limit)
      : 10;

  const payload = {
    name,
    niches,
    hashtags,
    platforms,
    campaign_type: 'discovery',
    follower_min: Number.isFinite(followerMin as number) ? followerMin : null,
    follower_max: Number.isFinite(followerMax as number) ? followerMax : null,
    engagement_rate_min: Number.isFinite(engagementRateMin as number)
      ? engagementRateMin
      : null,
    result_limit: savedResultLimit(resultLimit),
    min_creators: optionalMinCreators(body.min_creators),
    auto_outreach: Boolean(body.auto_outreach),
    require_public_email: body.require_public_email !== false,
    include_crm_creators: body.include_crm_creators === true,
    is_autopilot_enabled: Boolean(body.is_autopilot_enabled),
    schedule_cron:
      typeof body.schedule_cron === 'string' && body.schedule_cron.trim()
        ? body.schedule_cron.trim()
        : '0 10 * * *',
    status: 'draft',
    app_name: appName,
    value_prop: valueProp,
    email_subject:
      typeof body.email_subject === 'string' && body.email_subject.trim()
        ? body.email_subject
        : null,
    email_body:
      typeof body.email_body === 'string' && body.email_body.trim()
        ? body.email_body
        : null,
    template_id:
      typeof body.template_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.template_id.trim())
        ? body.template_id.trim()
        : null,
    discovery_source:
      body.discovery_source === 'network' || body.discovery_source === 'hashtags'
        ? body.discovery_source
        : 'both',
  };

  const appId = typeof body.app_id === 'string' ? body.app_id.trim() : '';
  if (/^[0-9a-f-]{36}$/i.test(appId)) {
    (payload as { app_id?: string }).app_id = appId;
    const branding = await readAppBranding(sb, appId);
    if (branding.name) payload.app_name = branding.name;
    if (branding.valueProp) payload.value_prop = branding.valueProp;
  }

  const { data, error } = await sb
    .from('campaigns')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('[POST /api/campaigns]', error.message);
    const status = /row-level security|permission denied|42501/i.test(error.message)
      ? 403
      : 500;
    res.status(status).json({ error: error.message });
    return;
  }
  res.status(201).json(data);
});

app.post('/api/campaigns/:id/run', async (req, res) => {
  const campaignId = req.params.id;
  const provider = (req.body?.provider ?? 'apify') as DiscoveryProviderName;
  if (provider !== 'demo' && provider !== 'apify') {
    res.status(400).json({ error: 'provider must be "demo" or "apify"' });
    return;
  }

  try {
    const result = await runCampaign({
      campaignId,
      provider,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      resendApiKey: process.env.RESEND_API_KEY,
      resendFrom: process.env.RESEND_FROM_EMAIL,
      // Find creators never sends by itself. Auto-email on the campaign is the switch.
      // require_public_email still drops creators who have no usable public email.
      filterRequireEmail: false,
      filterEngagementMin: provider === 'apify',
      forceAutoOutreach: false,
      aiFallback: req.body?.aiFallback === true,
      ...(req.body?.source === 'network'
        ? { discoverySource: 'network' as const, skipOutreach: true }
        : {}),
    });
    res.json({ ok: result.ok !== false, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[POST /api/campaigns/:id/run]', message);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/campaigns/:id/stop', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase is not configured on the server' });
    return;
  }
  const { data, error } = await sb
    .from('discovery_jobs')
    .update({ status: 'stopping' })
    .eq('campaign_id', req.params.id)
    .eq('status', 'running')
    .select('id');
  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.json({ ok: true, stopping: (data ?? []).length });
});

app.get('/api/campaigns/:id/eligible-suggestions', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ ok: false, error: 'Supabase is not configured on the server' });
    return;
  }
  const result = await readCampaignEligibleSuggestions(sb, req.params.id);
  res.set('Cache-Control', 'no-store, max-age=0');
  res.status(result.statusCode).json(result.body);
});

app.post('/api/campaigns/:id/continue', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase is not configured on the server' });
    return;
  }
  const result = await continueCampaignSearch(sb, req.params.id, req.body);
  res.status(result.statusCode).json(result.body);
});

app.post('/api/campaigns/:id/accept-batch', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase is not configured on the server' });
    return;
  }
  const runId = typeof req.body?.runId === 'string' ? req.body.runId : null;
  const result =
    req.body?.undo === true
      ? await undoCampaignBatch(sb, req.params.id, runId)
      : await acceptCampaignBatch(sb, req.params.id, runId);
  res.status(result.statusCode).json(result.body);
});

function creatorVideos(raw: unknown): VideoCaption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const video = item as Record<string, unknown>;
    const caption = typeof video.caption === 'string' ? video.caption : null;
    const video_url = typeof video.video_url === 'string' ? video.video_url : null;
    const scraped_at = typeof video.scraped_at === 'string' ? video.scraped_at : null;
    if (!caption && !video_url) return [];
    return [{ caption, video_url, scraped_at }];
  });
}

/**
 * Fill {{video_hook}} for preview. Reads stored captions only — no Apify.
 * Caches the line and its provenance on the creator. Does not send email.
 */
app.post('/api/creators/video-hooks', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase not configured on server' });
    return;
  }
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== '').slice(0, 40)
    : [];
  const forceId = typeof req.body?.forceId === 'string' ? req.body.forceId : '';
  if (ids.length === 0) {
    res.status(400).json({ error: 'Provide creator ids' });
    return;
  }

  const { data, error } = await sb
    .from('creators')
    .select('id, handle, bio, top_videos, ai_variables, created_at')
    .in('id', ids);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const model = videoHookModel();
  const chat = isGroqConfigured()
    ? async (prompt: string) => {
        const result = await chatJson({
          system: VIDEO_HOOK_SYSTEM,
          user: prompt,
          temperature: 0.2,
          model,
          maxTokens: 512,
        });
        return result.content;
      }
    : null;

  const byId = new Map((data ?? []).map((row) => [String(row.id), row]));
  const hooks: Array<{
    id: string;
    text: string;
    source: string;
    basis: string;
    cached: boolean;
    edited: boolean;
    provenance: ReturnType<typeof emptyVideoHookProvenance>;
  }> = [];

  const hookPayload = (id: string, draft: VideoHookDraft) => ({
    id,
    text: draft.text,
    source: draft.source,
    basis: draft.basis,
    cached: draft.cached,
    edited: draft.edited,
    provenance: draft.provenance ?? emptyVideoHookProvenance(),
  });

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const vars = (row.ai_variables ?? {}) as Record<string, unknown>;
    const niches = Array.isArray(vars.niches) ? vars.niches.map(String) : [];
    const videos = creatorVideos(row.top_videos);
    const force = id === forceId;
    const draft = await fillVideoHook(
      {
        handle: typeof row.handle === 'string' ? row.handle : '',
        bio: typeof row.bio === 'string' ? row.bio : '',
        niches,
        videos,
        foundAt: typeof row.created_at === 'string' ? row.created_at : null,
        model: chat ? model : null,
        stored: vars,
        force,
      },
      chat,
    );

    if (!draft.cached) {
      const { data: fresh } = await sb
        .from('creators')
        .select('ai_variables')
        .eq('id', id)
        .maybeSingle();
      const freshVars = ((fresh?.ai_variables as Record<string, unknown> | null) ?? vars) || {};
      if (freshVars.video_hook_edited === true && !force) {
        const kept = readStoredVideoHook(freshVars);
        hooks.push({
          id,
          text: kept?.text || draft.text,
          source: kept?.source || draft.source,
          basis: kept?.basis || draft.basis,
          cached: true,
          edited: true,
          provenance: kept?.provenance ?? emptyVideoHookProvenance(),
        });
        continue;
      }
      const next = {
        ...freshVars,
        video_hook: draft.text,
        video_hook_source: draft.source,
        video_hook_basis: draft.basis,
        video_hook_edited: false,
        video_hook_version: VIDEO_HOOK_VERSION,
        video_hook_provenance: draft.provenance ?? emptyVideoHookProvenance(),
      };
      const { error: writeError } = await sb.from('creators').update({ ai_variables: next }).eq('id', id);
      if (writeError) {
        console.warn('[video-hook] could not cache opening line:', writeError.message);
      }
    }

    hooks.push(hookPayload(id, draft));
  }

  res.json({ hooks, model: chat ? model : null });
});

/**
 * Approve & Pitch Now — personalise + queue/send.
 */
app.post('/api/creators/:id/approve', async (req, res) => {
  const creatorId = req.params.id;
  const subject =
    typeof req.body?.subject === 'string' ? req.body.subject.slice(0, 300) : undefined;
  const body =
    typeof req.body?.body === 'string' ? req.body.body.slice(0, 20000) : undefined;
  try {
    const result = await approveAndPitchCreator({
      creatorId,
      resendApiKey: process.env.RESEND_API_KEY,
      resendFrom: process.env.RESEND_FROM_EMAIL,
      overrideSuppression: req.body?.override === true,
      subject,
      body,
      templateId: typeof req.body?.templateId === 'string' ? req.body.templateId : null,
    });
    res.json({ ok: result.ok, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[POST /api/creators/:id/approve]', message);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Patch creator hook / status (Edit AI Hook, Skip/Archive).
 */
app.patch('/api/creators/:id', async (req, res) => {
  const creatorId = req.params.id;
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase not configured on server' });
    return;
  }

  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};

  if (typeof body.outreach_status === 'string') {
    const allowed = [
      'pending',
      'pending_review',
      'queued',
      'sent',
      'replied',
      'archived',
    ];
    if (!allowed.includes(body.outreach_status)) {
      res.status(400).json({ error: 'Invalid outreach_status' });
      return;
    }
    updates.outreach_status = body.outreach_status;
  }

  if (typeof body.hook === 'string' || body.ai_variables) {
    const { data: existing } = await sb
      .from('creators')
      .select('ai_variables')
      .eq('id', creatorId)
      .maybeSingle();
    const prev = (existing?.ai_variables as Record<string, unknown>) ?? {};
    if (typeof body.hook === 'string') {
      updates.ai_variables = { ...prev, hook: body.hook };
    } else if (body.ai_variables && typeof body.ai_variables === 'object') {
      updates.ai_variables = {
        ...prev,
        ...(body.ai_variables as Record<string, unknown>),
      };
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No valid fields to update (hook / outreach_status)' });
    return;
  }

  const { data, error } = await sb
    .from('creators')
    .update(updates)
    .eq('id', creatorId)
    .select()
    .single();

  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.json({ ok: true, creator: data });
});

/**
 * Delete a CRM creator. outreach_logs cascade; email_replies.creator_id is set null.
 */
app.delete('/api/creators/:id', async (req, res) => {
  const creatorId = req.params.id;
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase not configured on server' });
    return;
  }
  const { error } = await sb.from('creators').delete().eq('id', creatorId);
  if (error) {
    console.error('[DELETE /api/creators/:id]', error.message);
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.json({ ok: true, id: creatorId });
});


/**
 * Patch campaign schedule + filter fields.
 * DELETE cascades discovery_runs; creators.campaign_id is SET NULL via FK.
 */
app.patch('/api/campaigns/:id', async (req, res) => {
  const campaignId = req.params.id;
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase not configured on server' });
    return;
  }

  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};

  if (typeof body.is_autopilot_enabled === 'boolean') {
    updates.is_autopilot_enabled = body.is_autopilot_enabled;
  }
  if (typeof body.schedule_cron === 'string' && body.schedule_cron.trim()) {
    updates.schedule_cron = body.schedule_cron.trim();
  }
  if (typeof body.auto_outreach === 'boolean') {
    updates.auto_outreach = body.auto_outreach;
  }
  if (typeof body.status === 'string') {
    updates.status = body.status;
  }
  if (typeof body.name === 'string' && body.name.trim()) {
    updates.name = body.name.trim();
  }
  if (Array.isArray(body.niches)) {
    updates.niches = body.niches
      .map((n: unknown) => String(n).trim().toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(body.hashtags)) {
    updates.hashtags = normaliseHashtags(body.hashtags.map((tag: unknown) => String(tag)));
  }
  if (Array.isArray(body.platforms)) {
    const platforms = body.platforms
      .map((p: unknown) => String(p).trim().toLowerCase())
      .filter(Boolean);
    const allowed = new Set(['tiktok', 'instagram']);
    if (platforms.length === 0 || platforms.some((p: string) => !allowed.has(p))) {
      res.status(400).json({ error: 'platforms must be tiktok and/or instagram' });
      return;
    }
    updates.platforms = platforms;
  }
  if (body.follower_min !== undefined) {
    const n =
      body.follower_min === null || body.follower_min === ''
        ? null
        : Number(body.follower_min);
    updates.follower_min = n != null && Number.isFinite(n) ? n : null;
  }
  if (body.follower_max !== undefined) {
    const n =
      body.follower_max === null || body.follower_max === ''
        ? null
        : Number(body.follower_max);
    updates.follower_max = n != null && Number.isFinite(n) ? n : null;
  }
  if (body.engagement_rate_min !== undefined) {
    const n =
      body.engagement_rate_min === null || body.engagement_rate_min === ''
        ? null
        : Number(body.engagement_rate_min);
    updates.engagement_rate_min = n != null && Number.isFinite(n) ? n : null;
  }
  if (typeof body.require_public_email === 'boolean') {
    updates.require_public_email = body.require_public_email;
  }
  if (typeof body.include_crm_creators === 'boolean') {
    updates.include_crm_creators = body.include_crm_creators;
  }
  if (body.result_limit !== undefined && body.result_limit !== '') {
    const n = Number(body.result_limit);
    if (Number.isFinite(n) && n > 0) updates.result_limit = savedResultLimit(n);
  }
  if (body.min_creators !== undefined) {
    updates.min_creators = optionalMinCreators(body.min_creators);
  }
  if (typeof body.app_name === 'string') {
    updates.app_name = body.app_name.trim() || null;
  }
  if (typeof body.value_prop === 'string') {
    updates.value_prop = body.value_prop.trim() || null;
  }
  if (typeof body.email_subject === 'string') {
    updates.email_subject = body.email_subject;
  }
  if (typeof body.email_body === 'string') {
    updates.email_body = body.email_body;
  }
  if (typeof body.template_id === 'string') {
    const templateId = body.template_id.trim();
    updates.template_id = /^[0-9a-f-]{36}$/i.test(templateId) ? templateId : null;
  } else if (body.template_id === null) {
    updates.template_id = null;
  }
  if (typeof body.audience_group_id === 'string') {
    updates.audience_group_id = body.audience_group_id.trim() || null;
  } else if (body.audience_group_id === null) {
    updates.audience_group_id = null;
  }
  if (
    body.discovery_source === 'network' ||
    body.discovery_source === 'hashtags' ||
    body.discovery_source === 'both'
  ) {
    updates.discovery_source = body.discovery_source;
  }
  if (typeof body.campaign_type === 'string') {
    const ct = body.campaign_type.trim().toLowerCase();
    if (ct === 'discovery' || ct === 'direct_blast') {
      updates.campaign_type = ct;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({
      error:
        'No valid fields (schedule, name, niches, platforms, followers, eng, result_limit, ...)',
    });
    return;
  }

  const { data, error } = await sb
    .from('campaigns')
    .update(updates)
    .eq('id', campaignId)
    .select()
    .single();

  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.json({ ok: true, campaign: data });
});

/**
 * Delete campaign row. FK: discovery_runs CASCADE; creators.campaign_id SET NULL.
 */
app.delete('/api/campaigns/:id', async (req, res) => {
  const campaignId = req.params.id;
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase not configured on server' });
    return;
  }

  const { error } = await sb.from('campaigns').delete().eq('id', campaignId);
  if (error) {
    console.error('[DELETE /api/campaigns/:id]', error.message);
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  res.json({
    ok: true,
    id: campaignId,
    note: 'Deleted campaign; discovery_runs cascaded; creators.campaign_id set null',
  });
});

/**
 * Manual autopilot trigger — discovery + forced outreach now.
 */
app.post('/api/campaigns/:id/autopilot/run', async (req, res) => {
  const campaignId = req.params.id;
  try {
    const result = await runAutopilotForCampaign(campaignId, { force: true });
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[POST /api/campaigns/:id/autopilot/run]', message);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * Reply webhook — classify via Groq (+ heuristic fallback) + Discord + set replied.
 */
app.post('/api/webhooks/email-reply', async (req, res) => {
  const secret = process.env.WEBHOOK_SHARED_SECRET ?? '';
  const auth = req.header('authorization') ?? '';
  const headerSecret = req.header('x-webhook-secret') ?? '';
  if (secret) {
    const ok = auth === `Bearer ${secret}` || headerSecret === secret;
    if (!ok) {
      res.status(401).json({ error: 'Unauthorised' });
      return;
    }
  }

  const replyText = String(
    req.body?.replyText ?? req.body?.text ?? req.body?.body ?? '',
  );
  const creatorId = String(req.body?.creatorId ?? req.body?.creator_id ?? '');
  let handle = String(req.body?.handle ?? '');
  let platform = String(req.body?.platform ?? '');

  if (!replyText.trim()) {
    res.status(400).json({ error: 'replyText required' });
    return;
  }

  let sentiment: ReplySentiment;
  try {
    sentiment = await classifyReplyWithGroq(replyText);
  } catch {
    sentiment = 'Not Interested';
  }

  const sb = serviceClient();
  if (creatorId && sb) {
    await sb
      .from('creators')
      .update({ outreach_status: 'replied' })
      .eq('id', creatorId);

    if (!handle || !platform) {
      const { data } = await sb
        .from('creators')
        .select('handle, platform')
        .eq('id', creatorId)
        .maybeSingle();
      if (data) {
        handle = handle || String(data.handle ?? '');
        platform = platform || String(data.platform ?? '');
      }
    }
  }

  const discord = sb ? await loadDiscordSettings(sb) : null;
  const discordUrl = discord?.webhookUrl || '';
  if (
    discordUrl &&
    discord?.notifyReplies &&
    (sentiment === 'Interested' || sentiment === 'Price Question')
  ) {
    try {
      await notifyDiscord(
        discordUrl,
        replyDiscordPayload({
          handle: handle || 'unknown',
          platform: platform || '',
          campaignName: sentiment === 'Price Question' ? 'Price question' : '',
          snippet: replySnippet([replyText]),
          receivedAt: new Date().toISOString(),
          creatorId: creatorId || null,
          adminBaseUrl: process.env.ADMIN_BASE_URL,
        }),
      );
    } catch (err) {
      console.warn('[email-reply] Discord failed', err);
    }
  }

  res.json({ ok: true, sentiment });
});


const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function emailTemplatePath(): string {
  return (
    process.env.EMAIL_TEMPLATE_PATH?.trim() ||
    resolve(packageRoot, 'data/email-template.md')
  );
}

const BUILTIN_EMAIL_TEMPLATE = `Hi {{creator_handle}},

{{hook}}

I'm reaching out from {{app_name}} -- {{value_prop}}.

Would you be open to a short-form collab? Happy to share brief, deliverables, and budget if you're interested.

Reply to this email and we'll take it from there.

Cheers,
{{app_name}} team`;

/** Read cold-email body template (env -> file -> builtin). */
app.get('/api/email-template', (_req, res) => {
  const inline = process.env.EMAIL_TEMPLATE?.trim();
  if (inline) {
    res.json({ source: 'env', template: inline });
    return;
  }
  const path = emailTemplatePath();
  if (existsSync(path)) {
    try {
      const template = readFileSync(path, 'utf8');
      res.json({ source: 'file', path, template });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
      return;
    }
  }
  res.json({ source: 'builtin', template: BUILTIN_EMAIL_TEMPLATE });
});

/** Persist cold-email body to data/email-template.md */
app.post('/api/email-template', (req, res) => {
  const template =
    typeof req.body?.template === 'string' ? req.body.template : '';
  if (!template.trim()) {
    res.status(400).json({ error: 'template is required' });
    return;
  }
  try {
    const path = emailTemplatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template, 'utf8');
    res.json({ ok: true, source: 'file', path });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * Outreach analytics from creators + outreach_logs.
 * Open rate is null without Resend open webhooks.
 */
app.get('/api/analytics', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ error: 'Supabase not configured on server' });
    return;
  }

  try {
    const appId = typeof req.query.appId === 'string' ? req.query.appId.trim() : '';
    let creatorsQuery = sb
      .from('creators')
      .select('id, email, outreach_status, campaign_id');
    let campaignsQuery = sb.from('campaigns').select('id, name');
    if (appId) {
      creatorsQuery = creatorsQuery.eq('app_id', appId);
      campaignsQuery = campaignsQuery.eq('app_id', appId);
    }
    const [
      { data: creators, error: cErr },
      { data: campaigns, error: campErr },
    ] = await Promise.all([creatorsQuery, campaignsQuery]);
    if (cErr) throw cErr;
    if (campErr) throw campErr;

    const creatorIds = (creators ?? []).map((c) => c.id as string);
    let logs: Array<{ sent_at?: string | null }> = [];
    if (creatorIds.length) {
      const { data: logRows, error: lErr } = await sb
        .from('outreach_logs')
        .select('id, creator_id, sent_at, provider')
        .in('creator_id', creatorIds);
      if (lErr) throw lErr;
      logs = logRows ?? [];
    }

    let blastQuery = sb.from('blast_sends').select('status, email, replied_at');
    if (appId) blastQuery = blastQuery.eq('app_id', appId);
    const withReply = await blastQuery;
    let blastRows: Array<{
      status?: string | null;
      email?: string | null;
      replied_at?: string | null;
    }> = [];
    if (!withReply.error) {
      blastRows = withReply.data ?? [];
    } else {
      let plainQuery = sb.from('blast_sends').select('status');
      if (appId) plainQuery = plainQuery.eq('app_id', appId);
      const plain = await plainQuery;
      if (plain.error) console.warn('[analytics] blast_sends:', plain.error.message);
      else blastRows = plain.data ?? [];
    }

    const summary = summariseReplyMetrics({
      creators: creators ?? [],
      logs,
      blastRows,
    });
    const sentStatuses = new Set(['sent', 'replied']);
    const sentCreators = (creators ?? []).filter((c) =>
      sentStatuses.has(String(c.outreach_status)),
    );
    const { totalSent, replyRate, replied } = summary;

    const sentByCampaign = new Map<string, number>();
    for (const c of sentCreators) {
      const cid = c.campaign_id as string | null;
      if (!cid) continue;
      sentByCampaign.set(cid, (sentByCampaign.get(cid) ?? 0) + 1);
    }
    let topCampaign: { id: string; name: string; sent: number } | null = null;
    const nameById = new Map(
      (campaigns ?? []).map((c) => [c.id as string, String(c.name)]),
    );
    for (const [id, sent] of sentByCampaign) {
      if (!topCampaign || sent > topCampaign.sent) {
        topCampaign = {
          id,
          name: nameById.get(id) ?? 'Unknown',
          sent,
        };
      }
    }

    res.json({
      ok: true,
      totalSent,
      openRate: null,
      openRateLabel: '\u2014',
      openRateNote: 'Open tracking requires Resend webhooks (not wired)',
      replyRate,
      replied,
      topPerformingCampaign: topCampaign,
      blastSent: summary.blastSent,
      blastFailed: summary.blastFailed,
      blastOpened: summary.blastOpened,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[GET /api/analytics]', message);
    res.status(500).json({ ok: false, error: message });
  }
});

function adminAppBase(preferred?: string | null): string {
  const fromReturn = allowedAdminOrigin(preferred);
  if (fromReturn) return fromReturn;
  const configured = process.env.ADMIN_BASE_URL?.trim().replace(/\/$/, '') || '';
  if (configured.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(configured)) {
    return configured;
  }
  return DEFAULT_ADMIN_ORIGIN;
}

function requestApiBase(req: express.Request): string {
  const host = req.get('host') || `localhost:${PORT}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return publicApiBase(`${proto}://${host}`);
}

app.get('/api/integrations/gmail', async (_req, res) => {
  const status = await gmailConnectionStatus(serviceClient());
  res.json({ ok: true, ...status });
});

app.get('/api/gmail/oauth/start', (req, res) => {
  const returnTo = typeof req.query.return === 'string' ? req.query.return : '';
  const started = beginGmailOAuth(requestApiBase(req), returnTo);
  if ('error' in started) {
    const reason = encodeURIComponent(started.error);
    res.redirect(`${adminAppBase(returnTo)}/connectors?gmail=error&reason=${reason}`);
    return;
  }
  res.redirect(started.url);
});

app.get('/api/gmail/oauth/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const admin = adminAppBase(gmailReturnOrigin(state));
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
  const sb = serviceClient();
  if (oauthError || !code || !state || !sb) {
    const reason = encodeURIComponent(
      oauthError || 'Gmail did not return an authorisation code.',
    );
    res.redirect(`${admin}/connectors?gmail=error&reason=${reason}`);
    return;
  }
  try {
    const done = await finishGmailOAuth(sb, requestApiBase(req), code, state);
    const back = adminAppBase(done.returnOrigin);
    res.redirect(`${back}/connectors?gmail=connected`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gmail connection failed.';
    res.redirect(`${admin}/connectors?gmail=error&reason=${encodeURIComponent(message)}`);
  }
});

/**
 * Poll the outreach Gmail mailbox and mark matching leads replied.
 * Discovery and autopilot stay on their existing Express routes.
 * 503 when Gmail OAuth is not configured — not a fake success.
 */
app.all('/api/gmail/sync-replies', async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  const sb = serviceClient();
  if (!sb) {
    console.error('[gmail-reply-sync] Supabase not configured on server');
    res.status(500).json({ ok: false, error: 'Supabase not configured on server' });
    return;
  }
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value;
  }
  const auth = await authoriseGmailSync({
    headers,
    supabase: sb,
    env: process.env,
  });
  if (!auth.ok) {
    res.status(401).json({ ok: false, error: auth.error });
    return;
  }
  const result = await runGmailReplySync(sb, process.env);
  if (!result.ok) {
    console.error('[gmail-reply-sync]', result.error);
    res.status(result.status || 500).json({ ok: false, error: result.error });
    return;
  }
  console.log(
    `[gmail-reply-sync] scanned=${result.scanned} markedCreators=${result.markedCreators} markedBlasts=${result.markedBlasts}`,
  );
  try {
    const notified = await notifyUnsentReplies(sb);
    if (notified) console.log(`[gmail-reply-sync] discord replies=${notified}`);
  } catch (err) {
    console.warn(
      '[gmail-reply-sync] discord replies failed:',
      err instanceof Error ? err.message : err,
    );
  }
  res.json(result);
});

function requestHeaders(req: express.Request): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

function discordPublic(settings: Awaited<ReturnType<typeof loadDiscordSettings>>) {
  return {
    ok: true,
    configured: Boolean(settings.webhookUrl),
    maskedUrl: maskWebhookUrl(settings.webhookUrl),
    usingEnv: settings.usingEnvFallback,
    notifyReplies: settings.notifyReplies,
    notifyCreators: settings.notifyCreators,
    notifySent: settings.notifySent,
  };
}

app.get('/api/integrations/discord', async (_req, res) => {
  const settings = await loadDiscordSettings(serviceClient());
  res.json(discordPublic(settings));
});

app.post('/api/integrations/discord', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ ok: false, error: 'Supabase not configured on server' });
    return;
  }
  const auth = await authoriseGmailSync({
    headers: requestHeaders(req),
    supabase: sb,
    env: process.env,
  });
  if (!auth.ok) {
    res.status(401).json({ ok: false, error: auth.error || 'Sign in to save Discord.' });
    return;
  }
  const webhookUrl = typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
  if (webhookUrl && !isDiscordWebhook(webhookUrl)) {
    res.status(400).json({ ok: false, error: 'Paste a Discord webhook URL.' });
    return;
  }
  try {
    await saveDiscordSettings(sb, {
      webhookUrl,
      notifyReplies: req.body?.notifyReplies !== false,
      notifyCreators: req.body?.notifyCreators === true,
      notifySent: req.body?.notifySent === true,
    });
    invalidateRuntimeSecrets();
    await ensureRuntimeSecrets({ force: true });
    res.json(discordPublic(await loadDiscordSettings(sb)));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not save Discord.';
    res.status(400).json({ ok: false, error: message });
  }
});

app.post('/api/integrations/discord/test', async (req, res) => {
  const sb = serviceClient();
  if (!sb) {
    res.status(500).json({ ok: false, error: 'Supabase not configured on server' });
    return;
  }
  const auth = await authoriseGmailSync({
    headers: requestHeaders(req),
    supabase: sb,
    env: process.env,
  });
  if (!auth.ok) {
    res.status(401).json({ ok: false, error: auth.error || 'Sign in to send a test.' });
    return;
  }
  const override = typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
  const settings = await loadDiscordSettings(sb);
  const url = override || settings.webhookUrl;
  if (!url || !isDiscordWebhook(url)) {
    res.status(400).json({ ok: false, error: 'Save a Discord webhook first.' });
    return;
  }
  try {
    await notifyDiscord(url, testDiscordPayload());
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discord test failed.';
    res.status(502).json({ ok: false, error: message });
  }
});

function gmailCallbackUrl(req: express.Request): string {
  const host = `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`;
  return gmailRedirectUri(publicApiBase(host));
}

app.get('/api/settings/keys', async (req, res) => {
  const sb = clientFromSupabase(serviceClient());
  if (!sb) {
    res.status(500).json({ ok: false, error: 'Supabase is not configured on the server.' });
    return;
  }
  const result = await handleApiKeysGet(sb, req.header('authorization'), gmailCallbackUrl(req));
  res.status(result.status).json(result.body);
});

app.put('/api/settings/keys', async (req, res) => {
  const sb = clientFromSupabase(serviceClient());
  if (!sb) {
    res.status(500).json({ ok: false, error: 'Supabase is not configured on the server.' });
    return;
  }
  const result = await handleApiKeysPut(sb, req.header('authorization'), req.body);
  res.status(result.status).json(result.body);
});

app.post('/api/settings/keys/test', async (req, res) => {
  const sb = clientFromSupabase(serviceClient());
  if (!sb) {
    res.status(500).json({ ok: false, error: 'Supabase is not configured on the server.' });
    return;
  }
  const result = await handleApiKeysTest(sb, req.header('authorization'), req.body);
  res.status(result.status).json(result.body);
});

const HOST = process.env.HOST?.trim() || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Creator outreach API listening on http://${HOST}:${PORT}`);
  startAutopilotScheduler();
});
