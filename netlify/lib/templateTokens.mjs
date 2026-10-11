/** Plain copy of src/templates/tokens.ts for Netlify functions. Keep the two in step. */

export function platformLabel(platform) {
  const raw = String(platform ?? '').trim().toLowerCase();
  if (raw === 'tiktok') return 'TikTok';
  if (raw === 'instagram') return 'Instagram';
  if (raw) return String(platform).trim();
  return 'social';
}

export function topicSnippet(topic) {
  const clean = String(topic ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'your latest post';
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}…` : clean;
}

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

function foldHandle(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function capitaliseName(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Keep in step with looksLikeGivenName in src/templates/tokens.ts. */
export function looksLikeGivenName(word) {
  if (!/^[A-Za-z][A-Za-z'’-]{1,11}$/.test(word)) return false;
  const lower = word.toLowerCase();
  if (NOT_A_GIVEN_NAME.has(lower)) return false;
  if (/(reads|reader|books|booktok|tok|official|creator|content|ugc)/i.test(lower)) return false;
  return true;
}

function nameFromBio(bio, handle) {
  const text = String(bio ?? '').replace(/\s+/g, ' ');
  const match = text.match(/\b(?:i['’]?m|i am|my name is|this is|name:)\s+([A-Za-z][A-Za-z'’-]{1,11})\b/i);
  const word = match?.[1] ?? '';
  if (!looksLikeGivenName(word)) return null;
  if (handle && foldHandle(word) === foldHandle(handle)) return null;
  return capitaliseName(word);
}

/** Keep in step with firstNameOf in src/templates/tokens.ts. */
export function firstNameOf(displayName, handle, bio) {
  const handleClean = String(handle ?? '').replace(/^@/, '').trim();
  const display = String(displayName ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[|·•].*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const displayIsHandle = Boolean(handleClean) && foldHandle(display) === foldHandle(handleClean);
  if (display && !displayIsHandle) {
    const parts = display.split(' ').filter((part) => part && part !== '|' && part !== '·');
    const first = parts[0] ?? '';
    if (parts.length >= 2 && looksLikeGivenName(first)) return capitaliseName(first);
    if (parts.length === 1 && looksLikeGivenName(first)) return capitaliseName(first);
  }
  return nameFromBio(bio, handleClean) ?? 'there';
}

export function templateValues(input = {}) {
  const handle = String(input.handle ?? '').replace(/^@/, '').trim();
  const display =
    String(input.displayName ?? '').trim() ||
    String(input.creatorName ?? '').trim() ||
    handle ||
    'there';
  const creatorName = String(input.creatorName ?? '').trim() || display;
  const appName = String(input.appName ?? '').trim() || 'our app';
  const platform = platformLabel(input.platform);
  const hook = String(input.hook ?? '').trim();
  const customHook = hook || `I have been enjoying your ${platform} posts.`;
  const videoHook = String(input.videoHook ?? '').trim() || "I've been enjoying your content.";
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
    value_prop: String(input.valueProp ?? '').trim(),
    store_url: String(input.storeUrl ?? '').trim(),
  };
}

export function renderTemplate(template, input = {}) {
  const map = templateValues(input);
  return String(template ?? '')
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key] ?? '';
      return '';
    })
    .trimEnd();
}
