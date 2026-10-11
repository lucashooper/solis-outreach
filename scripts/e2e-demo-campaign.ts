/**
 * End-to-end demo: create a campaign + run demo discovery against real Supabase.
 *
 * Usage (from repo root, with secrets in env or .env.local.secrets):
 *   npx tsx --env-file=.env.local.secrets scripts/e2e-demo-campaign.ts
 *
 * Or: npm run e2e:demo
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { runCampaign } from '../src/pipeline/runCampaign.js';

function loadSecretsFile(): void {
  const path = resolve(process.cwd(), '.env.local.secrets');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
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
    if (!process.env[key]) process.env[key] = val;
  }
}

loadSecretsFile();

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const name = `E2E Demo ${new Date().toISOString()}`;
  const { data: campaign, error } = await sb
    .from('campaigns')
    .insert({
      name,
      niches: ['fitness', 'beauty', 'tech'],
      platforms: ['tiktok', 'instagram'],
      follower_min: 10000,
      follower_max: 500000,
      engagement_rate_min: null,
      result_limit: 20,
      auto_outreach: false,
      status: 'draft',
      app_name: process.env.APP_NAME ?? 'YourApp',
      value_prop:
        process.env.APP_VALUE_PROP ??
        'helps creators monetise short-form content without ads',
    })
    .select('*')
    .single();

  if (error || !campaign) {
    throw new Error(`Failed to create campaign: ${error?.message}`);
  }

  console.log('Created campaign', campaign.id, campaign.name);

  const result = await runCampaign({
    campaignId: campaign.id,
    provider: 'demo',
    supabase: sb,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    dryRunOutreach: true,
  });

  console.log(JSON.stringify(result, null, 2));

  const { count } = await sb
    .from('creators')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id);

  console.log(`Creators linked to campaign: ${count}`);
  if ((count ?? 0) < 1) {
    process.exitCode = 1;
    console.error('Expected at least one creator upserted');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
