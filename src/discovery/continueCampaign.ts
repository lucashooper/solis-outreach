import type { SupabaseClient } from '@supabase/supabase-js';
import type { Platform } from '../types.js';
import {
  actorForPlatform,
  buildFallbackActorInput,
  controlsForActorInput,
  runApifyActorAndGetItems,
} from './apify.js';
import { mapApifyDatasetItems } from './apifyParsers.js';
import { DISCOVERY_UNCONFIGURED, filterDiscoveryCandidates } from './discoveryJobs.js';
import { createApifyPool, summariseAccountSpend, type ApifyRoundSpend } from './apifyPool.js';
import { enrichCreatorEmail, hasUsablePublicEmail } from './email.js';
import {
  buildExpansionTiers,
  expansionResultMessage,
  EXPANSION_ROUNDS_PER_CLICK,
  parseCustomHashtags,
  planNextRound,
  shouldChainRound,
  tierOfTag,
  type ExpansionRoundLog,
  type ExpansionTierIndex,
} from './expansionTiers.js';
import { suggestFallbackHashtags } from './fallbackTags.js';
import { asDiscoveryFunnel, RESULT_LIMIT_MAX, wantsPublicEmail } from './funnel.js';
import { sampleCountsForTags, scoreHashtagYield, type HashtagYield } from './hashtagYield.js';
import { discoveryRunBudgetUsd, fitsRunBudget } from './budget.js';
import { activeCategoryIds } from './categories.js';
import { asDiscoverySource } from './network.js';
import { loadRecentTagScrapes, loadTagStats, recordTagRounds, recordTagScrapes } from './networkStore.js';
import { isSuppressed } from './tagMemory.js';
import { chooseExpansionTags, ineligibleTagSet, NO_ELIGIBLE_TAGS_NOTE, planEligibleSuggestions } from './eligibleTags.js';
import { cooldownMessage } from './tagCooldown.js';
import {
  creatorMatchKey,
  discoveryQueryKey,
  lookupKnownCreatorIds,
  readDiscoveryCache,
} from './queryCache.js';
import { takeContinueTags } from './shortfall.js';
import type { Campaign, CreatorCandidate, DiscoveryFunnel } from './types.js';

export interface ContinueCampaignResult {
  statusCode: number;
  body: Record<string, unknown>;
}

function nicheLabel(campaign: Campaign): string {
  return (campaign.niches ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .join(' ');
}

function mergeYield(current: HashtagYield[] | undefined, incoming: HashtagYield[]): HashtagYield[] {
  const hashtagYield = [...(current ?? [])];
  for (const row of incoming) {
    const index = hashtagYield.findIndex((existing) => existing.tag === row.tag);
    if (index === -1) hashtagYield.push(row);
    else hashtagYield[index] = row;
  }
  return hashtagYield;
}

function triedFrom(funnel: DiscoveryFunnel | null, campaign: Campaign): string[] {
  return [
    ...(campaign.hashtags ?? []),
    ...(funnel?.triedTags ?? []),
    ...(funnel?.hashtagYield ?? []).map((row) => row.tag),
    ...(funnel?.fallbackTags ?? []),
  ];
}

/**
 * Continue a campaign find.
 * Expand searches the next untried tier, and if that round adds nobody it
 * tries the next tier, up to three Apify rounds. Custom hashtags search only
 * the tags Alex typed, still capped at two tags and three rounds. Relax
 * inserts in-range creators this batch already collected who have no public
 * email. Nothing here sends email, and require_public_email stays as saved.
 */
export async function continueCampaignSearch(
  sb: SupabaseClient,
  campaignId: string,
  body: unknown,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<ContinueCampaignResult> {
  const input = (body ?? {}) as Record<string, unknown>;
  const action =
    input.action === 'expand' || input.action === 'relax' || input.action === 'custom'
      ? input.action
      : null;
  if (!action) return { statusCode: 400, body: { ok: false, error: 'Choose expand, custom, or relax.' } };

  const { data: campaignRow, error: campErr } = await sb
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  if (campErr) return { statusCode: 500, body: { ok: false, error: campErr.message } };
  if (!campaignRow) return { statusCode: 404, body: { ok: false, error: 'Campaign not found.' } };
  const campaign = campaignRow as Campaign & { app_id?: string | null };
  const appId = typeof campaign.app_id === 'string' ? campaign.app_id : null;

  const { data: runRow, error: runErr } = await sb
    .from('discovery_runs')
    .select('id, funnel, results_count')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runErr) return { statusCode: 500, body: { ok: false, error: runErr.message } };
  const funnel = asDiscoveryFunnel(runRow?.funnel);
  if (!runRow || !funnel) {
    return { statusCode: 409, body: { ok: false, error: 'Run Find creators before continuing.' } };
  }

  if (action === 'expand' || action === 'custom') {
    const pool = createApifyPool({
      tokens: options?.token != null ? [options.token] : undefined,
      fetchImpl: options?.fetchImpl,
      exhausted: funnel.apifyExhausted,
    });
    if (!pool.configured) {
      return { statusCode: 503, body: { ok: false, configured: false, error: DISCOVERY_UNCONFIGURED } };
    }
    const accountRounds: ApifyRoundSpend[] = [...(funnel.apifyRounds ?? [])];
    const provided = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : [];
    const custom = action === 'custom' ? parseCustomHashtags(provided.join(', ')) : null;
    if (custom?.error) return { statusCode: 400, body: { ok: false, error: custom.error } };
    if (action === 'custom' && (custom?.tags.length ?? 0) === 0) {
      return { statusCode: 400, body: { ok: false, error: 'Enter one or more hashtags.' } };
    }
    const rawPlatform = (campaign.platforms ?? [])[0];
    const platform: Platform = rawPlatform === 'instagram' ? 'instagram' : 'tiktok';
    const goal = Math.max(1, Number(campaign.min_creators ?? campaign.result_limit) || 10);
    const niche = nicheLabel(campaign) || 'creator';
    let source: 'ai' | 'niche' = funnel.suggestedSource === 'ai' ? 'ai' : 'niche';
    let modelTags = [...(funnel.expansionPlan ?? []).flatMap((tier) => tier.tags)];
    const seedTried = triedFrom(funnel, campaign);
    const preview = buildExpansionTiers({
      appName: campaign.app_name,
      niche,
      pitch: campaign.value_prop,
      modelTags,
    });
    if (
      action === 'expand' &&
      preview.reduce((sum, tier) => sum + tier.tags.length, 0) < 2
    ) {
      const suggestion = await suggestFallbackHashtags({
        niche,
        current: seedTried,
        pitch: campaign.value_prop,
        appName: campaign.app_name,
      });
      modelTags = [...modelTags, ...suggestion.tags];
      if (suggestion.tags.length > 0) source = suggestion.source;
    }
    const tagStats = appId ? await loadTagStats(sb, appId) : [];
    const cooling = appId ? await loadRecentTagScrapes(sb, appId) : [];
    const blockedTags = [
      ...cooling.map((row) => row.tag),
      ...tagStats.filter((stat) => isSuppressed(stat)).map((stat) => stat.tag),
      ...(campaign.hashtags ?? []),
    ];
    const tiers = buildExpansionTiers({
      appName: campaign.app_name,
      niche,
      pitch: campaign.value_prop,
      modelTags,
      blocked: [
        ...blockedTags,
        ...ineligibleTagSet({
          scrapes: cooling,
          stats: tagStats,
          campaignHashtags: campaign.hashtags ?? [],
          tried: triedFrom(funnel, campaign),
        }),
      ],
    });
    let working: DiscoveryFunnel = { ...funnel, expansionCascade: true, expansionLog: [], expansionPlan: tiers };
    const categories = activeCategoryIds({
      appName: campaign.app_name,
      valueProp: campaign.value_prop,
      niches: campaign.niches,
      hashtags: campaign.hashtags,
    });
    const log: ExpansionRoundLog[] = [];
    let totalAdded = 0;
    let resultsCount = Number(runRow.results_count ?? 0);

    try {
      for (let round = 0; round < EXPANSION_ROUNDS_PER_CLICK; round += 1) {
        const tried = triedFrom(working, campaign);
        const finishedNow =
          typeof working.finished === 'number'
            ? working.finished
            : working.saved + (working.existing ?? 0);
        if (finishedNow >= goal) break;
        let tags: string[] = [];
        let tier: ExpansionTierIndex | null = null;
        if (custom) {
          tags = takeContinueTags(custom.tags, tried);
        } else {
          const scrapes = appId ? await loadRecentTagScrapes(sb, appId) : cooling;
          const requested = round === 0 && provided.length > 0 ? provided : undefined;
          const choice = chooseExpansionTags({
            requested,
            tiers,
            categories,
            stats: tagStats,
            scrapes,
            campaignHashtags: campaign.hashtags ?? [],
            campaignScraped: [...blockedTags, ...tried],
            tried,
            extraBlocked: blockedTags,
          });
          tags = choice.tags;
          tier = tags.map((tag) => tierOfTag(tiers, tag)).find((value) => value != null) ?? null;
          if (choice.rotation) working = { ...working, categoryRotation: choice.rotation };
          if (choice.skipped.length > 0) working = { ...working, skippedTags: choice.skipped };
          if (tags.length === 0) {
            working = {
              ...working,
              expansionExhausted: true,
              expansionPlan: tiers,
              networkOnly: true,
              suggestionNote: choice.note || NO_ELIGIBLE_TAGS_NOTE,
              suggestedTags: [],
              eligibleSuggestions: [],
              ...(choice.skipped.length > 0 ? { reason: 'tags_on_cooldown' as const } : {}),
            };
            break;
          }
        }
        if (tags.length === 0) {
          const later = planEligibleSuggestions({
            tiers,
            categories,
            stats: tagStats,
            scrapes: cooling,
            campaignHashtags: campaign.hashtags ?? [],
            campaignScraped: [...blockedTags, ...tried],
            tried,
            extraBlocked: blockedTags,
          });
          working = {
            ...working,
            expansionExhausted: later.tags.length === 0,
            expansionPlan: tiers,
            suggestedTags: later.tags,
            eligibleSuggestions: later.tags,
            ...(later.networkOnly ? { networkOnly: true, suggestionNote: later.note } : {}),
          };
          break;
        }
        const actorInput = buildFallbackActorInput(platform, tags);
        if (!actorInput) break;
        const budgetUsd = working.runBudgetUsd ?? discoveryRunBudgetUsd();
        const spentUsd = working.runSpentUsd ?? 0;
        const charge = controlsForActorInput(actorInput).maxTotalChargeUsd;
        if (!fitsRunBudget(spentUsd, charge, budgetUsd)) {
          working = {
            ...working,
            runBudgetNote: `Run budget of $${budgetUsd.toFixed(2)} is used, so no further Apify calls were made.`,
          };
          break;
        }
        const actorId = actorForPlatform(platform, {});
        const loaded = await runApifyActorAndGetItems(actorId, actorInput, { pool });
        const { items, runId, accountIndex, accountLabel, chargeUsd } = loaded;
        accountRounds.push({
          accountIndex,
          accountLabel,
          chargeUsd,
          ...(runId ? { runId } : {}),
          kind: 'expand',
        });
        working = {
          ...working,
          runBudgetUsd: budgetUsd,
          runSpentUsd: spentUsd + chargeUsd,
          apifyRounds: accountRounds,
          apifyAccounts: summariseAccountSpend(accountRounds),
          ...(pool.exhaustedIndexes().length > 0 ? { apifyExhausted: pool.exhaustedIndexes() } : {}),
        };
        const mapped = mapApifyDatasetItems(items, platform, campaign.niches ?? []);
        const inRange = filterDiscoveryCandidates(mapped, {
          followerMin: campaign.follower_min,
          followerMax: campaign.follower_max,
          limit: Math.max(mapped.length, 1),
        });
        const requireEmail = wantsPublicEmail(campaign.require_public_email);
        const known = await lookupKnownCreatorIds(sb, appId, inRange);
        const fresh = inRange.filter((row) => !known.has(creatorMatchKey(row.platform, row.handle)));
        const room = Math.min(RESULT_LIMIT_MAX, Math.max(0, goal - finishedNow));
        const toSave = fresh
          .filter((row) => !requireEmail || hasUsablePublicEmail(enrichCreatorEmail({
            bio: row.bio,
            handle: row.handle,
            existingEmail: row.email,
          })))
          .slice(0, room);
        const added = await insertFreshCreators(sb, campaign.id, appId, toSave);
        const yieldRows = scoreHashtagYield(tags, inRange, requireEmail, sampleCountsForTags(tags, items.length));
        if (appId) {
          await recordTagScrapes(sb, appId, tags);
          await recordTagRounds(
            sb,
            appId,
            yieldRows.map((row) => ({
              tag: row.tag,
              videos: row.sampled ?? 0,
              inRange: row.creators,
              withEmail: row.withEmail,
              newSaved: requireEmail ? row.withEmail : row.creators,
            })),
          );
        }
        const hashtagYield = mergeYield(working.hashtagYield, yieldRows);
        const triedTags = [...new Set([...(working.triedTags ?? []), ...tags])];
        totalAdded += added;
        resultsCount += added;
        const nextFinished = finishedNow + added;
        log.push({ tags, added, ...(tier ? { tier } : {}) });
        const freshScrapes = appId ? await loadRecentTagScrapes(sb, appId) : cooling;
        const customNext = custom ? planNextRound({ tiers, tried: triedTags }) : null;
        const freshNext = custom
          ? null
          : planEligibleSuggestions({
              tiers,
              categories,
              stats: tagStats,
              scrapes: freshScrapes,
              campaignHashtags: campaign.hashtags ?? [],
              campaignScraped: [...blockedTags, ...triedTags],
              tried: triedTags,
              extraBlocked: blockedTags,
            });
        const upcomingTags = customNext?.tags ?? freshNext?.tags ?? [];
        const customLeft = custom ? takeContinueTags(custom.tags, triedTags) : [];
        working = {
          ...working,
          rawItems: working.rawItems + items.length,
          saved: working.saved + added,
          finished: nextFinished,
          fallbackTags: tags,
          fallbackSource: source,
          continueUsed: 'expand',
          triedTags,
          expansionPlan: tiers,
          ...(tier ? { expansionTier: tier } : {}),
          expansionRounds: log.length,
          expansionLog: log,
          expansionCascade: false,
          expansionExhausted: customNext ? customNext.exhausted : upcomingTags.length === 0,
          suggestedTags: upcomingTags,
          eligibleSuggestions: upcomingTags,
          ...(freshNext?.networkOnly
            ? { networkOnly: true, suggestionNote: freshNext.note }
            : {}),
          ...(freshNext?.rotation ? { categoryRotation: freshNext.rotation } : {}),
          ...(hashtagYield.length > 0 ? { hashtagYield } : {}),
          apifyRunIds: [...working.apifyRunIds, runId].filter((id): id is string => Boolean(id)),
        };
        await sb.from('discovery_runs').update({
          funnel: working,
          results_count: resultsCount,
        }).eq('id', runRow.id);
        const weakRound =
          !custom &&
          yieldRows.length > 0 &&
          yieldRows.every((row) => row.flag === 'thin' || row.flag === 'low');
        if (!shouldChainRound({
          added,
          roundsUsed: log.length,
          finished: nextFinished,
          target: goal,
          exhausted: custom ? customLeft.length === 0 : upcomingTags.length === 0,
          custom: Boolean(custom),
        }) && !(weakRound && nextFinished < goal)) {
          break;
        }
      }
    } catch (err) {
      if (log.length === 0) {
        await sb.from('discovery_runs').update({ funnel }).eq('id', runRow.id);
        const message = err instanceof Error ? err.message : 'Apify did not start the extra search.';
        return { statusCode: 502, body: { ok: false, error: message } };
      }
    }

    if (log.length === 0) {
      if (working.networkOnly) {
        await sb.from('discovery_runs').update({ funnel: working }).eq('id', runRow.id);
        return {
          statusCode: 200,
          body: {
            ok: true,
            action,
            added: 0,
            rounds: 0,
            networkOnly: true,
            eligibleSuggestions: [],
            funnel: working,
            message: working.suggestionNote || NO_ELIGIBLE_TAGS_NOTE,
          },
        };
      }
      const message = working.reason === 'tags_on_cooldown' && working.skippedTags?.length
        ? cooldownMessage(working.skippedTags)
        : working.expansionExhausted
        ? 'Related tags are used up. Type your own hashtags to search again.'
        : 'No related tags left to try.';
      await sb.from('discovery_runs').update({ funnel: working }).eq('id', runRow.id);
      return { statusCode: 400, body: { ok: false, error: message, funnel: working } };
    }

    if (input.addToCampaign === true && custom) {
      const searched = log.flatMap((row) => row.tags);
      const hashtags = [...new Set([...(campaign.hashtags ?? []), ...searched])];
      await sb.from('campaigns').update({ hashtags }).eq('id', campaign.id);
    }

    const finished =
      typeof working.finished === 'number' ? working.finished : working.saved + (working.existing ?? 0);
    const message = expansionResultMessage(log, {
      exhausted: working.expansionExhausted === true,
      metTarget: finished >= goal && totalAdded > 0,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        action,
        added: totalAdded,
        rounds: log.length,
        funnel: working,
        message,
      },
    };
  }

  if (!wantsPublicEmail(campaign.require_public_email) || funnel.requirePublicEmail === false) {
    return {
      statusCode: 400,
      body: { ok: false, error: 'Require public email is already off for this campaign.' },
    };
  }
  if (funnel.continueUsed === 'relax' || funnel.emailRelaxed === true) {
    return {
      statusCode: 409,
      body: { ok: false, error: 'Public email was already relaxed for this batch.' },
    };
  }
  const queryKey = discoveryQueryKey({
    niche: (campaign.niches ?? []).join(','),
    hashtags: campaign.hashtags,
    platforms: campaign.platforms,
    followerMin: campaign.follower_min,
    followerMax: campaign.follower_max,
    limit: campaign.result_limit,
    requirePublicEmail: true,
    source: asDiscoverySource(campaign.discovery_source) ?? 'both',
  });
  const cached = await readDiscoveryCache(sb, queryKey);
  if (!cached || cached.length === 0) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error:
          'This search did not keep creators without a public email, so there is nothing further to add without another Apify run.',
      },
    };
  }
  const known = await lookupKnownCreatorIds(sb, appId, cached);
  const fresh = cached.filter((row) => !known.has(creatorMatchKey(row.platform, row.handle)));
  const withoutEmail = fresh.filter(
    (row) => !hasUsablePublicEmail(enrichCreatorEmail({
      bio: row.bio,
      handle: row.handle,
      existingEmail: row.email,
    })),
  );
  const added = await insertFreshCreators(sb, campaign.id, appId, withoutEmail.slice(0, RESULT_LIMIT_MAX));
  const next: DiscoveryFunnel = {
    ...funnel,
    saved: funnel.saved + added,
    finished: (typeof funnel.finished === 'number' ? funnel.finished : funnel.saved + (funnel.existing ?? 0)) + added,
    continueUsed: 'relax',
    emailRelaxed: true,
    requirePublicEmail: true,
  };
  await sb.from('discovery_runs').update({
    funnel: next,
    results_count: Number(runRow.results_count ?? 0) + added,
  }).eq('id', runRow.id);
  const message =
    added === 0
      ? 'No further creators without a public email were kept from this batch. Require public email stays on.'
      : added === 1
        ? 'Kept 1 creator from this batch without a public email. Require public email stays on.'
        : `Kept ${added} creators from this batch without a public email. Require public email stays on.`;
  return { statusCode: 200, body: { ok: true, action: 'relax', added, funnel: next, message } };
}

async function insertFreshCreators(
  sb: SupabaseClient,
  campaignId: string,
  appId: string | null,
  rows: CreatorCandidate[],
): Promise<number> {
  if (rows.length === 0 || !appId) return 0;
  const payload = rows.map((candidate) => ({
    handle: candidate.handle.replace(/^@/, ''),
    platform: candidate.platform,
    bio: candidate.bio,
    email: enrichCreatorEmail({
      bio: candidate.bio,
      handle: candidate.handle,
      existingEmail: candidate.email,
    }),
    follower_count: candidate.follower_count,
    engagement_rate: candidate.engagement_rate,
    profile_url: candidate.profile_url,
    avatar_url: candidate.avatar_url ?? null,
    top_videos: candidate.top_videos ?? [],
    campaign_id: campaignId,
    app_id: appId,
    ai_variables: { niches: candidate.niches ?? [] },
    outreach_status: 'pending_review',
  }));
  const { data, error } = await sb
    .from('creators')
    .upsert(payload, { onConflict: 'app_id,platform,handle', ignoreDuplicates: true })
    .select('id');
  if (error) {
    console.warn('[discovery] continue insert skipped:', error.message);
    return 0;
  }
  return data?.length ?? 0;
}
