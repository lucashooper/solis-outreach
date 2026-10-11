import { describe, expect, it, vi } from 'vitest';
import { discoverDemo } from '../discovery/demo.js';
import { extractEmailFromBio, enrichCreatorEmail } from '../discovery/email.js';
import { runDiscovery } from '../discovery/runDiscovery.js';
import { runApifyDiscovery } from '../discovery/apify.js';
import type { Campaign } from '../discovery/types.js';

const baseCampaign: Campaign = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Test',
  niches: ['fitness'],
  platforms: ['tiktok'],
  follower_min: 10000,
  follower_max: 500000,
  engagement_rate_min: null,
  result_limit: 20,
  auto_outreach: false,
  status: 'draft',
  app_name: 'TestApp',
  value_prop: 'test value',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('extractEmailFromBio', () => {
  it('extracts a simple email', () => {
    expect(extractEmailFromBio('Collabs: hello@example.com thanks')).toBe(
      'hello@example.com',
    );
  });

  it('returns null when no email', () => {
    expect(extractEmailFromBio('No contact here')).toBeNull();
  });

  it('lowercases the address', () => {
    expect(extractEmailFromBio('Biz: Hello@Example.COM')).toBe(
      'hello@example.com',
    );
  });

  it('reads common obfuscations and ignores mentions', () => {
    expect(extractEmailFromBio('name [at] domain.com')).toBe('name@domain.com');
    expect(extractEmailFromBio('name(at)domain.com')).toBe('name@domain.com');
    expect(extractEmailFromBio('name [at] domain [dot] com')).toBe('name@domain.com');
    expect(extractEmailFromBio('email: name @ domain.com')).toBe('name@domain.com');
    expect(extractEmailFromBio('name @ domain . com')).toBe('name@domain.com');
    expect(extractEmailFromBio('meet me @ the park')).toBeNull();
    expect(extractEmailFromBio('follow @booktok')).toBeNull();
    expect(extractEmailFromBio('see @ instagram.com')).toBeNull();
  });
});

describe('enrichCreatorEmail', () => {
  it('prefers existing email over bio', () => {
    expect(
      enrichCreatorEmail({
        bio: 'x@bio.demo',
        existingEmail: 'existing@demo.com',
      }),
    ).toBe('existing@demo.com');
  });

  it('falls back to bio regex', () => {
    expect(enrichCreatorEmail({ bio: 'mail me at a@b.co' })).toBe('a@b.co');
  });

  it('ignores blank and placeholder addresses', () => {
    expect(enrichCreatorEmail({ existingEmail: '  ', bio: 'real@example.com' })).toBe(
      'real@example.com',
    );
    expect(enrichCreatorEmail({ existingEmail: 'n/a', bio: 'no contact' })).toBeNull();
    expect(enrichCreatorEmail({ existingEmail: 'none' })).toBeNull();
  });
});

describe('discoverDemo', () => {
  it('returns fitness tiktok creators within follower range', () => {
    const results = discoverDemo(baseCampaign);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(20);
    for (const c of results) {
      expect(c.platform).toBe('tiktok');
      expect(c.niches).toContain('fitness');
      expect(c.follower_count).toBeGreaterThanOrEqual(10000);
      expect(c.follower_count).toBeLessThanOrEqual(500000);
      expect(c.profile_url).toContain('tiktok.com');
    }
  });

  it('respects result_limit', () => {
    const results = discoverDemo({ ...baseCampaign, niches: [], platforms: [], result_limit: 5 });
    expect(results).toHaveLength(5);
  });

  it('filters by engagement_rate_min', () => {
    const results = discoverDemo({
      ...baseCampaign,
      niches: ['beauty'],
      platforms: ['instagram'],
      engagement_rate_min: 3.5,
    });
    for (const c of results) {
      expect(c.engagement_rate ?? 0).toBeGreaterThanOrEqual(3.5);
    }
  });

  it('is deterministic for the same campaign', () => {
    const a = discoverDemo(baseCampaign);
    const b = discoverDemo(baseCampaign);
    expect(a.map((c) => c.handle)).toEqual(b.map((c) => c.handle));
  });
});

describe('runDiscovery', () => {
  it('runs demo provider and enriches emails', async () => {
    const result = await runDiscovery(baseCampaign, 'demo');
    expect(result.provider).toBe('demo');
    expect(result.candidates.length).toBeGreaterThan(0);
    const withEmail = result.candidates.filter((c) => c.email);
    expect(withEmail.length).toBe(result.candidates.length);
  });

  it('keeps creators without an email only when the campaign allows it', async () => {
    const required = await runDiscovery(
      { ...baseCampaign, require_public_email: true, result_limit: 20 },
      'demo',
    );
    const optional = await runDiscovery(
      { ...baseCampaign, require_public_email: false, result_limit: 20 },
      'demo',
    );
    expect(required.candidates.every((row) => row.email)).toBe(true);
    expect(optional.candidates.some((row) => !row.email)).toBe(true);
    expect(optional.candidates.length).toBeGreaterThan(required.candidates.length);
  });
});

describe('runApifyDiscovery', () => {
  it('throws a clear error when token is missing', async () => {
    await expect(
      runApifyDiscovery(baseCampaign, { token: '', tiktokActorId: 'clockworks/tiktok-scraper' }),
    ).rejects.toThrow(/APIFY_TOKEN/);
  });

  it('starts actor, polls, and maps dataset items', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/runs?') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'run-1',
              defaultDatasetId: 'ds-1',
              status: 'RUNNING',
            },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/actor-runs/run-1')) {
        return new Response(
          JSON.stringify({
            data: { id: 'run-1', defaultDatasetId: 'ds-1', status: 'SUCCEEDED' },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/datasets/ds-1/items')) {
        return new Response(
          JSON.stringify([
            {
              text: 'hi contact@apifyuser.demo',
              webVideoUrl: 'https://www.tiktok.com/@apifyuser/video/1',
              playCount: 1000,
              authorMeta: {
                name: 'apifyuser',
                fans: 50000,
                signature: 'hi contact@apifyuser.demo',
                avatar: 'https://cdn.example/a.jpg',
              },
              videoMeta: { coverUrl: 'https://cdn.example/c.jpg' },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const result = await runApifyDiscovery(baseCampaign, {
      token: 'test-token',
      tiktokActorId: 'clockworks/tiktok-scraper',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    });
    expect(result.provider).toBe('apify');
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0]!.handle).toBe('apifyuser');
    expect(result.candidates[0]!.email).toBe('contact@apifyuser.demo');
    expect(result.candidates[0]!.top_videos?.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0]!.avatar_url).toContain('a.jpg');
    expect(result.funnel?.rawItems).toBe(1);
    expect(result.funnel?.apifyRunIds).toEqual(['run-1']);
  });

  it('emits creators while the actor dataset is still growing', async () => {
    let polls = 0;
    const emitted: string[][] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/runs?') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'run-live', defaultDatasetId: 'ds-live', status: 'RUNNING' },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/actor-runs/run-live')) {
        polls += 1;
        return new Response(
          JSON.stringify({
            data: {
              id: 'run-live',
              defaultDatasetId: 'ds-live',
              status: polls >= 2 ? 'SUCCEEDED' : 'RUNNING',
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/datasets/ds-live/items')) {
        const items = [
          {
            text: 'first',
            webVideoUrl: 'https://www.tiktok.com/@firstcreator/video/1',
            authorMeta: { name: 'firstcreator', fans: 20000, signature: 'hi first@demo.test' },
          },
        ];
        if (polls >= 1) {
          items.push({
            text: 'second',
            webVideoUrl: 'https://www.tiktok.com/@secondcreator/video/1',
            authorMeta: { name: 'secondcreator', fans: 30000, signature: 'second@demo.test' },
          });
        }
        return new Response(JSON.stringify(items), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await runApifyDiscovery(
      { ...baseCampaign, follower_min: 10000, follower_max: 500000, result_limit: 10 },
      {
        token: 'test-token',
        tiktokActorId: 'clockworks/tiktok-scraper',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollIntervalMs: 1,
        timeoutMs: 5000,
        onPartial: (rows) => {
          emitted.push(rows.map((row) => row.handle));
        },
      },
    );

    expect(emitted[0]).toEqual(['firstcreator']);
    expect(emitted.flat()).toContain('secondcreator');
    expect(result.candidates.map((row) => row.handle)).toEqual(
      expect.arrayContaining(['firstcreator', 'secondcreator']),
    );
  });

  it('keeps an in-range creator who has no public email and drops a missing follower count', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/runs?') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'run-2', defaultDatasetId: 'ds-2', status: 'SUCCEEDED' },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/datasets/ds-2/items')) {
        return new Response(
          JSON.stringify([
            {
              text: 'micro creator',
              webVideoUrl: 'https://www.tiktok.com/@nimyreads/video/1',
              authorMeta: { name: 'nimyreads', fans: 35000, signature: 'books' },
            },
            {
              text: 'missing fans',
              webVideoUrl: 'https://www.tiktok.com/@wattpad/video/1',
              authorMeta: { name: 'wattpad', fans: 0, heart: 1000000, signature: 'books' },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const result = await runApifyDiscovery(
      {
        ...baseCampaign,
        follower_min: 10000,
        follower_max: 76000,
        result_limit: 5,
        require_public_email: false,
      },
      {
        token: 'test-token',
        tiktokActorId: 'clockworks/tiktok-scraper',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollIntervalMs: 1,
        timeoutMs: 5000,
      },
    );
    expect(result.candidates.map((c) => c.handle)).toEqual(['nimyreads']);
    expect(result.candidates[0]!.email).toBeNull();
    expect(result.funnel).toMatchObject({
      rawItems: 2,
      uniqueCreators: 2,
      afterFollowers: 1,
      withEmail: 0,
      saved: 1,
    });
  });

  it('skips the profile lookup unless DISCOVERY_PROFILE_ENRICH is on', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { profiles?: string[] }) : null;
      if (url.includes('/runs?') && init?.method === 'POST') {
        const profile = Array.isArray(body?.profiles);
        return new Response(
          JSON.stringify({
            data: {
              id: profile ? 'run-profile' : 'run-videos',
              defaultDatasetId: profile ? 'ds-profile' : 'ds-videos',
              status: 'SUCCEEDED',
            },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/datasets/ds-videos/')) {
        return new Response(
          JSON.stringify([
            {
              webVideoUrl: 'https://www.tiktok.com/@reader/video/1',
              authorMeta: { name: 'reader', fans: 40000, signature: 'books' },
            },
            {
              webVideoUrl: 'https://www.tiktok.com/@famous/video/1',
              authorMeta: { name: 'famous', fans: 5000000, signature: 'hi@huge.example' },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/datasets/ds-profile/')) {
        return new Response(
          JSON.stringify([
            {
              webVideoUrl: 'https://www.tiktok.com/@reader/video/2',
              authorMeta: { name: 'reader', fans: 40000, signature: 'collabs reader@example.com' },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const result = await runApifyDiscovery(
      {
        ...baseCampaign,
        follower_min: 5000,
        follower_max: 200000,
        result_limit: 15,
        require_public_email: true,
        niches: ['books'],
        hashtags: ['#booktok'],
      },
      {
        token: 'test-token',
        tiktokActorId: 'clockworks/tiktok-scraper',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollIntervalMs: 1,
        timeoutMs: 5000,
      },
    );

    expect(result.candidates.map((c) => c.handle)).toEqual(['reader']);
    expect(result.candidates[0]?.email).toBeNull();
    expect(result.funnel.afterProfileEnrich).toBeUndefined();
    expect(result.funnel).toMatchObject({
      afterFollowers: 1,
      afterBioExtract: 0,
      withEmail: 0,
      saved: 0,
    });
    const posts = fetchImpl.mock.calls.filter(
      (call) => String(call[0]).includes('/runs?') && call[1]?.method === 'POST',
    );
    expect(posts).toHaveLength(1);
  });

  it('looks up profiles only for in-range creators who still have no email', async () => {
    const previous = process.env.DISCOVERY_PROFILE_ENRICH;
    process.env.DISCOVERY_PROFILE_ENRICH = '1';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as { profiles?: string[] }) : null;
      if (url.includes('/runs?') && init?.method === 'POST') {
        const profile = Array.isArray(body?.profiles);
        return new Response(
          JSON.stringify({
            data: {
              id: profile ? 'run-profile' : 'run-videos',
              defaultDatasetId: profile ? 'ds-profile' : 'ds-videos',
              status: 'SUCCEEDED',
            },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/datasets/ds-videos/')) {
        return new Response(
          JSON.stringify([
            {
              webVideoUrl: 'https://www.tiktok.com/@reader/video/1',
              authorMeta: { name: 'reader', fans: 40000, signature: 'books' },
            },
            {
              webVideoUrl: 'https://www.tiktok.com/@famous/video/1',
              authorMeta: { name: 'famous', fans: 5000000, signature: 'hi@huge.example' },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/datasets/ds-profile/')) {
        return new Response(
          JSON.stringify([
            {
              webVideoUrl: 'https://www.tiktok.com/@reader/video/2',
              authorMeta: { name: 'reader', fans: 40000, signature: 'collabs reader@example.com' },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    try {
      const result = await runApifyDiscovery(
        {
          ...baseCampaign,
          follower_min: 5000,
          follower_max: 200000,
          result_limit: 15,
          require_public_email: true,
          niches: ['books'],
          hashtags: ['#booktok'],
        },
        {
          token: 'test-token',
          tiktokActorId: 'clockworks/tiktok-scraper',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          pollIntervalMs: 1,
          timeoutMs: 5000,
        },
      );

      expect(result.candidates.map((c) => c.handle)).toEqual(['reader']);
      expect(result.candidates[0]?.email).toBe('reader@example.com');
      expect(result.funnel).toMatchObject({
        afterFollowers: 1,
        afterBioExtract: 0,
        afterProfileEnrich: 1,
        withEmail: 1,
        saved: 1,
      });
      const posts = fetchImpl.mock.calls.filter(
        (call) => String(call[0]).includes('/runs?') && call[1]?.method === 'POST',
      );
      expect(posts).toHaveLength(2);
      const profileBody = JSON.parse(String(posts[1]?.[1]?.body)) as { profiles?: string[] };
      expect(profileBody.profiles).toEqual(['reader']);
    } finally {
      if (previous === undefined) delete process.env.DISCOVERY_PROFILE_ENRICH;
      else process.env.DISCOVERY_PROFILE_ENRICH = previous;
    }
  });

  it('scores hashtag yield from creators already collected', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/runs?') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'run-yield', defaultDatasetId: 'ds-yield', status: 'SUCCEEDED' },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/datasets/ds-yield/items')) {
        return new Response(
          JSON.stringify([
            {
              text: 'reading #booktok',
              hashtags: [{ name: 'booktok' }],
              webVideoUrl: 'https://www.tiktok.com/@readerone/video/1',
              authorMeta: {
                name: 'readerone',
                fans: 20000,
                signature: 'hello readerone@example.com',
              },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const result = await runApifyDiscovery(
      {
        ...baseCampaign,
        niches: ['books'],
        hashtags: ['#booktok'],
        follower_min: 5000,
        follower_max: 100000,
        result_limit: 10,
        require_public_email: true,
      },
      {
        token: 'test-token',
        tiktokActorId: 'clockworks/tiktok-scraper',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollIntervalMs: 1,
        timeoutMs: 5000,
      },
    );

    expect(result.funnel?.hashtagYield?.map((row) => row.tag)).toContain('#booktok');
    expect(result.funnel?.extraPass).toBeUndefined();
  });

  it('runs one fallback pass when asked and skips the minimum-creators page', async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/runs?') && init?.method === 'POST') {
        posts += 1;
        return new Response(
          JSON.stringify({
            data: {
              id: `run-fb-${posts}`,
              defaultDatasetId: `ds-fb-${posts}`,
              status: 'SUCCEEDED',
            },
          }),
          { status: 201 },
        );
      }
      if (url.includes('/datasets/ds-fb-1/items')) {
        return new Response(
          JSON.stringify([
            {
              text: 'one #fitness',
              webVideoUrl: 'https://www.tiktok.com/@fitone/video/1',
              authorMeta: { name: 'fitone', fans: 20000, signature: 'fitone@example.com' },
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes('/datasets/ds-fb-')) {
        return new Response(
          JSON.stringify([
            {
              text: 'two',
              webVideoUrl: 'https://www.tiktok.com/@fittwo/video/1',
              authorMeta: { name: 'fittwo', fans: 22000, signature: 'fittwo@example.com' },
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const campaign = {
      ...baseCampaign,
      niches: ['fitness'],
      hashtags: ['#fitness'],
      follower_min: 5000,
      follower_max: 100000,
      result_limit: 10,
      min_creators: 8,
      require_public_email: false,
    };
    const options = {
      token: 'test-token',
      tiktokActorId: 'clockworks/tiktok-scraper',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 1,
      timeoutMs: 5000,
    };

    const withFallback = await runApifyDiscovery(campaign, { ...options, aiFallback: true });
    const fallbackPosts = fetchImpl.mock.calls.filter(
      (call) => String(call[0]).includes('/runs?') && call[1]?.method === 'POST',
    );
    expect(fallbackPosts).toHaveLength(2);
    expect(withFallback.funnel?.extraPass).toBe('fallback');
    expect(withFallback.funnel?.fallbackTags?.length).toBeGreaterThan(0);
    expect(withFallback.candidates.map((row) => row.handle)).toEqual(
      expect.arrayContaining(['fitone', 'fittwo']),
    );

    fetchImpl.mockClear();
    const withoutFallback = await runApifyDiscovery(campaign, options);
    const pagePosts = fetchImpl.mock.calls.filter(
      (call) => String(call[0]).includes('/runs?') && call[1]?.method === 'POST',
    );
    expect(pagePosts).toHaveLength(2);
    expect(withoutFallback.funnel?.extraPass).toBe('page');
    expect(withoutFallback.funnel?.fallbackTags).toBeUndefined();
  });
});
