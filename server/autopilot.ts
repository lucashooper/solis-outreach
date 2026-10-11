/**
 * Campaign autopilot — master minute tick in Europe/London.
 * Loads campaigns with is_autopilot_enabled, matches schedule_cron, dedupes via
 * autopilot_last_run_at, then runs discovery + forced auto-outreach.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CronExpressionParser } from 'cron-parser';
import cron from 'node-cron';
import { runCampaign } from '../src/pipeline/runCampaign.js';
import { emailsSentPayload, loadDiscordSettings, notifyUnsentReplies } from '../src/pipeline/discordNotify.js';
import { notifyDiscord } from '../src/pipeline/outreach.js';
import { apifyConfigured } from '../src/discovery/apifyPool.js';
import type { DiscoveryProviderName } from '../src/discovery/types.js';
import { runGmailReplySync } from '../netlify/lib/gmailSync.mjs';
import { ensureRuntimeSecrets } from '../src/config/runtimeSecrets.js';

const TZ = 'Europe/London';

export interface AutopilotCampaignRow {
  id: string;
  name: string;
  schedule_cron: string;
  autopilot_last_run_at: string | null;
  engagement_rate_min: number | null;
}

function serviceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url.trim() || !key.trim()) return null;
  return createClient(url.trim(), key.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * True when the cron's previous fire time falls within the current minute
 * (Europe/London) and we have not already recorded a run for that slot.
 */
export function isAutopilotDue(
  scheduleCron: string,
  lastRunAt: string | null,
  now: Date = new Date(),
): boolean {
  try {
    const interval = CronExpressionParser.parse(scheduleCron, {
      currentDate: now,
      tz: TZ,
    });
    const prev = interval.prev().toDate();
    const ageMs = now.getTime() - prev.getTime();
    // Within ~90s of the scheduled minute
    if (ageMs < 0 || ageMs > 90_000) return false;
    if (lastRunAt) {
      const last = new Date(lastRunAt).getTime();
      if (!Number.isNaN(last) && last >= prev.getTime()) return false;
    }
    return true;
  } catch (err) {
    console.warn(
      '[autopilot] invalid schedule_cron:',
      scheduleCron,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export function resolveAutopilotProvider(): {
  provider: DiscoveryProviderName;
  reason: string;
} {
  if (apifyConfigured()) {
    return { provider: 'apify', reason: 'Apify account connected' };
  }
  return { provider: 'demo', reason: 'no Apify account — using demo' };
}

/**
 * Run one autopilot cycle for a campaign (also used by manual POST trigger).
 */
export async function runAutopilotForCampaign(
  campaignId: string,
  options: { force?: boolean } = {},
): Promise<{
  ok: boolean;
  provider: DiscoveryProviderName;
  sent: number;
  campaignName: string;
  error?: string;
  result?: Record<string, unknown>;
}> {
  const sb = serviceClient();
  if (!sb) {
    return {
      ok: false,
      provider: 'demo',
      sent: 0,
      campaignName: '',
      error: 'Supabase not configured on server',
    };
  }

  const { data: row, error } = await sb
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (error || !row) {
    return {
      ok: false,
      provider: 'demo',
      sent: 0,
      campaignName: '',
      error: error?.message ?? 'Campaign not found',
    };
  }

  const { provider, reason } = resolveAutopilotProvider();
  console.log(
    `[autopilot] Running campaign "${row.name}" (${campaignId}) provider=${provider} (${reason})`,
  );

  try {
    const subject = String(row.email_subject || '').trim();
    const templateBody = String(row.email_body || '').trim();
    const hasTemplate =
      Boolean(String(row.template_id || '').trim()) || Boolean(subject && templateBody);
    const autoEmail = row.auto_outreach === true && hasTemplate;
    const result = await runCampaign({
      campaignId,
      provider,
      // Daily Auto-Run discovers on its schedule. It sends only when Auto-email is on.
      forceAutoOutreach: false,
      filterRequireEmail: autoEmail,
      filterEngagementMin: true,
      discordWebhookUrl: (await loadDiscordSettings(sb)).webhookUrl,
      resendApiKey: process.env.RESEND_API_KEY,
      resendFrom: process.env.RESEND_FROM_EMAIL,
    });

    await sb
      .from('campaigns')
      .update({ autopilot_last_run_at: new Date().toISOString() })
      .eq('id', campaignId);

    const discord = await loadDiscordSettings(sb);
    if (discord.webhookUrl && discord.notifySent) {
      try {
        await notifyDiscord(
          discord.webhookUrl,
          emailsSentPayload({ campaignName: String(row.name ?? ''), sent: result.sent }),
        );
      } catch (err) {
        console.warn(
          '[autopilot] Discord notify failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    return {
      ok: true,
      provider,
      sent: result.sent,
      campaignName: row.name,
      result: { ...result },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[autopilot] Failed for ${campaignId}:`, message);
    if (!options.force) {
      /* still mark attempt? — leave last_run unset so retry next minute if still due */
    }
    return {
      ok: false,
      provider,
      sent: 0,
      campaignName: String(row.name ?? ''),
      error: message,
    };
  }
}

const GMAIL_SYNC_GAP_MS = 5 * 60 * 1000;
let lastGmailSyncAt = 0;

/** Poll the outreach mailbox every five minutes once the API process is up. */
async function maybeSyncGmail(sb: SupabaseClient): Promise<void> {
  const now = Date.now();
  if (now - lastGmailSyncAt < GMAIL_SYNC_GAP_MS) return;
  lastGmailSyncAt = now;
  try {
    const result = await runGmailReplySync(sb, process.env);
    if (!result.ok) {
      console.warn('[autopilot] gmail sync:', result.error);
      return;
    }
    console.log(
      `[autopilot] gmail sync scanned=${result.scanned} markedCreators=${result.markedCreators ?? 0} markedBlasts=${result.markedBlasts}`,
    );
    const notified = await notifyUnsentReplies(sb);
    if (notified) console.log(`[autopilot] discord replies=${notified}`);
  } catch (err) {
    console.warn(
      '[autopilot] gmail sync failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

async function tick(): Promise<void> {
  await ensureRuntimeSecrets();
  const sb = serviceClient();
  if (!sb) {
    return;
  }

  await maybeSyncGmail(sb);

  const { data, error } = await sb
    .from('campaigns')
    .select('id, name, schedule_cron, autopilot_last_run_at, engagement_rate_min')
    .eq('is_autopilot_enabled', true);

  if (error) {
    console.warn('[autopilot] Failed to load campaigns:', error.message);
    return;
  }

  const now = new Date();
  for (const row of (data ?? []) as AutopilotCampaignRow[]) {
    const cronExpr = row.schedule_cron || '0 10 * * *';
    if (!isAutopilotDue(cronExpr, row.autopilot_last_run_at, now)) continue;
    console.log(`[autopilot] Due: ${row.name} (${cronExpr})`);
    await runAutopilotForCampaign(row.id);
  }
}

let started = false;

/** Start the master minute tick (idempotent). */
export function startAutopilotScheduler(): void {
  if (started) return;
  started = true;

  if (!cron.validate('* * * * *')) {
    console.error('[autopilot] Invalid master cron — scheduler not started');
    return;
  }

  cron.schedule(
    '* * * * *',
    () => {
      void tick().catch((err) => {
        console.error(
          '[autopilot] tick error:',
          err instanceof Error ? err.message : err,
        );
      });
    },
    { timezone: TZ },
  );

  console.log(
    `[autopilot] Scheduler started (tick every minute, tz=${TZ})`,
  );
}
