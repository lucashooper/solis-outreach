import { describe, expect, it } from 'vitest';
import {
  acceptBatchMessage,
  acceptCampaignBatch,
  creatorIdsToLink,
  creatorsTowardTarget,
  discoveryHitsForInclude,
  includeExistingDetail,
  mergeCampaignCreatorRows,
  planCampaignBatchLinks,
  showsWhenIncludeExisting,
  undoCampaignBatch,
} from '../discovery/campaignBatch.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const CRM = '11111111-1111-4111-8111-111111111111';
const OWNED = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('include existing toggle', () => {
  it('hides CRM rows while the toggle is off, and keeps linked rows either way', () => {
    expect(showsWhenIncludeExisting(false, false)).toBe(true);
    expect(showsWhenIncludeExisting(true, false)).toBe(false);
    expect(showsWhenIncludeExisting(true, true)).toBe(true);
    expect(showsWhenIncludeExisting(true, false, true)).toBe(true);
  });

  it('says hidden when the toggle is off and listed when it is on', () => {
    expect(includeExistingDetail(false, 12)).toBe('Off. 12 already in the CRM are hidden.');
    expect(includeExistingDetail(true, 12)).toBe('On. 12 already in the CRM are in this list.');
    expect(includeExistingDetail(false, 1)).toBe('Off. 1 already in the CRM is hidden.');
    expect(includeExistingDetail(true, 0)).toBe('On. Creators already in the CRM stay in this list.');
    expect(includeExistingDetail(false, 0)).toBe('Off. Creators already in the CRM stay hidden.');
  });

  it('does not count CRM creators toward the target when the switch is off', () => {
    expect(creatorsTowardTarget(12, 20, false)).toBe(12);
    expect(creatorsTowardTarget(12, 20, true)).toBe(32);
    expect(creatorsTowardTarget(0, 8, false)).toBe(0);
  });

  it('keeps CRM rows on the payload only when Include CRM creators is on', () => {
    const hits = [{ handle: 'new' }, { handle: 'known', existing: true }];
    expect(discoveryHitsForInclude(hits, false).map((hit) => hit.handle)).toEqual(['new']);
    expect(discoveryHitsForInclude(hits, true)).toHaveLength(2);
  });
});

describe('accept batch links', () => {
  it('links CRM matches and leaves creators this campaign already owns', () => {
    const plan = planCampaignBatchLinks({
      existingIds: [CRM, OWNED, 'nope', CRM],
      ownedIds: [OWNED],
      alreadyLinkedIds: [],
      allowedIds: [CRM, OWNED, OTHER],
    });
    expect(plan.insertIds).toEqual([CRM]);
    expect(plan.batchLinkedIds).toEqual([CRM]);
    expect(acceptBatchMessage(plan.insertIds.length)).toBe(
      'Kept this batch. 1 creator already in the CRM is now on this campaign.',
    );
    expect(acceptBatchMessage(12)).toBe(
      'Kept this batch. 12 creators already in the CRM are now on this campaign.',
    );
    expect(acceptBatchMessage(0)).toBe('Kept this batch.');
  });

  it('does not insert a link twice, and Undo keeps the ids from the first accept', () => {
    const again = planCampaignBatchLinks({
      existingIds: [CRM, OTHER],
      ownedIds: [],
      alreadyLinkedIds: [CRM],
      priorBatchIds: [CRM],
      allowedIds: [CRM, OTHER],
    });
    expect(again.insertIds).toEqual([OTHER]);
    expect(again.batchLinkedIds).toEqual([CRM, OTHER]);
    expect(creatorIdsToLink(['bad', CRM, CRM])).toEqual([CRM]);
  });

  it('shows linked CRM rows on the campaign list without duplicating owned rows', () => {
    const rows = mergeCampaignCreatorRows({
      owned: [{ id: OWNED, handle: 'new' }],
      linked: [
        { id: CRM, handle: 'crm' },
        { id: OWNED, handle: 'new-again' },
      ],
      extras: [
        { id: CRM, handle: 'crm-again' },
        { id: OTHER, handle: 'overlay' },
      ],
    });
    expect(rows).toEqual([
      { id: OWNED, handle: 'new' },
      { id: CRM, handle: 'crm', alreadyInCrm: true, linked: true },
      { id: OTHER, handle: 'overlay', alreadyInCrm: true },
    ]);
    expect(
      rows
        .filter((row) => showsWhenIncludeExisting(row.alreadyInCrm === true, false, row.linked === true))
        .map((row) => row.id),
    ).toEqual([OWNED, CRM]);
  });

  it('writes link rows and a funnel flag, and undo removes only those links', async () => {
    const state = {
      links: [] as Array<{ creator_id: string }>,
      funnel: {
        rawItems: 1,
        uniqueCreators: 1,
        afterFollowers: 1,
        afterDedupe: 1,
        withEmail: 1,
        saved: 0,
        existing: 1,
        existingCreatorIds: [CRM],
        followerMin: null,
        followerMax: null,
        apifyRunIds: [],
      } as Record<string, unknown>,
      writes: [] as string[],
    };
    const sb = {
      from(table: string) {
        const done = (data: unknown) => Promise.resolve({ data, error: null });
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          in() {
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          maybeSingle() {
            if (table === 'campaigns') return done({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', app_id: 'app-1' });
            if (table === 'discovery_runs') return done({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', funnel: state.funnel });
            return done(null);
          },
          upsert(rows: Array<{ creator_id: string }>) {
            state.writes.push(`${table}:upsert`);
            for (const row of rows) state.links.push({ creator_id: row.creator_id });
            return done(null);
          },
          update(values: { funnel?: Record<string, unknown> }) {
            return {
              eq() {
                state.writes.push(`${table}:update`);
                if (table === 'discovery_runs' && values.funnel) state.funnel = values.funnel;
                return done(null);
              },
            };
          },
          delete() {
            return {
              eq() {
                return {
                  in(_column: string, ids: string[]) {
                    state.writes.push(`${table}:delete`);
                    state.links = state.links.filter((row) => !ids.includes(row.creator_id));
                    return done(null);
                  },
                };
              },
            };
          },
          then(onFulfilled: (value: { data: unknown; error: null }) => unknown, onRejected?: (reason: unknown) => unknown) {
            const data =
              table === 'creators'
                ? [{ id: CRM, app_id: 'app-1', campaign_id: 'other-campaign' }]
                : table === 'campaign_creator_links'
                  ? state.links
                  : null;
            return done(data).then(onFulfilled, onRejected);
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient;

    const accepted = await acceptCampaignBatch(sb, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body.linked).toBe(1);
    expect(state.links).toEqual([{ creator_id: CRM }]);
    expect(state.funnel.batchAccepted).toBe(true);
    expect(state.funnel.batchLinkedIds).toEqual([CRM]);
    expect(state.writes).toEqual(['campaign_creator_links:upsert', 'discovery_runs:update']);

    const undone = await undoCampaignBatch(sb, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(undone.statusCode).toBe(200);
    expect(state.links).toEqual([]);
    expect(state.funnel.batchAccepted).toBeUndefined();
    expect(state.funnel.batchLinkedIds).toBeUndefined();
    expect(state.writes.filter((write) => write.startsWith('creators:'))).toEqual([]);
  });
});
