import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_ADMIN_ORIGIN } from '../adminOrigins.js';
import { notifyDiscord, type DiscordMessagePayload } from './outreach.js';

const URL_KEY = 'discord_webhook_url';
const REPLIES_KEY = 'discord_notify_replies';
const CREATORS_KEY = 'discord_notify_creators';
const SENT_KEY = 'discord_notify_sent';
const SECRET_KEYS = [URL_KEY, REPLIES_KEY, CREATORS_KEY, SENT_KEY];

export interface DiscordSettings {
  webhookUrl: string;
  notifyReplies: boolean;
  notifyCreators: boolean;
  notifySent: boolean;
  hasStoredWebhook: boolean;
  usingEnvFallback: boolean;
}

export function discordFlag(value: string | null | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1' || normalised === 'yes') return true;
  if (normalised === 'false' || normalised === '0' || normalised === 'no') return false;
  return fallback;
}

export function isDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'discord.com' && host !== 'discordapp.com' && host !== 'canary.discord.com') {
      return false;
    }
    return /\/api\/webhooks\/\d+\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Host and a shortened id. The webhook token is never returned. */
export function maskWebhookUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const id = parts.length >= 2 ? parts[parts.length - 2] : '';
    const short = id.length > 4 ? `${id.slice(0, 2)}…${id.slice(-2)}` : 'saved';
    return `${parsed.origin}/api/webhooks/${short}/••••`;
  } catch {
    return 'Webhook saved';
  }
}

export function adminNotifyBase(): string {
  const configured = (process.env.ADMIN_BASE_URL ?? '').trim().replace(/\/$/, '');
  if (configured.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(configured)) {
    return configured;
  }
  return DEFAULT_ADMIN_ORIGIN;
}

export function replySnippet(parts: Array<string | null | undefined>, max = 200): string {
  const text = parts
    .map((part) => (part ?? '').replace(/\s+/g, ' ').trim())
    .find((part) => part.length > 0);
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function platformLabel(platform: string): string {
  const value = platform.trim().toLowerCase();
  if (value === 'tiktok') return 'TikTok';
  if (value === 'instagram') return 'Instagram';
  return platform.trim() || '—';
}

export function replyDiscordPayload(input: {
  handle: string;
  platform: string;
  campaignName: string;
  snippet: string;
  receivedAt: string | null;
  creatorId: string | null;
  adminBaseUrl?: string;
}): DiscordMessagePayload {
  const base = (input.adminBaseUrl?.trim() || adminNotifyBase()).replace(/\/$/, '');
  const url = input.creatorId ? `${base}/crm?creator=${encodeURIComponent(input.creatorId)}` : `${base}/crm`;
  const handle = input.handle.replace(/^@/, '').trim() || 'unknown';
  const when = input.receivedAt
    ? new Date(input.receivedAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })
    : '—';
  return {
    embeds: [
      {
        title: `Reply from @${handle}`,
        url,
        description: input.snippet.trim() || 'No message text.',
        color: 0x5b8def,
        fields: [
          { name: 'Platform', value: platformLabel(input.platform), inline: true },
          { name: 'Campaign', value: input.campaignName.trim() || '—', inline: true },
          { name: 'Received', value: when, inline: false },
        ],
      },
    ],
  };
}

export function creatorsFoundPayload(input: {
  campaignName: string;
  found: number;
  autoOutreach: boolean;
  readyOrPendingCount: number;
}): DiscordMessagePayload {
  const status = input.autoOutreach ? 'Ready to send' : 'Pending review';
  return {
    embeds: [
      {
        title: 'Creators found',
        description: input.campaignName.trim() || 'Discovery',
        color: 0x5b8def,
        fields: [
          { name: 'Found', value: String(input.found), inline: true },
          { name: status, value: String(input.readyOrPendingCount), inline: true },
        ],
      },
    ],
  };
}

export function emailsSentPayload(input: {
  campaignName: string;
  sent: number;
}): DiscordMessagePayload {
  return {
    embeds: [
      {
        title: 'Emails sent',
        description: input.campaignName.trim() || 'Campaign',
        color: 0x34d399,
        fields: [{ name: 'Sent', value: String(input.sent), inline: true }],
      },
    ],
  };
}

export function testDiscordPayload(): DiscordMessagePayload {
  return {
    embeds: [
      {
        title: 'Solis Outreach',
        description: 'Discord is connected. This is a test from Connectors.',
        color: 0x5b8def,
      },
    ],
  };
}

function envWebhook(): string {
  return (process.env.DISCORD_WEBHOOK_URL ?? '').trim();
}

export async function loadDiscordSettings(
  sb: SupabaseClient | null,
): Promise<DiscordSettings> {
  const fallback = envWebhook();
  const empty: DiscordSettings = {
    webhookUrl: fallback,
    notifyReplies: true,
    notifyCreators: true,
    notifySent: true,
    hasStoredWebhook: false,
    usingEnvFallback: Boolean(fallback),
  };
  if (!sb) return empty;
  try {
    const { data, error } = await sb
      .from('integration_secrets')
      .select('key, value')
      .in('key', SECRET_KEYS);
    if (error || !data) return empty;
    const byKey = new Map<string, string>();
    for (const row of data as Array<{ key?: string; value?: string }>) {
      if (row.key) byKey.set(row.key, String(row.value ?? ''));
    }
    const stored = (byKey.get(URL_KEY) ?? '').trim();
    const webhookUrl = stored || fallback;
    return {
      webhookUrl,
      notifyReplies: discordFlag(byKey.get(REPLIES_KEY), true),
      notifyCreators: discordFlag(byKey.get(CREATORS_KEY), true),
      notifySent: discordFlag(byKey.get(SENT_KEY), true),
      hasStoredWebhook: Boolean(stored),
      usingEnvFallback: !stored && Boolean(fallback),
    };
  } catch {
    return empty;
  }
}

export async function saveDiscordSettings(
  sb: SupabaseClient,
  input: {
    webhookUrl?: string;
    notifyReplies: boolean;
    notifyCreators: boolean;
    notifySent: boolean;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const rows: Array<{ key: string; value: string; updated_at: string }> = [
    { key: REPLIES_KEY, value: input.notifyReplies ? 'true' : 'false', updated_at: now },
    { key: CREATORS_KEY, value: input.notifyCreators ? 'true' : 'false', updated_at: now },
    { key: SENT_KEY, value: input.notifySent ? 'true' : 'false', updated_at: now },
  ];
  const webhook = input.webhookUrl?.trim() ?? '';
  if (webhook) {
    if (!isDiscordWebhook(webhook)) {
      throw new Error('Paste a Discord webhook URL.');
    }
    rows.push({ key: URL_KEY, value: webhook, updated_at: now });
  }
  const { error } = await sb.from('integration_secrets').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}

type Joined<T> = T | T[] | null;

function first<T>(value: Joined<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

interface UnnotifiedReply {
  id: string;
  snippet: string | null;
  body: string | null;
  body_text: string | null;
  received_at: string | null;
  creator_id: string | null;
  from_email: string | null;
  from_name: string | null;
  creators: Joined<{ handle: string; platform: string }>;
  campaigns: Joined<{ name: string }>;
}

/**
 * Post one embed per new email reply, then stamp notified_at.
 * Rows that fail to post are left unstamped so the next sync can retry.
 */
export async function notifyUnsentReplies(sb: SupabaseClient): Promise<number> {
  const settings = await loadDiscordSettings(sb);
  if (!settings.webhookUrl || !settings.notifyReplies || !isDiscordWebhook(settings.webhookUrl)) {
    return 0;
  }

  const { data, error } = await sb
    .from('email_replies')
    .select(
      'id, snippet, body, body_text, received_at, creator_id, from_email, from_name, creators(handle, platform), campaigns(name)',
    )
    .is('notified_at', null)
    .order('received_at', { ascending: true })
    .limit(8);
  if (error || !data?.length) return 0;

  let sent = 0;
  for (const row of data as unknown as UnnotifiedReply[]) {
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await sb
      .from('email_replies')
      .update({ notified_at: claimedAt })
      .eq('id', row.id)
      .is('notified_at', null)
      .select('id');
    if (claimError || !claimed?.length) continue;

    const creator = first(row.creators);
    const campaign = first(row.campaigns);
    const handle = creator?.handle || row.from_name || row.from_email || 'unknown';
    try {
      await notifyDiscord(
        settings.webhookUrl,
        replyDiscordPayload({
          handle,
          platform: creator?.platform || '',
          campaignName: campaign?.name || '',
          snippet: replySnippet([row.snippet, row.body_text, row.body]),
          receivedAt: row.received_at,
          creatorId: row.creator_id,
        }),
      );
      sent += 1;
    } catch (err) {
      await sb.from('email_replies').update({ notified_at: null }).eq('id', row.id);
      console.warn(
        '[discord] reply notify failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return sent;
}
