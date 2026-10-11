import {
  isGenericExpansionTag,
  semanticNeighbourTags,
  type ExpansionRankInput,
} from './expansionTags.js';
import {
  buildExpansionTiers,
  expansionResultMessage,
  planNextRound,
  tierAlternatives,
  withoutDeniedTags,
  type ExpansionTier,
} from './expansionTiers.js';
import { activeCategoryIds, isCategoryId, type CategoryId } from './categories.js';
import {
  ineligibleTagSet,
  NO_ELIGIBLE_TAGS_NOTE,
  planEligibleSuggestions,
  suggestionsForFunnel,
} from './eligibleTags.js';
import { FALLBACK_TAG_CAP, localAdjacentHashtags, suggestFallbackHashtags } from './fallbackTags.js';
import { planCategoryRotation, type TagStat } from './tagMemory.js';
import type { TagScrape } from './tagCooldown.js';
import type { HashtagYieldFlag } from './hashtagYield.js';
import { normaliseHashtags } from './hashtags.js';
import type { DiscoveryFunnel } from './types.js';

export interface DiscoveryShortfall {
  why: string;
  /** What already ran: a page, related tags, or neither. */
  passNote: string;
  triedTags: string[];
  /** Related tags already searched. A different chip from the tags the search started with. */
  expandedTags: string[];
  suggestedTags: string[];
  /** Further niche tags. Clicking a Next chip swaps one in. */
  alternatives: string[];
  expandLabel: string;
  relaxLabel: string;
  canExpand: boolean;
  /** Every related-tag tier has been searched. Custom hashtags are the next step. */
  tiersExhausted: boolean;
  /** Tier the suggested chips belong to, when known. */
  nextTier: 1 | 2 | 3 | null;
  /** Apify rounds the latest Expand click used. */
  expansionRounds: number | null;
  /** Plain line for the latest click, including a used-up note. */
  roundNote: string;
  canRelaxEmail: boolean;
  /** No related tag can be searched. The card offers the creator network. */
  networkOnly: boolean;
  /** British English line when networkOnly is set. */
  suggestionNote: string;
  target: number;
  finished: number;
  /** New creators saved onto the campaign. */
  fresh: number;
  /** In-range creators already in the CRM. */
  existing: number;
}

export interface ShortfallChip {
  tag: string;
  expanded: boolean;
  yieldFlag: HashtagYieldFlag | null;
}

/** One chip per tag: tried, then any expanded or yield tag not already listed. */
export function shortfallChips(
  triedTags: readonly string[],
  expandedTags: readonly string[],
  yieldRows: readonly { tag: string; flag: HashtagYieldFlag }[] = [],
): ShortfallChip[] {
  const expanded = new Set(normaliseHashtags(expandedTags));
  const flags = new Map(yieldRows.map((row) => [normaliseHashtags([row.tag])[0] ?? '', row.flag]));
  const chips = normaliseHashtags([
    ...triedTags,
    ...expandedTags,
    ...yieldRows.map((row) => row.tag),
  ]).map((tag) => ({
    tag,
    expanded: expanded.has(tag),
    yieldFlag: flags.get(tag) ?? null,
  }));
  return [...chips.filter((chip) => !chip.expanded), ...chips.filter((chip) => chip.expanded)];
}

/** Header for the shortfall card. The long funnel sentence stays off this line. */
export function shortfallHeadline(input: {
  finished: number;
  target: number;
  fresh: number;
  existing: number;
}): { title: string; detail: string } {
  const title = `Found ${input.finished} / ${input.target} creators`;
  const fresh = input.fresh === 1 ? '1 new' : `${input.fresh} new`;
  if (input.existing > 0) {
    const existing = input.existing === 1 ? '1 in CRM' : `${input.existing} in CRM`;
    return { title, detail: `${fresh} · ${existing}` };
  }
  return { title, detail: fresh };
}

/** Minimum creators when set, otherwise the result limit. */
export function discoveryShortfallTarget(
  minCreators: number | null | undefined,
  resultLimit: number | null | undefined,
): number | null {
  const minimum = Number(minCreators);
  if (Number.isFinite(minimum) && minimum >= 1) return Math.round(minimum);
  const limit = Number(resultLimit);
  if (Number.isFinite(limit) && limit >= 1) return Math.round(limit);
  return null;
}

/** Creators that counted toward the target. Prefers the stored finished figure. */
export function qualifyingFinished(funnel: DiscoveryFunnel): number {
  if (typeof funnel.finished === 'number' && Number.isFinite(funnel.finished)) {
    return Math.max(0, Math.round(funnel.finished));
  }
  return Math.max(0, funnel.saved) + Math.max(0, funnel.existing ?? 0);
}

export function joinTags(tags: readonly string[]): string {
  const list = normaliseHashtags(tags);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function countNoun(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/** Drop-off in plain British English. Uses only numbers already on the funnel. */
export function shortfallWhy(funnel: DiscoveryFunnel, finished: number, target: number): string {
  const parts = [
    countNoun(funnel.rawItems, 'video', 'videos'),
    countNoun(funnel.uniqueCreators, 'unique creator', 'unique creators'),
    countNoun(funnel.afterFollowers, 'in the follower band', 'in the follower band'),
  ];
  if (typeof funnel.afterBioExtract === 'number') {
    parts.push(countNoun(funnel.afterBioExtract, 'from bios', 'from bios'));
  }
  if (typeof funnel.afterProfileEnrich === 'number') {
    parts.push(countNoun(funnel.afterProfileEnrich, 'after profile lookup', 'after profile lookup'));
  }
  parts.push(countNoun(funnel.withEmail, 'with a public email', 'with a public email'));
  if (typeof funnel.existing === 'number') {
    parts.push(countNoun(funnel.existing, 'already in the CRM', 'already in the CRM'));
  }
  parts.push(countNoun(funnel.saved, 'new', 'new'));
  const toward = countNoun(finished, 'creator', 'creators');
  return `${parts.join(', ')}. ${toward}, short of ${target}.`;
}

export function shortfallPassNote(funnel: DiscoveryFunnel): string {
  const related = joinTags(funnel.fallbackTags ?? []);
  const bits: string[] = [];
  if (funnel.extraPass === 'page') bits.push('Extra pass: one more page.');
  else if (funnel.extraPass === 'fallback') {
    bits.push(related ? `Extra pass: related tags ${related}.` : 'Extra pass: related tags.');
  } else bits.push('No extra pass ran.');
  if (funnel.continueUsed === 'expand' && funnel.extraPass !== 'fallback') {
    bits.push(related ? `Continued once with ${related}.` : 'Continued once with related tags.');
  }
  return bits.join(' ');
}

export function triedTagsForSheet(funnel: DiscoveryFunnel, searched: readonly string[] = []): string[] {
  return normaliseHashtags([
    ...(funnel.hashtagYield ?? []).map((row) => row.tag),
    ...(funnel.triedTags ?? []),
    ...(funnel.fallbackTags ?? []),
    ...searched,
  ]);
}

/** Tags the button will search: at most two, none already tried, none denylisted. */
export function takeContinueTags(tags: readonly string[], blocked: readonly string[]): string[] {
  const skip = new Set(normaliseHashtags(blocked));
  return withoutDeniedTags(tags)
    .filter((tag) => !skip.has(tag))
    .slice(0, FALLBACK_TAG_CAP);
}

export function expandWithTagsLabel(tags: readonly string[]): string {
  const label = joinTags(takeContinueTags(tags, []));
  return label ? `Expand with ${label}` : 'Expand with related tags';
}

function withoutGeneric(tags: readonly string[]): string[] {
  return withoutDeniedTags(tags);
}

function expansionTiersForSheet(
  funnel: DiscoveryFunnel,
  input: {
    niche?: string | null;
    pitch?: string | null;
    appName?: string | null;
    history?: ExpansionRankInput['history'];
    packTags?: readonly string[];
    candidates?: readonly string[];
  },
  tried: readonly string[],
): ExpansionTier[] {
  const storedPlan = funnel.expansionPlan ?? [];
  const built = buildExpansionTiers({
    appName: input.appName,
    niche: input.niche,
    pitch: input.pitch,
    history: input.history,
    packTags: input.packTags,
    modelTags: [
      ...storedPlan.flatMap((tier) => tier.tags),
      ...(funnel.suggestedTags ?? []),
      ...(funnel.expansionPool ?? []),
      ...(input.candidates ?? []),
    ],
  });
  if (built.length > 0) return built;
  return storedPlan
    .map((tier) => ({
      tier: tier.tier,
      tags: tier.tags.filter((tag) => !tried.includes(tag) && !isGenericExpansionTag(tag)),
    }))
    .filter((tier) => tier.tags.length > 0);
}

function shortfallRoundNote(funnel: DiscoveryFunnel, tiersExhausted: boolean): string {
  if (funnel.expansionLog && funnel.expansionLog.length > 0) {
    return expansionResultMessage(funnel.expansionLog, {
      exhausted: tiersExhausted || funnel.expansionExhausted === true,
      metTarget: false,
    });
  }
  if (tiersExhausted) return 'Related tags are used up. Type your own hashtags to search again.';
  if (typeof funnel.expansionRounds === 'number' && funnel.expansionRounds > 1) {
    return `Last expand used ${funnel.expansionRounds} Apify rounds.`;
  }
  return '';
}

/** Ordered untried tags: caller ranking, then stored suggestions, then niche neighbours. */
export function expansionChoices(input: {
  tried: readonly string[];
  stored?: readonly string[];
  pool?: readonly string[];
  candidates?: readonly string[];
  niche?: string | null;
  pitch?: string | null;
  appName?: string | null;
}): { suggested: string[]; alternatives: string[] } {
  const tried = normaliseHashtags(input.tried);
  const ranked = withoutGeneric(input.candidates ?? []);
  const stored = withoutGeneric([...(input.stored ?? []), ...(input.pool ?? [])]);
  const neighbours = [
    ...semanticNeighbourTags({
      niche: input.niche,
      pitch: input.pitch,
      appName: input.appName,
      blocked: tried,
    }),
    ...localAdjacentHashtags(input.niche || '', tried),
  ];
  const skip = new Set(tried);
  const ordered = normaliseHashtags(ranked.length > 0 ? ranked : [...stored, ...neighbours]).filter(
    (tag) => !skip.has(tag),
  );
  return {
    suggested: ordered.slice(0, FALLBACK_TAG_CAP),
    alternatives: ordered.slice(FALLBACK_TAG_CAP, 8),
  };
}

/**
 * Sheet for a finished search that is still under the target.
 * Null when the target was met, or when there is no target.
 */
export function shortfallSheet(input: {
  funnel: DiscoveryFunnel | null | undefined;
  minCreators?: number | null;
  resultLimit?: number | null;
  niche?: string | null;
  pitch?: string | null;
  appName?: string | null;
  searchedTags?: readonly string[];
  history?: ExpansionRankInput['history'];
  packTags?: readonly string[];
  /** Pre-ranked tags (history, packs, neighbours). Generic tags are ignored. */
  candidates?: readonly string[];
  /** Keep the tag choices when the minimum was already met, for the collapsed expand section. */
  keepWhenMet?: boolean;
}): DiscoveryShortfall | null {
  const funnel = input.funnel;
  if (!funnel) return null;
  const target = discoveryShortfallTarget(input.minCreators, input.resultLimit);
  if (target == null) return null;
  const finished = qualifyingFinished(funnel);
  if (finished >= target && !input.keepWhenMet) return null;

  const triedTags = triedTagsForSheet(funnel, input.searchedTags ?? []);
  const tiers = expansionTiersForSheet(funnel, input, triedTags);
  const usingLive = Array.isArray(funnel.eligibleSuggestions);
  const liveTags = usingLive ? takeContinueTags(funnel.eligibleSuggestions ?? [], triedTags) : null;
  const storedNext = liveTags ?? takeContinueTags(funnel.suggestedTags ?? [], triedTags);
  const planned = planNextRound({ tiers, tried: triedTags });
  const suggestedTags = usingLive ? liveTags ?? [] : storedNext.length > 0 ? storedNext : planned.tags;
  const networkOnly = usingLive ? suggestedTags.length === 0 || funnel.networkOnly === true : false;
  const alternatives =
    storedNext.length > 0
      ? tierAlternatives(tiers, suggestedTags, triedTags).filter((tag) => !storedNext.includes(tag))
      : tierAlternatives(tiers, suggestedTags, triedTags);
  const pool = withoutDeniedTags(funnel.expansionPool ?? []).filter(
    (tag) => !triedTags.includes(tag) && !suggestedTags.includes(tag) && !alternatives.includes(tag),
  );
  const canExpand = suggestedTags.length > 0;
  const tiersExhausted = !canExpand;
  const nextTier =
    suggestedTags.map((tag) => tiers.find((tier) => tier.tags.includes(tag))?.tier).find((tier) => tier) ??
    planned.tier;
  const canRelaxEmail =
    funnel.continueUsed !== 'relax' &&
    funnel.emailRelaxed !== true &&
    funnel.requirePublicEmail !== false &&
    funnel.afterFollowers > funnel.withEmail;

  return {
    why: shortfallWhy(funnel, finished, target),
    passNote: shortfallPassNote(funnel),
    triedTags,
    expandedTags: normaliseHashtags(funnel.fallbackTags ?? []),
    suggestedTags,
    alternatives: [...alternatives, ...pool].slice(0, 6),
    expandLabel: 'Expand search',
    relaxLabel: 'Include creators without a public email',
    canExpand,
    tiersExhausted: networkOnly || tiersExhausted,
    networkOnly,
    suggestionNote: networkOnly ? funnel.suggestionNote || NO_ELIGIBLE_TAGS_NOTE : '',
    nextTier: nextTier ?? null,
    expansionRounds:
      typeof funnel.expansionRounds === 'number' && funnel.expansionRounds >= 1
        ? funnel.expansionRounds
        : null,
    roundNote: shortfallRoundNote(funnel, tiersExhausted),
    canRelaxEmail,
    target,
    finished,
    fresh: Math.max(0, funnel.saved),
    existing: Math.max(0, funnel.existing ?? 0),
  };
}

/** Store up to two untried tags when a run finishes short. Does not start Apify. */
export async function attachSuggestedTags(
  funnel: DiscoveryFunnel,
  input: {
    niche: string;
    current: readonly string[];
    pitch?: string | null;
    appName?: string | null;
    history?: ExpansionRankInput['history'];
    packTags?: readonly string[];
    minCreators?: number | null;
    resultLimit?: number | null;
    suggest?: typeof suggestFallbackHashtags;
    stats?: readonly TagStat[];
    scrapes?: readonly TagScrape[];
    campaignHashtags?: readonly string[];
    campaignScraped?: readonly string[];
    blockedTags?: readonly string[];
    categories?: readonly CategoryId[];
  },
): Promise<DiscoveryFunnel> {
  const target = discoveryShortfallTarget(input.minCreators, input.resultLimit);
  if (target == null || qualifyingFinished(funnel) >= target) return funnel;
  const yieldRows = funnel.hashtagYield ?? [];
  const categories =
    input.categories ??
    ((funnel.activeCategories ?? []).filter(isCategoryId).length > 0
      ? (funnel.activeCategories ?? []).filter(isCategoryId)
      : activeCategoryIds({
          appName: input.appName,
          valueProp: input.pitch,
          niches: input.niche ? [input.niche] : [],
          hashtags: funnel.triedTags,
        }));
  const tried = normaliseHashtags([
    ...input.current,
    ...(funnel.triedTags ?? []),
    ...(funnel.fallbackTags ?? []),
    ...yieldRows.map((row) => row.tag),
    ...(input.campaignHashtags ?? []),
    ...(input.campaignScraped ?? []),
  ]);
  const eligibility = {
    scrapes: input.scrapes,
    stats: input.stats,
    campaignHashtags: input.campaignHashtags,
    campaignScraped: input.campaignScraped,
    tried,
    extraBlocked: input.blockedTags,
  };
  const blockedList = [...ineligibleTagSet(eligibility)];
  const apply = (
    plannedTags: string[],
    extra: Partial<DiscoveryFunnel> = {},
    limit = FALLBACK_TAG_CAP,
  ): DiscoveryFunnel => {
    const planned = planEligibleSuggestions({
      ...eligibility,
      candidates: plannedTags,
      categories,
      limit,
    });
    const next: DiscoveryFunnel = {
      ...funnel,
      ...extra,
      suggestedTags: planned.tags,
      eligibleSuggestions: planned.tags,
      expansionExhausted: planned.networkOnly,
    };
    if (planned.networkOnly) {
      next.networkOnly = true;
      next.suggestionNote = planned.note;
    } else {
      delete next.networkOnly;
      delete next.suggestionNote;
    }
    if (planned.rotation && !next.categoryRotation) next.categoryRotation = planned.rotation;
    return next;
  };
  const rotation = planCategoryRotation({
    previousTags: yieldRows.map((row) => row.tag),
    previousFlags: yieldRows.map((row) => row.flag),
    tried,
    blocked: blockedList,
    stats: input.stats,
    categories,
  });
  if (rotation) {
    return apply(rotation.tags, {
      suggestedSource: 'niche',
      categoryRotation: rotation.message,
    });
  }
  const storedNext = takeContinueTags(funnel.suggestedTags ?? [], blockedList);
  const storedClean =
    storedNext.length > 0 &&
    ((funnel.expansionPlan?.length ?? 0) > 0 ||
      funnel.suggestedTags?.every((tag) => !isGenericExpansionTag(tag)));
  if (storedClean) {
    const fromPlan = (funnel.expansionPlan ?? []).flatMap((tier) => tier.tags);
    return apply([...storedNext, ...fromPlan], {
      ...(funnel.suggestedSource ? { suggestedSource: funnel.suggestedSource } : {}),
    });
  }
  let modelTags: string[] = [];
  let source: 'ai' | 'niche' = funnel.suggestedSource === 'ai' ? 'ai' : 'niche';
  const preview = buildExpansionTiers({
    history: input.history,
    packTags: input.packTags,
    niche: input.niche,
    pitch: input.pitch,
    appName: input.appName,
    blocked: blockedList,
  });
  const previewCount = preview.reduce((sum, tier) => sum + tier.tags.length, 0);
  if (previewCount < FALLBACK_TAG_CAP) {
    const suggest = input.suggest ?? suggestFallbackHashtags;
    const suggestion = await suggest({
      niche: input.niche,
      current: blockedList,
      pitch: input.pitch,
      appName: input.appName,
    });
    modelTags = suggestion.tags;
    if (suggestion.tags.length > 0) source = suggestion.source;
  }
  const expansionPlan = buildExpansionTiers({
    history: input.history,
    packTags: input.packTags,
    niche: input.niche,
    pitch: input.pitch,
    appName: input.appName,
    modelTags,
    blocked: blockedList,
  });
  const next = planNextRound({ tiers: expansionPlan, tried: blockedList });
  if (next.tags.length === 0) {
    const rotated = suggestionsForFunnel({
      ...eligibility,
      appName: input.appName,
      niche: input.niche,
      pitch: input.pitch,
      categories,
      expansionPlan,
    });
    if (rotated.tags.length === 0) return apply([], { suggestedSource: source, expansionPlan });
    return apply(rotated.tags, {
      suggestedSource: source,
      expansionPlan,
      ...(rotated.rotation ? { categoryRotation: rotated.rotation } : {}),
    });
  }
  const expansionPool = expansionPlan
    .flatMap((tier) => tier.tags)
    .filter((tag) => !next.tags.includes(tag) && !blockedList.includes(tag))
    .slice(0, 8);
  return apply(
    next.tags,
    {
      suggestedSource: source,
      expansionPlan,
      ...(next.tier ? { expansionTier: next.tier } : {}),
      ...(expansionPool.length > 0 ? { expansionPool } : {}),
    },
    next.tags.length,
  );
}
