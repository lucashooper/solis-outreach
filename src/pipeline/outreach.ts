import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPersonalizationPrompt,
  parsePersonalizationResponse,
} from '../personalization.js';
import { buildColdEmailPayload } from '../cold-email.js';
import { resolveBlastFrom, resolveBlastReplyTo } from './blastFrom.js';
import { renderTemplate } from '../templates/tokens.js';
import { cachedOrFallbackVideoHook } from '../templates/videoHook.js';
import { chatJson, isGroqConfigured } from '../llm/client.js';
import { formatEngagement } from '../discovery/engagement.js';
import type { Creator } from '../types.js';

const DEFAULT_TEMPLATE = `Hi {{creator_handle}},

{{hook}}

I'm reaching out from {{app_name}} — {{value_prop}}.

Would you be open to a short-form collab? Happy to share brief, deliverables, and budget if you're interested.

Reply to this email and we'll take it from there.

Cheers,
{{app_name}} team`;

/**
 * Resolve cold-email body template:
 * 1. EMAIL_TEMPLATE env (inline)
 * 2. data/email-template.md (or EMAIL_TEMPLATE_PATH)
 * 3. built-in DEFAULT_TEMPLATE
 */
export function loadEmailTemplate(): string {
  const inline = process.env.EMAIL_TEMPLATE?.trim();
  if (inline) return inline;

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const customPath =
    process.env.EMAIL_TEMPLATE_PATH?.trim() ||
    resolve(packageRoot, 'data/email-template.md');
  if (existsSync(customPath)) {
    try {
      const raw = readFileSync(customPath, 'utf8').trim();
      if (raw) return raw;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_TEMPLATE;
}

export interface OutreachSendResult {
  ok: boolean;
  providerMessageId: string | null;
  hook: string;
  emailBody: string;
  subject: string;
  error?: string;
  skipped?: boolean;
}

export interface OutreachDeps {
  /** Optional LLM call; if omitted, uses Groq when keyed, else bio-first-line template. */
  generateHook?: (prompt: string) => Promise<string>;
  resendApiKey?: string;
  resendFrom?: string;
  fetchImpl?: typeof fetch;
  /** Prefer an existing hook (e.g. edited in CRM) instead of regenerating. */
  existingHook?: string;
  /** Final subject from the send drawer. Skips the generated subject line. */
  renderedSubject?: string;
  /** Final body from the send drawer. Skips template generation. */
  renderedBody?: string;
  /** Campaign template subject. Tokens are filled per creator. */
  templateSubject?: string;
  /** Campaign template body. Tokens are filled per creator. Falls back to the file template. */
  templateBody?: string;
}

/** Deterministic fallback: first line of bio, truncated. */
export function templateHookFromBio(
  bio: string,
  handle: string,
  appName: string,
): string {
  const firstLine =
    bio
      .split(/\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0)
      ?.slice(0, 140) ?? `your content as @${handle}`;
  return `Loved this from your bio — "${firstLine}" — and thought ${appName} could be a natural fit.`;
}

/**
 * Call Groq (OpenAI-compatible) chat completions for a personalisation JSON hook.
 */
export async function generateHookViaLlm(
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const { content } = await chatJson({
    system:
      'You write short creator outreach hooks. Reply with JSON only: {"hook":"..."}',
    user: prompt,
    temperature: 0.7,
    fetchImpl,
  });
  return content;
}

/** @deprecated Use generateHookViaLlm — kept as alias for older imports. */
export const generateHookViaOpenAI = generateHookViaLlm;

/**
 * Personalise + send step-1 outreach via Resend for a single creator.
 * Falls back to bio first-line template when no LLM is configured.
 */
export async function sendCreatorOutreach(
  creator: Pick<Creator, 'id' | 'handle' | 'bio' | 'email'> & {
    ai_variables?: Record<string, unknown>;
    platform?: string | null;
    top_videos?: Array<{ caption?: string | null }>;
  },
  branding: { appName: string; valueProp: string; storeUrl?: string | null },
  deps: OutreachDeps = {},
): Promise<OutreachSendResult> {
  if (!creator.email?.trim()) {
    return {
      ok: false,
      providerMessageId: null,
      hook: '',
      emailBody: '',
      subject: '',
      skipped: true,
      error: 'No email address',
    };
  }

  const bio = creator.bio?.trim() || `Creator @${creator.handle}`;
  const prompt = buildPersonalizationPrompt(
    bio,
    branding.appName,
    branding.valueProp,
  );

  let hook: string;
  const existing =
    deps.existingHook?.trim() ||
    (typeof creator.ai_variables?.hook === 'string'
      ? creator.ai_variables.hook.trim()
      : '');
  const renderedBody = deps.renderedBody?.trim() || '';

  if (renderedBody && existing) {
    hook = existing;
  } else if (renderedBody) {
    hook = templateHookFromBio(bio, creator.handle, branding.appName);
  } else if (existing) {
    hook = existing;
  } else if (deps.generateHook) {
    try {
      const raw = await deps.generateHook(prompt);
      hook = parsePersonalizationResponse(raw).hook;
    } catch {
      hook = templateHookFromBio(bio, creator.handle, branding.appName);
    }
  } else if (isGroqConfigured()) {
    try {
      const raw = await generateHookViaLlm(prompt, deps.fetchImpl ?? fetch);
      hook = parsePersonalizationResponse(raw).hook;
    } catch {
      hook = templateHookFromBio(bio, creator.handle, branding.appName);
    }
  } else {
    hook = templateHookFromBio(bio, creator.handle, branding.appName);
  }

  const topic = creator.top_videos
    ?.map((video) => video.caption)
    .find((caption) => caption && caption.trim());
  const niches = Array.isArray(creator.ai_variables?.niches)
    ? (creator.ai_variables.niches as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const videoHook = cachedOrFallbackVideoHook({
    handle: creator.handle,
    bio: creator.bio,
    niches,
    videos: creator.top_videos,
    stored: creator.ai_variables,
  });
  const templateContext = {
    handle: creator.handle,
    creatorName: creator.handle,
    displayName: creator.handle,
    appName: branding.appName,
    valueProp: branding.valueProp,
    platform: creator.platform,
    hook,
    recentVideoTopic: topic,
    videoHook: videoHook.text,
    storeUrl: branding.storeUrl,
  };
  const emailBody = renderTemplate(deps.templateBody?.trim() || loadEmailTemplate(), templateContext);

  const subject =
    deps.renderedSubject?.trim() ||
    (deps.templateSubject?.trim()
      ? renderTemplate(deps.templateSubject, templateContext)
      : `Collab idea for @${creator.handle.replace(/^@/, '')} — ${branding.appName}`);
  const outboundBody = renderedBody || emailBody;
  // Prefer Alex display for outbound Resend; keep RESEND_FROM_EMAIL as env fallback.
  const from = resolveBlastFrom(process.env, deps.resendFrom);
  const payload = buildColdEmailPayload({
    provider: 'resend',
    to: creator.email.trim(),
    from,
    replyTo: resolveBlastReplyTo(process.env),
    subject,
    htmlOrText: outboundBody.replace(/\n/g, '<br>\n'),
    creatorId: creator.id,
    sequenceStep: 1,
    sequenceTags: ['campaign', 'step-1'],
  });

  const apiKey = deps.resendApiKey ?? process.env.RESEND_API_KEY ?? '';
  if (!apiKey.trim()) {
    return {
      ok: true,
      providerMessageId: `dry-run-${creator.id}`,
      hook,
      emailBody: outboundBody,
      subject,
      skipped: true,
      error: 'RESEND_API_KEY not set — outreach recorded as dry-run',
    };
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        providerMessageId: null,
        hook,
        emailBody: outboundBody,
        subject,
        error: `Resend ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
      };
    }
    return {
      ok: true,
      providerMessageId: typeof body.id === 'string' ? body.id : null,
      hook,
      emailBody: outboundBody,
      subject,
    };
  } catch (err) {
    return {
      ok: false,
      providerMessageId: null,
      hook,
      emailBody: outboundBody,
      subject,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  thumbnail?: { url: string };
  image?: { url: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Post a Discord webhook message. Pass a string for plain content, or a payload
 * with embeds (max 10). Discord rate-limits ~5 req / 2s for webhooks.
 */
export async function notifyDiscord(
  webhookUrl: string,
  contentOrPayload: string | DiscordMessagePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!webhookUrl?.trim()) return;
  const body: DiscordMessagePayload =
    typeof contentOrPayload === 'string'
      ? { content: contentOrPayload }
      : contentOrPayload;
  const res = await fetchImpl(webhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord notify failed (${res.status}): ${text || res.statusText}`);
  }
}

function formatFollowers(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Rich embeds for top creators (handle, profile, followers, engagement, top videos). */
export function buildBestCreatorsDiscordPayload(input: {
  campaignName: string;
  creators: Array<{
    handle: string;
    platform?: string;
    profile_url?: string | null;
    avatar_url?: string | null;
    follower_count?: number | null;
    engagement_rate?: number | null;
    email?: string | null;
    top_videos?: Array<{
      video_url?: string;
      thumbnail_url?: string | null;
      view_count?: number | null;
      play_count?: number | null;
    }>;
  }>;
}): DiscordMessagePayload {
  const top = input.creators.slice(0, 10);
  const embeds: DiscordEmbed[] = top.map((c, i) => {
    const handle = c.handle.replace(/^@/, '');
    const profile = c.profile_url || undefined;
    const eng = formatEngagement(c.engagement_rate);
    const videos = (c.top_videos ?? []).slice(0, 3);
    const videoLines = videos
      .map((v, vi) => {
        const url = v.video_url || '';
        const views = v.play_count ?? v.view_count;
        const viewLabel =
          views != null
            ? ` (${formatFollowers(views)} views)`
            : '';
        return url ? `[Video ${vi + 1}](${url})${viewLabel}` : null;
      })
      .filter(Boolean);
    const thumb =
      videos.find((v) => v.thumbnail_url)?.thumbnail_url || c.avatar_url || undefined;
    const fields: DiscordEmbed['fields'] = [
      { name: 'Followers', value: formatFollowers(c.follower_count), inline: true },
      { name: 'Engagement', value: eng, inline: true },
      {
        name: 'Platform',
        value: (c.platform || '—').toString(),
        inline: true,
      },
    ];
    if (c.email) {
      fields.push({ name: 'Email', value: c.email, inline: true });
    }
    if (videoLines.length) {
      fields.push({
        name: 'Top videos',
        value: videoLines.join('\n'),
        inline: false,
      });
    }
    const embed: DiscordEmbed = {
      title: `${i + 1}. @${handle}`,
      url: profile,
      color: 0x5b8def,
      fields,
    };
    if (c.avatar_url) embed.thumbnail = { url: c.avatar_url };
    if (thumb && thumb !== c.avatar_url) embed.image = { url: thumb };
    else if (thumb && !c.avatar_url) embed.thumbnail = { url: thumb };
    return embed;
  });

  return {
    content: `🎯 Best creators for **${input.campaignName}**`,
    embeds,
  };
}
