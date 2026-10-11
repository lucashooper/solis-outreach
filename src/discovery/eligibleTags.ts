import { isCategoryId, categoryDest, categoryOfTag, categoryTitle, type CategoryId } from './categories.js';
import { isGenericExpansionTag } from './expansionTags.js';
import { buildExpansionTiers, type ExpansionTier } from './expansionTiers.js';
import { FALLBACK_TAG_CAP } from './fallbackTags.js';
import { normaliseHashtag, normaliseHashtags } from './hashtags.js';
import { applyTagCooldown, type SkippedTag, type TagScrape } from './tagCooldown.js';
import { isSuppressed, preferredSeedTags, type TagStat } from './tagMemory.js';

/**
 * Tags the shortfall card may show. One expand round still searches at most two,
 * so the card never offers a tag the server would leave out.
 */
export const ELIGIBLE_SUGGESTION_CAP = FALLBACK_TAG_CAP;

/** Curated lists, in the order a dry book niche rotates through. */
export const SUGGESTION_CATEGORY_ORDER: readonly CategoryId[] = [
  'books',
  'study',
  'productivity',
  'self-improvement',
  'desk',
];

export const NO_ELIGIBLE_TAGS_NOTE =
  'No related tags are left to search. Search the creator network instead.';

export interface EligibleSuggestions {
  tags: string[];
  networkOnly: boolean;
  note: string;
  rotation: string | null;
}

export interface TagEligibilityInput {
  /** discovery_tag_scrapes inside the cooldown window. */
  scrapes?: readonly TagScrape[];
  /** discovery_tag_stats. A future suppressed_until blocks the tag. */
  stats?: readonly TagStat[];
  /** Tags this campaign already sent to Apify. */
  campaignScraped?: readonly string[];
  /** Tags already saved on the campaign. */
  campaignHashtags?: readonly string[];
  /** Tags already tried on this run. */
  tried?: readonly string[];
  extraBlocked?: readonly string[];
  now?: number;
}

/** Tags a suggestion or expansion round must not search. */
export function ineligibleTagSet(input: TagEligibilityInput = {}): Set<string> {
  const now = input.now ?? Date.now();
  const blocked = new Set<string>();
  const add = (raw: string) => {
    const tag = normaliseHashtag(raw);
    if (tag) blocked.add(tag);
  };
  for (const tag of input.campaignHashtags ?? []) add(tag);
  for (const tag of input.campaignScraped ?? []) add(tag);
  for (const tag of input.tried ?? []) add(tag);
  for (const tag of input.extraBlocked ?? []) add(tag);
  for (const stat of input.stats ?? []) {
    if (isSuppressed(stat, now)) add(stat.tag);
  }
  const cooled = applyTagCooldown(
    (input.scrapes ?? []).map((row) => row.tag),
    input.scrapes ?? [],
    { now },
  );
  for (const row of cooled.skipped) add(row.tag);
  return blocked;
}

/** Named rotation, then any other active category, so a full app still has its lists. */
export function suggestionCategoryOrder(active?: readonly CategoryId[]): CategoryId[] {
  const extras = (['learning', 'entrepreneurship'] as const).filter(
    (id) => !active || active.includes(id),
  );
  const named = [...SUGGESTION_CATEGORY_ORDER, ...extras];
  if (!active || active.length === 0) return [...SUGGESTION_CATEGORY_ORDER];
  const allowed = new Set(active);
  const filtered = named.filter((id) => allowed.has(id));
  return filtered.length > 0 ? filtered : [...SUGGESTION_CATEGORY_ORDER];
}

function pushEligible(out: string[], blocked: Set<string>, raw: string, limit: number): void {
  if (out.length >= limit) return;
  const tag = normaliseHashtag(raw);
  if (!tag || blocked.has(tag) || out.includes(tag) || isGenericExpansionTag(tag)) return;
  out.push(tag);
}

/**
 * Next tags that will actually be searched.
 * Tier and candidate tags come first. When those are used up, curated lists
 * rotate books → study → productivity → self-improvement → desk.
 */
export function planEligibleSuggestions(
  input: TagEligibilityInput & {
    tiers?: readonly ExpansionTier[];
    candidates?: readonly string[];
    categories?: readonly CategoryId[];
    limit?: number;
  },
): EligibleSuggestions {
  const limit = Math.max(0, input.limit ?? ELIGIBLE_SUGGESTION_CAP);
  const blocked = ineligibleTagSet(input);
  const tags: string[] = [];
  for (const tier of input.tiers ?? []) {
    for (const tag of tier.tags) pushEligible(tags, blocked, tag, limit);
  }
  for (const tag of input.candidates ?? []) pushEligible(tags, blocked, tag, limit);

  let rotation: string | null = null;
  if (tags.length < limit) {
    const order = suggestionCategoryOrder(input.categories);
    const from = tags.map((tag) => categoryOfTag(tag)).find((id): id is CategoryId => id != null) ?? null;
    const origin = from ? Math.max(0, order.indexOf(from)) : 0;
    for (let step = 0; step < order.length && tags.length < limit; step += 1) {
      const category = order[(origin + step) % order.length];
      if (!category) continue;
      const before = tags.length;
      const seeds = preferredSeedTags({
        categories: [category],
        stats: input.stats,
        blocked: [...blocked, ...tags],
        now: input.now,
        limit: limit - tags.length,
      });
      for (const seed of seeds) pushEligible(tags, blocked, seed, limit);
      if (before === 0 && tags.length > before && from && category !== from && !rotation) {
        rotation = `${categoryTitle(from)} tags are unavailable, switched to ${categoryDest(category)}: ${tags.slice(before).join(', ')}`;
      } else if (before === 0 && tags.length > before && step > 0 && !rotation) {
        const previous = order[(origin + step - 1) % order.length];
        if (previous && previous !== category) {
          rotation = `${categoryTitle(previous)} tags are unavailable, switched to ${categoryDest(category)}: ${tags.slice(before).join(', ')}`;
        }
      }
    }
  }

  if (tags.length === 0) {
    return { tags: [], networkOnly: true, note: NO_ELIGIBLE_TAGS_NOTE, rotation: null };
  }
  return { tags: tags.slice(0, limit), networkOnly: false, note: '', rotation };
}

export function withoutIneligibleTierTags(
  tiers: readonly ExpansionTier[],
  blocked: ReadonlySet<string>,
): ExpansionTier[] {
  return tiers
    .map((tier) => ({
      ...tier,
      tags: tier.tags.filter((tag) => !blocked.has(tag) && !isGenericExpansionTag(tag)),
    }))
    .filter((tier) => tier.tags.length > 0);
}

/**
 * Tags for one expand round.
 * Requested tags that the server would skip are replaced in the same round.
 * `nextSuggestions` is what the card should show after this round, not the list it started with.
 */
export function chooseExpansionTags(
  input: TagEligibilityInput & {
    requested?: readonly string[];
    tiers?: readonly ExpansionTier[];
    candidates?: readonly string[];
    categories?: readonly CategoryId[];
    limit?: number;
  },
): {
  tags: string[];
  skipped: SkippedTag[];
  networkOnly: boolean;
  note: string;
  rotation: string | null;
  nextSuggestions: string[];
} {
  const now = input.now ?? Date.now();
  const limit = input.limit ?? ELIGIBLE_SUGGESTION_CAP;
  const requested = normaliseHashtags(input.requested ?? []).filter((tag) => !isGenericExpansionTag(tag));
  const cooled =
    requested.length > 0
      ? applyTagCooldown(requested, input.scrapes ?? [], { now })
      : { tags: [] as string[], skipped: [] as SkippedTag[] };
  const blocked = ineligibleTagSet({ ...input, now });
  const kept = cooled.tags.filter((tag) => !blocked.has(tag));
  const room = Math.max(0, limit - kept.length);
  const filled =
    room > 0
      ? planEligibleSuggestions({
          ...input,
          extraBlocked: [...(input.extraBlocked ?? []), ...requested, ...kept],
          now,
          limit: room,
        })
      : { tags: [] as string[], networkOnly: false, note: '', rotation: null as string | null };
  const tags = [...kept, ...filled.tags].slice(0, limit);
  const skipped = cooled.skipped.filter((row) => !tags.includes(row.tag));
  if (tags.length === 0) {
    return {
      tags: [],
      skipped,
      networkOnly: true,
      note: filled.note || NO_ELIGIBLE_TAGS_NOTE,
      rotation: null,
      nextSuggestions: [],
    };
  }
  const next = planEligibleSuggestions({
    ...input,
    scrapes: [
      ...(input.scrapes ?? []),
      ...tags.map((tag) => ({ tag, scrapedAt: new Date(now).toISOString() })),
    ],
    tried: [...(input.tried ?? []), ...tags],
    campaignScraped: [...(input.campaignScraped ?? []), ...tags],
    extraBlocked: [...(input.extraBlocked ?? []), ...tags],
    now,
    limit,
  });
  return {
    tags,
    skipped,
    networkOnly: false,
    note: '',
    rotation: filled.rotation,
    nextSuggestions: next.tags,
  };
}

/** Read-time list. Ignores a stored suggestion snapshot and rebuilds from what is still searchable. */
export function suggestionsForFunnel(input: TagEligibilityInput & {
  appName?: string | null;
  niche?: string | null;
  pitch?: string | null;
  categories?: readonly string[];
  expansionPlan?: readonly ExpansionTier[];
  limit?: number;
}): EligibleSuggestions {
  const categories = (input.categories ?? []).filter(isCategoryId);
  const blocked = [...ineligibleTagSet(input)];
  const tiers = buildExpansionTiers({
    appName: input.appName,
    niche: input.niche,
    pitch: input.pitch,
    blocked,
    modelTags: (input.expansionPlan ?? []).flatMap((tier) => tier.tags),
  });
  return planEligibleSuggestions({
    ...input,
    tiers,
    categories: categories.length > 0 ? categories : undefined,
    limit: input.limit ?? ELIGIBLE_SUGGESTION_CAP,
  });
}
