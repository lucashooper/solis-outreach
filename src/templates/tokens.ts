/**
 * Cold-email and blast placeholders.
 * Unknown tokens are removed so a typo is not emailed as raw braces.
 * British English fallbacks.
 */

export interface TemplateContext {
  creatorName?: string | null;
  displayName?: string | null;
  handle?: string | null;
  appName?: string | null;
  platform?: string | null;
  hook?: string | null;
  recentVideoTopic?: string | null;
  valueProp?: string | null;
  /** Opening line about a recent video. Filled per creator at preview. */
  videoHook?: string | null;
  /** App Store URL. Empty when the app has none saved. */
  storeUrl?: string | null;
  /** Profile bio. Used only to find a real first name. */
  bio?: string | null;
}

export const TEMPLATE_TOKENS = [
  'creator_name',
  'display_name',
  'first_name',
  'app_name',
  'platform',
  'custom_hook',
  'recent_video_topic',
  'hook',
  'video_hook',
  'creator_handle',
  'value_prop',
  'store_url',
] as const;

export const TEMPLATE_TOKEN_HELP: Record<(typeof TEMPLATE_TOKENS)[number], string> = {
  creator_name: 'Creator name, or their handle when no name is stored.',
  display_name: 'Name used in a greeting.',
  first_name: 'A real first name from the display name or bio. Otherwise there, so Hey {{first_name}} stays natural.',
  app_name: 'The app this outreach is for.',
  platform: 'TikTok or Instagram.',
  custom_hook: 'Saved hook, or a neutral line when none is stored.',
  recent_video_topic: 'Caption of a recent video, shortened.',
  hook: 'Saved personalisation hook. Blank when none is stored.',
  video_hook:
    'One short line about a recent video. Filled per creator when you preview, from videos already saved. A neutral line is used when there is nothing to go on.',
  creator_handle: 'Handle with @.',
  value_prop: 'The app value proposition.',
  store_url: 'App Store link. Blank when this app has no link saved. Put it in the signature.',
};

const NOT_A_GIVEN_NAME = new Set([
  'the',
  'and',
  'book',
  'books',
  'reading',
  'reader',
  'reads',
  'booktok',
  'tiktok',
  'official',
  'hey',
  'hi',
  'creator',
  'content',
  'your',
  'there',
]);

function foldHandle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function capitaliseName(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** A short given name, not a handle mash such as Samwallreads. */
export function looksLikeGivenName(word: string): boolean {
  if (!/^[A-Za-z][A-Za-z'’-]{1,11}$/.test(word)) return false;
  const lower = word.toLowerCase();
  if (NOT_A_GIVEN_NAME.has(lower)) return false;
  if (/(reads|reader|books|booktok|tok|official|creator|content|ugc)/i.test(lower)) return false;
  return true;
}

function nameFromBio(bio: string | null | undefined, handle: string): string | null {
  const text = (bio ?? '').replace(/\s+/g, ' ');
  const match = text.match(/\b(?:i['’]?m|i am|my name is|this is|name:)\s+([A-Za-z][A-Za-z'’-]{1,11})\b/i);
  const word = match?.[1] ?? '';
  if (!looksLikeGivenName(word)) return null;
  if (handle && foldHandle(word) === foldHandle(handle)) return null;
  return capitaliseName(word);
}

/**
 * Real first name from a TikTok display name or bio.
 * Handles are never turned into pseudo-names. The fallback is "there"
 * so "Hey {{first_name}}," reads as "Hey there,".
 */
export function firstNameOf(
  displayName?: string | null,
  handle?: string | null,
  bio?: string | null,
): string {
  const handleClean = (handle ?? '').replace(/^@/, '').trim();
  const display = (displayName ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[|·•].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const displayIsHandle =
    Boolean(handleClean) && foldHandle(display) === foldHandle(handleClean);
  if (display && !displayIsHandle) {
    const parts = display.split(' ').filter((part) => part && part !== '|' && part !== '·');
    const first = parts[0] ?? '';
    if (parts.length >= 2 && looksLikeGivenName(first)) return capitaliseName(first);
    if (parts.length === 1 && looksLikeGivenName(first)) return capitaliseName(first);
  }
  return nameFromBio(bio, handleClean) ?? 'there';
}

export function platformLabel(platform?: string | null): string {
  const raw = (platform ?? '').trim().toLowerCase();
  if (raw === 'tiktok') return 'TikTok';
  if (raw === 'instagram') return 'Instagram';
  if (raw) return platform!.trim();
  return 'social';
}

export function topicSnippet(topic?: string | null): string {
  const clean = (topic ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'your latest post';
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean;
}

export function templateValues(input: TemplateContext = {}): Record<string, string> {
  const handle = (input.handle ?? '').replace(/^@/, '').trim();
  const display =
    (input.displayName ?? '').trim() ||
    (input.creatorName ?? '').trim() ||
    handle ||
    'there';
  const creatorName = (input.creatorName ?? '').trim() || display;
  const appName = (input.appName ?? '').trim() || 'our app';
  const platform = platformLabel(input.platform);
  const hook = (input.hook ?? '').trim();
  const customHook = hook || `I have been enjoying your ${platform} posts.`;
  const videoHook = (input.videoHook ?? '').trim() || "I've been enjoying your content.";
  return {
    creator_name: creatorName,
    display_name: display,
    first_name: firstNameOf(display === handle ? '' : display, handle, input.bio),
    creator_handle: handle ? `@${handle}` : '',
    app_name: appName,
    platform,
    custom_hook: customHook,
    hook,
    video_hook: videoHook,
    recent_video_topic: topicSnippet(input.recentVideoTopic),
    value_prop: (input.valueProp ?? '').trim(),
    store_url: (input.storeUrl ?? '').trim(),
  };
}

export function renderTemplate(template: string, input: TemplateContext = {}): string {
  const map = templateValues(input);
  return String(template ?? '')
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key] ?? '';
      return '';
    })
    .trimEnd();
}

/** Sample a marketer can preview before a real send. */
export function sampleTemplateContext(
  appName?: string | null,
  valueProp?: string | null,
): TemplateContext {
  return {
    creatorName: 'Alex',
    displayName: 'Alex',
    handle: 'alexfits',
    appName: appName || 'Solis',
    platform: 'tiktok',
    hook: 'Your training clips feel like a natural fit.',
    recentVideoTopic: 'morning workout',
    valueProp:
      valueProp?.trim() || 'a clearer way to share the app with people who already love the niche',
    videoHook: 'your morning workout video was great.',
  };
}
