import { describe, expect, it } from 'vitest';
import { buildFallbackActorInput, controlsForActorInput } from '../discovery/apify.js';
import {
  localAdjacentHashtags,
  parseFallbackHashtags,
  suggestFallbackHashtags,
} from '../discovery/fallbackTags.js';
import { asDiscoveryFunnel } from '../discovery/funnel.js';
import {
  hashtagYieldHint,
  presentHashtagYield,
  scoreHashtagYield,
} from '../discovery/hashtagYield.js';

describe('scoreHashtagYield', () => {
  const creators = [
    {
      handle: 'ada',
      platform: 'tiktok',
      email: 'ada@example.com',
      engagement_rate: 4.2,
      raw: { hashtags: [{ name: 'booktok' }], text: 'reading #booktok' },
    },
    {
      handle: 'bea',
      platform: 'tiktok',
      email: 'bea@example.com',
      engagement_rate: 3,
      raw: { hashtags: ['booktok'] },
    },
    {
      handle: 'cy',
      platform: 'tiktok',
      email: 'cy@example.com',
      engagement_rate: 2.2,
      bio: 'collabs cy@example.com #booktok',
      raw: { hashtags: [{ name: 'booktok' }] },
    },
    {
      handle: 'dee',
      platform: 'tiktok',
      email: null,
      engagement_rate: 0.2,
      raw: { hashtags: [{ name: 'deepstash' }], text: 'quotes' },
    },
  ];

  it('flags a tag with public emails as strong and a dry tag as low yield', () => {
    const rows = scoreHashtagYield(['#booktok', '#deepstash', '#silent'], creators, true);
    expect(rows.find((row) => row.tag === '#booktok')).toMatchObject({
      creators: 3,
      withEmail: 3,
      flag: 'strong',
    });
    expect(rows.find((row) => row.tag === '#deepstash')?.flag).toBe('low');
    expect(rows.find((row) => row.tag === '#silent')?.flag).toBe('low');
    expect(hashtagYieldHint(rows.find((row) => row.tag === '#deepstash')!, true)).toMatch(
      /no public email/,
    );
  });

  it('treats a placeholder address as no email and flags low engagement as thin', () => {
    const rows = scoreHashtagYield(
      ['#gymtok'],
      [
        {
          handle: 'ed',
          platform: 'tiktok',
          email: 'n/a',
          engagement_rate: 0.4,
          raw: { hashtags: ['gymtok'] },
        },
        {
          handle: 'fay',
          platform: 'tiktok',
          email: 'fay@example.com',
          engagement_rate: 0.2,
          raw: { text: 'day 1 #gymtok' },
        },
        {
          handle: 'gus',
          platform: 'tiktok',
          email: 'gus@example.com',
          engagement_rate: 0.3,
          raw: { hashtags: ['gymtok'] },
        },
      ],
      true,
    );
    expect(rows[0]).toMatchObject({ withEmail: 2, stale: 3, flag: 'thin' });
  });

  it('does not call an empty creator list low yield on the campaign row', () => {
    const running = presentHashtagYield({
      campaignTags: ['#booktok', '#books', '#reading', '#reader', '#journal'],
      measured: [
        { tag: '#booktok', creators: 0, withEmail: 0, stale: 0, flag: 'low' },
        { tag: '#books', creators: 0, withEmail: 0, stale: 0, flag: 'low' },
        { tag: '#reading', creators: 0, withEmail: 0, stale: 0, flag: 'low' },
        { tag: '#reader', creators: 0, withEmail: 0, stale: 0, flag: 'low' },
        { tag: '#journal', creators: 0, withEmail: 0, stale: 0, flag: 'low' },
      ],
      running: true,
    });
    expect(running).toEqual([]);

    const finished = presentHashtagYield({
      campaignTags: ['#booktok', '#books', '#reading', '#reader', '#journal'],
      measured: [
        { tag: '#booktok', creators: 34, withEmail: 18, stale: 0, flag: 'strong' },
        { tag: '#books', creators: 4, withEmail: 3, stale: 0, flag: 'strong' },
      ],
      running: false,
    });
    expect(finished.map((pill) => `${pill.tag} ${pill.suffix}`)).toEqual([
      '#booktok Strong',
      '#books Strong',
      '#reading Not searched',
      '#reader Not searched',
      '#journal Not searched',
    ]);
    expect(finished.some((pill) => pill.suffix === 'Low yield')).toBe(false);
    expect(
      presentHashtagYield({
        campaignTags: ['#booktok', '#books'],
        measured: [],
        running: false,
      }),
    ).toEqual([]);
  });

  it('keeps Low yield when a finished search really found nothing', () => {
    const pills = presentHashtagYield({
      campaignTags: ['#deepstash'],
      measured: [{ tag: '#deepstash', creators: 2, withEmail: 0, stale: 0, flag: 'low' }],
      running: false,
    });
    expect(pills).toEqual([
      expect.objectContaining({ tag: '#deepstash', suffix: 'Low yield', tone: 'low' }),
    ]);
  });

  it('keeps a no-email creator when the email rule is off', () => {
    const rows = scoreHashtagYield(['#deepstash'], creators, false);
    expect(rows[0]?.flag).not.toBe('low');
  });
});

describe('fallback hashtags', () => {
  it('pivots a dry deepstash search to adjacent tags and caps the list', () => {
    expect(localAdjacentHashtags('deepstash', ['#deepstash'])).toEqual([
      '#productivityhacks',
      '#studytok',
    ]);
    expect(
      parseFallbackHashtags(
        '```json\n{"hashtags":["#deepstash","#studytok","#studygram","nope"]}\n```',
        ['#deepstash'],
      ),
    ).toEqual(['#studytok', '#studygram']);
  });

  it('uses a supplied model reply and falls back to the niche list when it is empty', async () => {
    const fromModel = await suggestFallbackHashtags({
      niche: 'books',
      current: ['#booktok'],
      chat: async () => '{"hashtags":["#authortok"]}',
    });
    expect(fromModel).toEqual({ tags: ['#authortok'], source: 'ai' });

    const fromNiche = await suggestFallbackHashtags({
      niche: 'deepstash',
      current: ['#deepstash'],
      chat: async () => '{"hashtags":[]}',
    });
    expect(fromNiche.source).toBe('niche');
    expect(fromNiche.tags).toEqual(['#productivityhacks', '#studytok']);
  });

  it('builds one small extra run and does not invent tags', () => {
    expect(buildFallbackActorInput('tiktok', [])).toBeNull();
    const input = buildFallbackActorInput('tiktok', ['#productivityhacks', '#studytok', '#extra']);
    expect(input).toMatchObject({
      hashtags: ['productivityhacks', 'studytok'],
      resultsPerPage: 30,
      savedResultLimit: 5,
      expandRound: true,
    });
    expect(controlsForActorInput(input ?? {}).maxItems).toBe(60);
    expect(buildFallbackActorInput('instagram', ['#studytok', '#studygram'])).toMatchObject({
      search: 'studytok',
      searchLimit: 30,
    });
  });

  it('does not call a tag thin or low until about 20 videos were sampled', () => {
    const tiny = scoreHashtagYield(
      ['#booktok'],
      [
        {
          handle: 'ada',
          platform: 'tiktok',
          email: null,
          engagement_rate: 0.1,
          raw: { hashtags: ['booktok'] },
        },
      ],
      true,
      { '#booktok': 4 },
    );
    expect(tiny[0]?.flag).toBe('insufficient');
    expect(presentHashtagYield({ measured: tiny })[0]?.suffix).toBe('Not enough data');

    const enough = scoreHashtagYield(
      ['#booktok'],
      [
        {
          handle: 'ada',
          platform: 'tiktok',
          email: null,
          engagement_rate: 0.1,
          raw: { hashtags: ['booktok'] },
        },
      ],
      true,
      { '#booktok': 20 },
    );
    expect(enough[0]?.flag).toBe('low');
  });

  it('keeps hashtag yield on a stored funnel', () => {
    const funnel = asDiscoveryFunnel({
      rawItems: 10,
      uniqueCreators: 4,
      afterFollowers: 2,
      afterDedupe: 2,
      withEmail: 1,
      saved: 1,
      followerMin: 5000,
      followerMax: 50000,
      apifyRunIds: [],
      hashtagYield: [{ tag: 'booktok', creators: 2, withEmail: 1, stale: 0, flag: 'low' }],
      fallbackTags: ['#studytok'],
      fallbackSource: 'ai',
      extraPass: 'fallback',
      finished: 3,
    });
    expect(funnel?.hashtagYield?.[0]?.tag).toBe('#booktok');
    expect(funnel?.fallbackTags).toEqual(['#studytok']);
    expect(funnel?.fallbackSource).toBe('ai');
    expect(funnel?.extraPass).toBe('fallback');
    expect(funnel?.finished).toBe(3);
  });
});
