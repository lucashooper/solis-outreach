import type { SupabaseClient } from '@supabase/supabase-js';
import { asDiscoveryFunnel } from './funnel.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCreatorId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Valid creator ids, de-duplicated, minus any id in `skip`. */
export function creatorIdsToLink(
  ids: readonly string[] | null | undefined,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids ?? []) {
    const trimmed = String(id).trim();
    if (!isCreatorId(trimmed) || skip.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * CRM rows are a view on top of this campaign.
 * The toggle hides them. A row Accept has linked stays visible either way.
 */
export function showsWhenIncludeExisting(
  alreadyInCrm: boolean,
  includeExisting: boolean,
  linked = false,
): boolean {
  if (!alreadyInCrm || linked) return true;
  return includeExisting;
}

/**
 * Creators that count toward the campaign target.
 * CRM matches count only when the campaign has Include CRM creators on.
 */
export function creatorsTowardTarget(fresh: number, existing: number, includeCrm: boolean): number {
  const next = Math.max(0, Math.round(Number(fresh)) || 0);
  if (!includeCrm) return next;
  return next + Math.max(0, Math.round(Number(existing)) || 0);
}

/** Drop CRM matches from a Discover result when Include CRM creators is off. */
export function discoveryHitsForInclude<T extends { existing?: boolean }>(
  hits: readonly T[],
  includeExisting: boolean,
): T[] {
  if (includeExisting) return hits.slice();
  return hits.filter((hit) => hit.existing !== true);
}

/** Copy under the toggle. The sentence matches the switch, so Off never says the rows stay listed. */
export function includeExistingDetail(checked: boolean, count: number): string {
  const n = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  const state = checked ? 'On.' : 'Off.';
  if (n > 0) {
    const noun = n === 1 ? '1 already in the CRM is' : `${n} already in the CRM are`;
    return checked ? `${state} ${noun} in this list.` : `${state} ${noun} hidden.`;
  }
  return checked
    ? `${state} Creators already in the CRM stay in this list.`
    : `${state} Creators already in the CRM stay hidden.`;
}

export interface BatchLinkPlan {
  /** Creator rows to attach. Does not include rows this campaign already owns or already links. */
  insertIds: string[];
  /** Every link this accept is responsible for, so Undo can remove just those. */
  batchLinkedIds: string[];
}

/**
 * Which CRM ids Accept should attach.
 * `allowedIds` are rows that exist on this app. Owned rows already use creators.campaign_id.
 */
export function planCampaignBatchLinks(input: {
  existingIds?: readonly string[] | null;
  ownedIds?: readonly string[] | null;
  alreadyLinkedIds?: readonly string[] | null;
  priorBatchIds?: readonly string[] | null;
  allowedIds?: readonly string[] | null;
}): BatchLinkPlan {
  const owned = new Set(creatorIdsToLink(input.ownedIds));
  const already = new Set(creatorIdsToLink(input.alreadyLinkedIds));
  const allowed = new Set(creatorIdsToLink(input.allowedIds));
  const requested = creatorIdsToLink(input.existingIds, owned).filter((id) => allowed.has(id));
  const insertIds = requested.filter((id) => !already.has(id));
  const batchLinkedIds = creatorIdsToLink([...(input.priorBatchIds ?? []), ...insertIds]);
  return { insertIds, batchLinkedIds };
}

export function acceptBatchMessage(linked: number): string {
  const n = Number.isFinite(linked) ? Math.max(0, Math.round(linked)) : 0;
  if (n === 0) return 'Kept this batch.';
  if (n === 1) return 'Kept this batch. 1 creator already in the CRM is now on this campaign.';
  return `Kept this batch. ${n} creators already in the CRM are now on this campaign.`;
}

/** Owned campaign rows, then linked CRM rows, then unlinked CRM matches. One row per creator. */
export function mergeCampaignCreatorRows<T extends { id: string }>(input: {
  owned: readonly T[];
  linked: readonly T[];
  extras: readonly T[];
}): Array<T & { alreadyInCrm?: true; linked?: true }> {
  const seen = new Set<string>();
  const out: Array<T & { alreadyInCrm?: true; linked?: true }> = [];
  for (const row of input.owned) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ ...row });
  }
  for (const row of input.linked) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ ...row, alreadyInCrm: true, linked: true });
  }
  for (const row of input.extras) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ ...row, alreadyInCrm: true });
  }
  return out;
}

export interface CampaignBatchResult {
  statusCode: number;
  body: Record<string, unknown>;
}

interface CreatorOwnerRow {
  id: string;
  app_id: string | null;
  campaign_id: string | null;
}

function missingLinksTable(message: string): boolean {
  return /campaign_creator_links|schema cache/i.test(message);
}

async function loadLatestRun(
  sb: SupabaseClient,
  campaignId: string,
  runId: string | null,
): Promise<{ id: string; funnel: unknown } | null | { error: string }> {
  let query = sb.from('discovery_runs').select('id, funnel').eq('campaign_id', campaignId);
  if (runId) {
    if (!isCreatorId(runId)) return { error: 'That run id is not valid.' };
    query = query.eq('id', runId);
  } else {
    query = query.order('created_at', { ascending: false }).limit(1);
  }
  const { data, error } = await query.maybeSingle();
  if (error) return { error: error.message };
  if (!data?.id) return null;
  return { id: String(data.id), funnel: data.funnel };
}

/**
 * Link this run's CRM matches onto the campaign.
 * Does not insert creator rows, move creators.campaign_id, change outreach, or send email.
 */
export async function acceptCampaignBatch(
  sb: SupabaseClient,
  campaignId: string,
  runId: string | null = null,
): Promise<CampaignBatchResult> {
  if (!isCreatorId(campaignId)) {
    return { statusCode: 400, body: { ok: false, error: 'That campaign id is not valid.' } };
  }
  const { data: campaign, error: campErr } = await sb
    .from('campaigns')
    .select('id, app_id')
    .eq('id', campaignId)
    .maybeSingle();
  if (campErr) return { statusCode: 500, body: { ok: false, error: campErr.message } };
  if (!campaign) return { statusCode: 404, body: { ok: false, error: 'Campaign not found.' } };

  const run = await loadLatestRun(sb, campaignId, runId);
  if (run && 'error' in run) return { statusCode: 400, body: { ok: false, error: run.error } };
  if (!run) return { statusCode: 409, body: { ok: false, error: 'Run Find creators before accepting a batch.' } };
  const funnel = asDiscoveryFunnel(run.funnel);
  if (!funnel) {
    return { statusCode: 409, body: { ok: false, error: 'Run Find creators before accepting a batch.' } };
  }

  const requested = creatorIdsToLink(funnel.existingCreatorIds);
  let owners: CreatorOwnerRow[] = [];
  if (requested.length > 0) {
    const { data, error } = await sb
      .from('creators')
      .select('id, app_id, campaign_id')
      .in('id', requested);
    if (error) return { statusCode: 500, body: { ok: false, error: error.message } };
    owners = (data ?? []) as CreatorOwnerRow[];
  }
  const appId = typeof campaign.app_id === 'string' ? campaign.app_id : null;
  const allowedIds = owners
    .filter((row) => !appId || row.app_id === appId)
    .map((row) => row.id);
  const ownedIds = owners.filter((row) => row.campaign_id === campaignId).map((row) => row.id);

  const { data: linkRows, error: linkErr } = await sb
    .from('campaign_creator_links')
    .select('creator_id')
    .eq('campaign_id', campaignId);
  if (linkErr) {
    return {
      statusCode: missingLinksTable(linkErr.message) ? 503 : 500,
      body: {
        ok: false,
        error: missingLinksTable(linkErr.message)
          ? 'Campaign creator links are not set up yet. Apply the latest Supabase migration.'
          : linkErr.message,
      },
    };
  }
  const alreadyLinkedIds = (linkRows ?? []).map((row) => String(row.creator_id));
  const plan = planCampaignBatchLinks({
    existingIds: funnel.existingCreatorIds,
    ownedIds,
    alreadyLinkedIds,
    priorBatchIds: funnel.batchLinkedIds,
    allowedIds,
  });
  if (plan.insertIds.length > 0) {
    const { error: insertErr } = await sb.from('campaign_creator_links').upsert(
      plan.insertIds.map((creatorId) => ({ campaign_id: campaignId, creator_id: creatorId })),
      { onConflict: 'campaign_id,creator_id', ignoreDuplicates: true },
    );
    if (insertErr) {
      return {
        statusCode: missingLinksTable(insertErr.message) ? 503 : 500,
        body: {
          ok: false,
          error: missingLinksTable(insertErr.message)
            ? 'Campaign creator links are not set up yet. Apply the latest Supabase migration.'
            : insertErr.message,
        },
      };
    }
  }

  const raw =
    run.funnel && typeof run.funnel === 'object' && !Array.isArray(run.funnel)
      ? { ...(run.funnel as Record<string, unknown>) }
      : {};
  const nextFunnel: Record<string, unknown> = { ...raw, batchAccepted: true };
  if (plan.batchLinkedIds.length > 0) nextFunnel.batchLinkedIds = plan.batchLinkedIds;
  else delete nextFunnel.batchLinkedIds;
  const { error: updateErr } = await sb.from('discovery_runs').update({ funnel: nextFunnel }).eq('id', run.id);
  if (updateErr) return { statusCode: 500, body: { ok: false, error: updateErr.message } };

  return {
    statusCode: 200,
    body: {
      ok: true,
      linked: plan.insertIds.length,
      creatorIds: plan.batchLinkedIds,
      message: acceptBatchMessage(plan.insertIds.length),
    },
  };
}

/** Drop the links this accept added. Creator rows, campaign ownership, and email stay untouched. */
export async function undoCampaignBatch(
  sb: SupabaseClient,
  campaignId: string,
  runId: string | null = null,
): Promise<CampaignBatchResult> {
  if (!isCreatorId(campaignId)) {
    return { statusCode: 400, body: { ok: false, error: 'That campaign id is not valid.' } };
  }
  const run = await loadLatestRun(sb, campaignId, runId);
  if (run && 'error' in run) return { statusCode: 400, body: { ok: false, error: run.error } };
  if (!run) return { statusCode: 409, body: { ok: false, error: 'No discovery run to undo.' } };
  const funnel = asDiscoveryFunnel(run.funnel);
  const removeIds = creatorIdsToLink(funnel?.batchLinkedIds);
  if (removeIds.length > 0) {
    const { error } = await sb
      .from('campaign_creator_links')
      .delete()
      .eq('campaign_id', campaignId)
      .in('creator_id', removeIds);
    if (error) {
      return {
        statusCode: missingLinksTable(error.message) ? 503 : 500,
        body: {
          ok: false,
          error: missingLinksTable(error.message)
            ? 'Campaign creator links are not set up yet. Apply the latest Supabase migration.'
            : error.message,
        },
      };
    }
  }
  const raw =
    run.funnel && typeof run.funnel === 'object' && !Array.isArray(run.funnel)
      ? { ...(run.funnel as Record<string, unknown>) }
      : {};
  delete raw.batchAccepted;
  delete raw.batchLinkedIds;
  const { error: updateErr } = await sb.from('discovery_runs').update({ funnel: raw }).eq('id', run.id);
  if (updateErr) return { statusCode: 500, body: { ok: false, error: updateErr.message } };
  return {
    statusCode: 200,
    body: {
      ok: true,
      removed: removeIds.length,
      message: 'Took this batch back off the campaign.',
    },
  };
}
