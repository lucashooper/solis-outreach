/**
 * Opening line for {{video_hook}}.
 * Uses captions, bio, and niches already stored on the creator.
 * No new scrapes. Pure helpers so preview, cache, and fallback can be tested
 * without calling Groq.
 */

export type VideoHookSource = 'video' | 'bio' | 'generic';

export type VideoHookField = 'caption' | 'bio' | 'niches';

export interface VideoCaption {
  caption?: string | null;
  video_url?: string | null;
  /** When this caption was scraped. Old rows omit it. */
  scraped_at?: string | null;
}

export interface VideoHookMaterial {
  handle?: string | null;
  bio?: string | null;
  niches?: string[] | null;
  videos?: VideoCaption[] | null;
  /** creators.created_at. Used when a video has no scraped_at. */
  foundAt?: string | null;
  /** Fixed clock for tests. */
  now?: string;
  /** Set when a model line is kept. Fallback lines store null. */
  model?: string | null;
}

/** Bump when the hook prompt or grounding rules change so old cached lines regenerate. */
export const VIDEO_HOOK_VERSION = 3;

/** Facts the line was actually drawn from, so a reviewer can see the source. */
export interface VideoHookProvenance {
  video_url: string | null;
  caption_snippet: string | null;
  fields_used: VideoHookField[];
  bio: string | null;
  niches: string[];
  /** ISO time. A scrape time when observed_as is scraped, otherwise when the creator was found. */
  observed_at: string | null;
  observed_as: 'scraped' | 'found';
  model: string | null;
  generated_at: string | null;
  grounded: boolean;
}

export interface StoredVideoHook {
  text: string;
  source: VideoHookSource;
  basis: string;
  edited: boolean;
  /** Null on lines written before VIDEO_HOOK_VERSION. Those regenerate unless edited. */
  version: number | null;
  provenance: VideoHookProvenance | null;
}

export interface VideoHookDraft extends StoredVideoHook {
  cached: boolean;
}

/** Neutral line when we have nothing specific. British English. */
export const GENERIC_VIDEO_HOOK = "I've been enjoying your content.";

export const READING_VIDEO_HOOK = "I've been enjoying your reading content.";

/** Smaller Groq model than the default outreach model. Overridable. */
export function videoHookModel(): string {
  return process.env.LLM_HOOK_MODEL?.trim() || 'openai/gpt-oss-20b';
}

export const VIDEO_HOOK_SYSTEM = [
  'You write one opening sentence of a cold email from Alex to a creator.',
  'British English. One sentence, 20 words maximum. Sentence case. End with a full stop.',
  'No emoji. No exclamation marks. No hashtags.',
  'Do not start with a name, "Name,", "[Name]", "Hey", or any placeholder.',
  "Write in Alex's voice about their video. Do not use first person. Never copy the creator's \"I\", \"I've\", or \"I'm\".",
  'Do not flatter. Do not give an opinion or an adjective about their insights, selection, style, discussion, pace, or taste.',
  'Do not use these words: intrigued, insights, candid, discussion, selection, recommendation, appreciated, style, pace, amazing, obsessed, incredible, perfect, genius.',
  'Use only facts present in the supplied caption or bio. Do not invent titles, quotes, or events.',
  'If you mention a video, copy one allowed caption phrase exactly, inside quotes. Example: Loved your "Fourth Wing reaction" video.',
  'Do not paraphrase. Do not quote hashtags. Do not quote a caption that is not English.',
  'If there is no allowed caption phrase, reply with {"line":""}.',
  'Reply with JSON only: {"line":"..."}',
].join(' ');

const HYPE =
  /\b(obsessed|amazing|incredible|perfect|genius|blown away|absolutely love|love your)\b/i;

const OPINION =
  /\b(intrigued|insights?|candid|discussions?|selections?|recommendations?|appreciat(?:e|ed|es|ing)|styles?|paces?)\b/i;

const FIRST_PERSON =
  /\b(i['’]m|i['’]ve|i['’]d|i['’]ll|i am|i have|i)\b/i;

const DANGLING_END =
  /\b(the|a|an|and|or|of|to|for|with|across|your|my|their|this|that|in|on|at|from|into|over|about|its)$/i;

const GERMAN_WORDS = new Set([
  'und',
  'der',
  'die',
  'das',
  'ich',
  'nicht',
  'ein',
  'eine',
  'einer',
  'einem',
  'einen',
  'mit',
  'für',
  'fuer',
  'auf',
  'ist',
  'von',
  'den',
  'dem',
  'des',
  'sie',
  'wir',
  'aber',
  'auch',
  'noch',
  'hier',
  'mein',
  'meine',
  'dein',
  'deine',
  'ihr',
  'ihre',
  'oder',
  'wie',
  'wenn',
  'dass',
  'kein',
  'keine',
  'zum',
  'zur',
  'nach',
  'aus',
  'bei',
  'sind',
  'bin',
  'habe',
  'hat',
  'wird',
  'kann',
  'doch',
  'mal',
  'heute',
  'schon',
  'jetzt',
  'dann',
  'euch',
  'bitte',
  'danke',
  'hallo',
  'liebe',
  'dieses',
  'sehr',
  'beste',
  'besten',
  'buch',
  'bücher',
  'buecher',
  'warum',
  'musst',
  'müsst',
  'solltet',
  'lesen',
]);

export function stripEmoji(value: string): string {
  return value.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\uFE0F\u200D]/g, '');
}

function tidy(value: string): string {
  return stripEmoji(value).replace(/\s+/g, ' ').trim();
}

function wordsOf(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-zäöüß\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** English prose only. Hashtag spam and German (or other) captions are unusable. */
export function looksEnglish(value: string): boolean {
  const text = tidy(value);
  if (!text || !/[A-Za-z]/.test(text)) return false;
  if (/[äöüÄÖÜß]/.test(text)) return false;
  const letters = text.match(/\p{L}/gu) ?? [];
  const nonBasic = letters.filter((ch) => !/[A-Za-z]/.test(ch));
  if (letters.length > 0 && nonBasic.length / letters.length > 0.08) return false;
  const words = wordsOf(text);
  if (words.length === 0) return false;
  const germanHits = words.filter((word) => GERMAN_WORDS.has(word)).length;
  if (germanHits >= 2) return false;
  if (words.length >= 4 && germanHits / words.length >= 0.34) return false;
  return true;
}

function isFirstPerson(value: string): boolean {
  return FIRST_PERSON.test(value);
}

function looksLikeHashtagSoup(phrase: string): boolean {
  if (/#/.test(phrase)) return true;
  const words = phrase.split(/\s+/).filter(Boolean);
  const lengths = words.map((word) => word.replace(/[^A-Za-z0-9]/g, '').length);
  if (lengths.some((length) => length >= 16)) return true;
  if (lengths.filter((length) => length >= 12).length >= 2) return true;
  return false;
}

function isCutOff(phrase: string): boolean {
  if (/…|\.\.\./.test(phrase)) return true;
  if (/[!?]/.test(phrase.replace(/[?]+$/g, ''))) return true;
  if (DANGLING_END.test(phrase)) return true;
  if (/[,:;]$/.test(phrase)) return true;
  return false;
}

/** Prose with URLs, hashtags, and mentions removed. Hashtag-only captions become empty. */
export function captionProse(caption?: string | null): string {
  return tidy(caption ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/@[\w.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clauses(prose: string): string[] {
  return prose
    .split(/\s+[—–-]\s+|[.!?]+(?:\s+|$)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function topicLooksBroken(topic: string): boolean {
  const text = topic.trim();
  if (!text || text.length < 3) return true;
  if (/^(?:not|every|this|that|i|i'm|im|the|your)\b/i.test(text)) return true;
  if (/\bvideo\b/i.test(text)) return true;
  if (text.split(/\s+/).length > 12) return true;
  return false;
}

/** A short, complete English phrase we can quote without cutting it off. */
export function phraseIsQuotable(phrase: string): boolean {
  const text = tidy(phrase).replace(/^["“]+|["”]+$/g, '').trim();
  if (!text || topicLooksBroken(text) || !looksEnglish(text)) return false;
  if (isFirstPerson(text) || looksLikeHashtagSoup(text) || isCutOff(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  if (!words.some((word) => word.replace(/[^A-Za-z0-9]/g, '').length >= 4)) return false;
  return true;
}

/**
 * A short topic from one caption, or null when the caption is only tags,
 * not English, first person, or would have to be cut mid-phrase.
 */
export function captionTopic(caption?: string | null): string | null {
  const prose = captionProse(caption);
  if (!prose || !looksEnglish(prose)) return null;
  for (const clause of clauses(prose)) {
    const phrase = clause.replace(/[.!?]+$/g, '').trim();
    if (phraseIsQuotable(phrase)) return phrase;
  }
  return null;
}

export function hasUsableVideo(input: VideoHookMaterial): boolean {
  return (input.videos ?? []).some((video) => captionTopic(video.caption) != null);
}

function bestTopic(input: VideoHookMaterial): string | null {
  for (const video of input.videos ?? []) {
    const topic = captionTopic(video.caption);
    if (topic) return topic;
  }
  return null;
}

function videoForTopic(input: VideoHookMaterial, topic: string): VideoCaption | null {
  const needle = normaliseForMatch(topic);
  for (const video of input.videos ?? []) {
    const found = captionTopic(video.caption);
    if (found && normaliseForMatch(found) === needle) return video;
  }
  return null;
}

function readingish(value: string): boolean {
  return /\b(booktok|books?|reading|reader|readers|novel|romance|fantasy|literature)\b/i.test(value);
}

/** A niche we can name without inventing one, or "reading" for book content. */
export function nichePhrase(input: VideoHookMaterial): string | null {
  const niches = (input.niches ?? []).map((niche) => niche.replace(/^#/, '').trim()).filter(Boolean);
  const blob = [input.bio ?? '', ...niches].join(' ');
  if (readingish(blob)) return 'reading';
  for (const niche of niches) {
    const clean = niche
      .replace(/[_#]/g, ' ')
      .replace(/\btok\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (/^[a-z][a-z\s]{2,24}$/.test(clean)) return clean;
  }
  return null;
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function sentenceCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Drop a leading name, placeholder, or greeting the model was told not to write. */
export function stripHookArtefacts(raw: string): string {
  let text = tidy(raw).replace(/^["“]+|["”]+$/g, '').trim();
  let previous = '';
  while (text && text !== previous) {
    previous = text;
    text = text.replace(/^(?:hey|hi)\b[,!]?\s+/i, '');
    text = text.replace(/^(?:\[name\]|\{\{[^}]+\}\}|name)\s*,\s*/i, '');
    text = text.replace(/^[,;:\s]+/, '');
  }
  return text.replace(/!+/g, '').replace(/\s+/g, ' ').trim();
}

/** A pasted caption that does not read as a sentence about the video. */
export function videoHookLooksBroken(line: string): boolean {
  const text = line.trim();
  if (!text) return true;
  if (/\b(?:name,|\[name\]|\{\{)/i.test(text)) return true;
  if (/^[A-Za-z]+,/.test(text)) return true;
  if (/\bto be video stood out\b/i.test(text)) return true;
  if (/\byour\s+(?:not|every|this|that|i|i'm|im)\b/i.test(text)) return true;
  const videos = text.match(/\bvideo\b/gi) ?? [];
  if (videos.length >= 2 && /\bstood out\b/i.test(text)) return true;
  return false;
}

/** Loved your "topic" video. Null for hashtag soup, cut-off quotes, or a phrase we would have to trim. */
export function hookFromTopic(topic: string): string | null {
  const clean = tidy(topic).replace(/^["“]+|["”]+$/g, '').trim();
  if (!clean || /…|\.\.\./.test(clean)) return null;
  if (/[!?]/.test(clean.replace(/[?]+$/g, ''))) return null;
  const question = /\?$/.test(clean);
  const phrase = clean.replace(/[.!?]+$/g, '').trim();
  if (!phraseIsQuotable(phrase) || clauses(phrase).length !== 1) return null;
  const shown = `${sentenceCase(phrase)}${question ? '?' : ''}`;
  const line = `Loved your "${shown}" video.`;
  if (videoHookLooksBroken(line) || wordCount(line) > 20 || wordCount(line) < 3) return null;
  return line;
}

/**
 * Keep a model line only when it is one calm sentence about their video.
 * Rejects praise, first person copied from the creator, and broken quotes.
 */
export function normaliseVideoHook(raw: string): string | null {
  let line = stripHookArtefacts(raw);
  if (!line || HYPE.test(line) || OPINION.test(line) || isFirstPerson(line)) return null;
  if (/\p{Extended_Pictographic}/u.test(line) || !looksEnglish(line)) return null;
  const quoted = line.match(/^your\s+['"“”](.+?)['"“”]\s+video(?:\s+was great|\s+stood out)?\.?$/i);
  const plain = line.match(/^your\s+(.+?)\s+video(?:\s+was great|\s+stood out)\.?$/i);
  const topic = quoted?.[1] ?? plain?.[1];
  if (topic) {
    const rewritten = hookFromTopic(topic);
    if (!rewritten) return null;
    line = rewritten;
  }
  if (videoHookLooksBroken(line)) return null;
  if (wordCount(line) > 20 || wordCount(line) < 3) return null;
  line = sentenceCase(line);
  if (!/[.]$/.test(line)) line = `${line.replace(/[,;:]$/, '')}.`;
  if (videoHookLooksBroken(line) || OPINION.test(line) || isFirstPerson(line)) return null;
  return line;
}

function normaliseForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReferencedPhrase(line: string): string | null {
  const quoted = [...line.matchAll(/["“]([^"”]{2,120})["”]/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
  if (quoted.length === 1) return quoted[0] ?? null;
  if (quoted.length > 1) return null;
  const yourVideo = line.match(/\byour\s+(.+?)\s+video\b/i);
  const phrase = yourVideo?.[1]?.replace(/^["“']+|["”']+$/g, '').trim();
  return phrase || null;
}

function findSpan(prose: string, phrase: string): string | null {
  const compact = phrase.trim().replace(/\s+/g, ' ');
  if (!compact) return null;
  const escaped = compact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const match = prose.match(new RegExp(escaped, 'i'));
  return match?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
}

export interface GroundedCaptionMatch {
  video: VideoCaption;
  snippet: string;
}

/**
 * The quoted phrase must be a contiguous span of one caption's prose.
 * Hashtags and non-English captions do not count.
 */
export function matchGroundedCaption(
  line: string,
  videos: VideoCaption[] | null | undefined,
): GroundedCaptionMatch | null {
  const phrase = extractReferencedPhrase(line);
  if (!phrase) return null;
  const bare = phrase.replace(/[.!?]+$/g, '').trim();
  if (!phraseIsQuotable(bare)) return null;
  const needle = normaliseForMatch(bare);
  if (!needle) return null;
  for (const video of videos ?? []) {
    const prose = captionProse(video.caption);
    if (!prose || !looksEnglish(prose)) continue;
    if (!normaliseForMatch(prose).includes(needle)) continue;
    return { video, snippet: findSpan(prose, bare) ?? bare };
  }
  return null;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  if (Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}

function clock(input: VideoHookMaterial): string {
  return isoOrNull(input.now) ?? new Date().toISOString();
}

function observed(
  video: VideoCaption | null,
  foundAt: string | null | undefined,
  grounded: boolean,
): Pick<VideoHookProvenance, 'observed_at' | 'observed_as'> {
  const scraped = grounded ? isoOrNull(video?.scraped_at) : null;
  if (scraped) return { observed_at: scraped, observed_as: 'scraped' };
  const found = isoOrNull(foundAt);
  if (found) return { observed_at: found, observed_as: 'found' };
  return { observed_at: null, observed_as: 'found' };
}

function usedFields(
  input: VideoHookMaterial,
  source: VideoHookSource,
): Pick<VideoHookProvenance, 'fields_used' | 'bio' | 'niches'> {
  if (source === 'video') return { fields_used: ['caption'], bio: null, niches: [] };
  if (source !== 'bio') return { fields_used: [], bio: null, niches: [] };
  const bio = tidy(input.bio ?? '').slice(0, 280);
  const niches = (input.niches ?? []).map((niche) => niche.replace(/^#/, '').trim()).filter(Boolean);
  const fields_used: Array<'bio' | 'niches'> = [];
  if (bio) fields_used.push('bio');
  if (niches.length) fields_used.push('niches');
  return { fields_used, bio: bio || null, niches };
}

export function emptyVideoHookProvenance(now?: string | null): VideoHookProvenance {
  return {
    video_url: null,
    caption_snippet: null,
    fields_used: [],
    bio: null,
    niches: [],
    observed_at: null,
    observed_as: 'found',
    model: null,
    generated_at: isoOrNull(now),
    grounded: false,
  };
}

function buildProvenance(args: {
  input: VideoHookMaterial;
  source: VideoHookSource;
  video: VideoCaption | null;
  snippet: string | null;
  model: string | null;
  grounded: boolean;
}): VideoHookProvenance {
  const fields = usedFields(args.input, args.grounded ? 'video' : args.source);
  const when = observed(args.video, args.input.foundAt, args.grounded);
  const url = args.video?.video_url?.trim() || '';
  return {
    video_url: args.grounded && url ? url : null,
    caption_snippet: args.grounded ? tidy(args.snippet ?? '') || null : null,
    fields_used: fields.fields_used,
    bio: fields.bio,
    niches: fields.niches,
    observed_at: when.observed_at,
    observed_as: when.observed_as,
    model: args.model?.trim() || null,
    generated_at: clock(args.input),
    grounded: args.grounded,
  };
}

export function fallbackVideoHook(input: VideoHookMaterial = {}): {
  text: string;
  source: VideoHookSource;
  provenance: VideoHookProvenance;
} {
  const topic = bestTopic(input);
  if (topic) {
    const line = hookFromTopic(topic);
    if (line) {
      return {
        text: line,
        source: 'video',
        provenance: buildProvenance({
          input,
          source: 'video',
          video: videoForTopic(input, topic),
          snippet: topic,
          model: null,
          grounded: true,
        }),
      };
    }
  }
  const niche = nichePhrase(input);
  if (niche) {
    return {
      text: niche === 'reading' ? READING_VIDEO_HOOK : `I've been enjoying your ${niche} content.`,
      source: 'bio',
      provenance: buildProvenance({
        input,
        source: 'bio',
        video: null,
        snippet: null,
        model: null,
        grounded: false,
      }),
    };
  }
  return {
    text: GENERIC_VIDEO_HOOK,
    source: 'generic',
    provenance: buildProvenance({
      input,
      source: 'generic',
      video: null,
      snippet: null,
      model: null,
      grounded: false,
    }),
  };
}

export function videoHookBasis(input: VideoHookMaterial): string {
  const notes = (input.videos ?? [])
    .map((video) => tidy(video.caption ?? ''))
    .filter(Boolean)
    .slice(0, 3);
  const bio = tidy(input.bio ?? '').slice(0, 280);
  const niches = (input.niches ?? [])
    .map((niche) => niche.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return [notes.join(' | '), bio, niches.join(',')].join('\n');
}

function asFieldList(raw: unknown): VideoHookField[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is VideoHookField => item === 'caption' || item === 'bio' || item === 'niches');
}

export function readVideoHookProvenance(raw: unknown): VideoHookProvenance | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const niches = Array.isArray(row.niches)
    ? row.niches.map((niche) => String(niche).trim()).filter(Boolean)
    : [];
  return {
    video_url: typeof row.video_url === 'string' && row.video_url.trim() ? row.video_url.trim() : null,
    caption_snippet:
      typeof row.caption_snippet === 'string' && row.caption_snippet.trim()
        ? row.caption_snippet.trim()
        : null,
    fields_used: asFieldList(row.fields_used),
    bio: typeof row.bio === 'string' && row.bio.trim() ? row.bio.trim() : null,
    niches,
    observed_at: isoOrNull(typeof row.observed_at === 'string' ? row.observed_at : null),
    observed_as: row.observed_as === 'scraped' ? 'scraped' : 'found',
    model: typeof row.model === 'string' && row.model.trim() ? row.model.trim() : null,
    generated_at: isoOrNull(typeof row.generated_at === 'string' ? row.generated_at : null),
    grounded: row.grounded === true,
  };
}

export function readStoredVideoHook(
  vars: Record<string, unknown> | null | undefined,
): StoredVideoHook | null {
  if (!vars || typeof vars !== 'object') return null;
  const text = typeof vars.video_hook === 'string' ? vars.video_hook.trim() : '';
  if (!text) return null;
  const source: VideoHookSource =
    vars.video_hook_source === 'video' ||
    vars.video_hook_source === 'bio' ||
    vars.video_hook_source === 'generic'
      ? vars.video_hook_source
      : 'generic';
  const version = typeof vars.video_hook_version === 'number' ? vars.video_hook_version : null;
  return {
    text,
    source,
    basis: typeof vars.video_hook_basis === 'string' ? vars.video_hook_basis : '',
    edited: vars.video_hook_edited === true,
    version,
    provenance: readVideoHookProvenance(vars.video_hook_provenance),
  };
}

/** Cached line to reuse. Edited lines stick. Older unedited lines regenerate. */
export function reusableVideoHook(
  stored: StoredVideoHook | null,
  basis: string,
  force = false,
): StoredVideoHook | null {
  if (!stored?.text) return null;
  if (force) return null;
  if (stored.edited) return stored;
  if (stored.version !== VIDEO_HOOK_VERSION) return null;
  if (!stored.provenance) return null;
  if (videoHookLooksBroken(stored.text)) return null;
  if (stored.basis && stored.basis === basis) return stored;
  return null;
}

export function cachedOrFallbackVideoHook(
  input: VideoHookMaterial & { stored?: Record<string, unknown> | null },
): { text: string; source: VideoHookSource } {
  const basis = videoHookBasis(input);
  const reused = reusableVideoHook(readStoredVideoHook(input.stored), basis, false);
  if (reused) return { text: reused.text, source: reused.source };
  const fallback = fallbackVideoHook(input);
  return { text: fallback.text, source: fallback.source };
}

export function buildVideoHookPrompt(input: VideoHookMaterial): string {
  const phrases = (input.videos ?? [])
    .map((video) => captionTopic(video.caption))
    .filter((phrase): phrase is string => Boolean(phrase))
    .slice(0, 3);
  const niches = (input.niches ?? []).map((niche) => niche.trim()).filter(Boolean);
  const handle = (input.handle ?? '').replace(/^@/, '').trim();
  const lines = [
    'Creator notes (only source of facts). Do not add praise, opinions, or details that are not written here.',
  ];
  if (handle) lines.push(`Handle: @${handle}`);
  const bio = tidy(input.bio ?? '').slice(0, 400);
  if (bio && looksEnglish(bio)) lines.push(`Bio: ${bio}`);
  if (niches.length) lines.push(`Niches: ${niches.join(', ')}`);
  if (phrases.length) {
    lines.push('Allowed caption phrases (copy one exactly, from one caption, inside quotes):');
    phrases.forEach((phrase, index) => lines.push(`${index + 1}. ${phrase}`));
  } else {
    lines.push('Allowed caption phrases: none');
  }
  lines.push('If you cannot copy one allowed phrase, reply with {"line":""}.');
  return lines.join('\n');
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence?.[1]?.trim() || trimmed;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

export function parseVideoHookLine(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const line = record.line ?? record.hook;
  if (typeof line !== 'string') return null;
  return normaliseVideoHook(line);
}

/**
 * Cache hit, model line, or fallback. `chat` is only called when a video
 * caption is usable and nothing reusable is stored.
 */
export async function fillVideoHook(
  input: VideoHookMaterial & {
    stored?: Record<string, unknown> | null;
    force?: boolean;
  },
  chat: ((prompt: string) => Promise<string>) | null,
): Promise<VideoHookDraft> {
  const basis = videoHookBasis(input);
  const reused = reusableVideoHook(readStoredVideoHook(input.stored), basis, input.force === true);
  if (reused) return { ...reused, cached: true };

  if (hasUsableVideo(input) && chat) {
    try {
      const parsed = parseVideoHookLine(await chat(buildVideoHookPrompt(input)));
      const match = parsed ? matchGroundedCaption(parsed, input.videos) : null;
      if (parsed && match) {
        return {
          text: parsed,
          source: 'video',
          basis,
          edited: false,
          version: VIDEO_HOOK_VERSION,
          cached: false,
          provenance: buildProvenance({
            input,
            source: 'video',
            video: match.video,
            snippet: match.snippet,
            model: input.model ?? null,
            grounded: true,
          }),
        };
      }
    } catch {
      /* fall through to the stored-data fallback */
    }
  }

  const fallback = fallbackVideoHook(input);
  return {
    text: fallback.text,
    source: fallback.source,
    basis,
    edited: false,
    version: VIDEO_HOOK_VERSION,
    cached: false,
    provenance: fallback.provenance,
  };
}

/** British date, for example 8 Oct 2026. */
export function formatHookDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/London',
  })
    .format(date)
    .replace(/\u00a0/g, ' ');
}

export function hookDateLabel(
  provenance: Pick<VideoHookProvenance, 'observed_at' | 'observed_as'>,
): string | null {
  const formatted = formatHookDate(provenance.observed_at);
  if (!formatted) return null;
  return provenance.observed_as === 'scraped' ? `Scraped ${formatted}` : `Found on ${formatted}`;
}
