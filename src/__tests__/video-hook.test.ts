import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderTemplate } from '../templates/tokens.js';
import { renderTemplate as renderMjs } from '../../netlify/lib/templateTokens.mjs';
import {
  buildVideoHookPrompt,
  captionTopic,
  fallbackVideoHook,
  fillVideoHook,
  formatHookDate,
  hookDateLabel,
  hookFromTopic,
  normaliseVideoHook,
  parseVideoHookLine,
  readStoredVideoHook,
  reusableVideoHook,
  VIDEO_HOOK_SYSTEM,
  VIDEO_HOOK_VERSION,
  videoHookBasis,
  videoHookLooksBroken,
  type StoredVideoHook,
  type VideoHookProvenance,
} from '../templates/videoHook.js';

const fourthWing = {
  handle: 'kenzireads',
  bio: 'BookTok. Romance and fantasy.',
  niches: ['booktok'],
  videos: [{ caption: 'Fourth Wing reaction — the ending wrecked me #fourthwing #booktok' }],
};

function provenance(overrides: Partial<VideoHookProvenance> = {}): VideoHookProvenance {
  return {
    video_url: 'https://www.tiktok.com/@kenzireads/video/1',
    caption_snippet: 'Fourth Wing reaction',
    fields_used: ['caption'],
    bio: null,
    niches: [],
    observed_at: '2026-10-08T12:00:00.000Z',
    observed_as: 'scraped',
    model: 'openai/gpt-oss-20b',
    generated_at: '2026-10-08T12:05:00.000Z',
    grounded: true,
    ...overrides,
  };
}

describe('video hook fallback', () => {
  it('uses a neutral reading line when there is no video detail', () => {
    const reading = fallbackVideoHook({ bio: 'romance reader', niches: ['booktok'] });
    expect(reading.text).toBe("I've been enjoying your reading content.");
    expect(reading.source).toBe('bio');
    expect(reading.provenance.grounded).toBe(false);
    expect(reading.provenance.model).toBeNull();
    expect(reading.provenance.video_url).toBeNull();
    expect(reading.provenance.fields_used).toEqual(['bio', 'niches']);
    expect(captionTopic('#fyp #booktok')).toBeNull();
    expect(captionTopic('#booktok #booktokgermany #frankfurterbuchmesse')).toBeNull();
    expect(captionTopic('#alihazelwood #bridealihazelwood')).toBeNull();
  });

  it('names another niche from stored tags, and stays generic when nothing is known', () => {
    const skincare = fallbackVideoHook({ niches: ['skincare'] });
    expect(skincare.text).toBe("I've been enjoying your skincare content.");
    expect(skincare.source).toBe('bio');
    expect(skincare.provenance.grounded).toBe(false);
    const generic = fallbackVideoHook({});
    expect(generic.text).toBe("I've been enjoying your content.");
    expect(generic.source).toBe('generic');
    expect(generic.provenance.fields_used).toEqual([]);
    expect(generic.provenance.grounded).toBe(false);
    expect(generic.provenance.model).toBeNull();
  });

  it('builds a specific line from a stored caption and does not invent a title', () => {
    const line = fallbackVideoHook(fourthWing);
    expect(line.source).toBe('video');
    expect(line.text).toBe('Loved your "Fourth Wing reaction" video.');
    expect(line.text.split(/\s+/).length).toBeLessThanOrEqual(20);
    expect(line.text).not.toMatch(/amazing|obsessed|incredible/i);
    expect(line.provenance.grounded).toBe(true);
    expect(line.provenance.model).toBeNull();
    expect(line.provenance.fields_used).toEqual(['caption']);
    expect(line.provenance.caption_snippet).toBe('Fourth Wing reaction');
  });

  it('does not quote hashtag soup, cut-off captions, German, or the creator’s first person', () => {
    expect(hookFromTopic('Alihazelwood bridealihazelwood')).toBeNull();
    expect(hookFromTopic('Only 6 stars here folks! Bangers across the')).toBeNull();
    expect(hookFromTopic('Only 6 stars here folks! Bangers across the board')).toBeNull();
    expect(captionTopic('Ich liebe dieses Buch so sehr')).toBeNull();
    expect(captionTopic("I've highlighted five favorites from this month")).toBeNull();

    const cutOff = fallbackVideoHook({
      videos: [
        {
          caption:
            'Only 6 stars here folks Bangers across the board this week friends and it just keeps going',
        },
      ],
    });
    expect(cutOff.source).not.toBe('video');
    expect(cutOff.text).not.toContain('Bangers');
    expect(cutOff.text).not.toContain('"');
    expect(cutOff.provenance.grounded).toBe(false);

    const german = fallbackVideoHook({
      niches: ['booktok'],
      videos: [{ caption: 'Das beste Buch des Jahres und warum ich es liebe #booktok' }],
    });
    expect(german.text).toBe("I've been enjoying your reading content.");
    expect(german.text).not.toMatch(/Buch|liebe|beste/i);
    expect(german.provenance.grounded).toBe(false);
    expect(german.provenance.model).toBeNull();

    const tags = fallbackVideoHook({
      bio: 'romance reader',
      niches: ['booktok'],
      videos: [{ caption: '#booktok #booktokgermany #frankfurterbuchmesse' }],
      foundAt: '2026-10-08T00:30:00.000Z',
      now: '2026-10-08T16:00:00.000Z',
    });
    expect(tags.text.toLowerCase()).not.toContain('insight');
    expect(tags.provenance.grounded).toBe(false);
    expect(tags.provenance.model).toBeNull();
    expect(tags.provenance.observed_as).toBe('found');
    expect(tags.provenance.observed_at).toBe('2026-10-08T00:30:00.000Z');
    expect(hookDateLabel(tags.provenance)).toBe('Found on 8 Oct 2026');
    expect(formatHookDate('2026-10-08T15:04:00.000Z')).toBe('8 Oct 2026');
    expect(
      hookDateLabel({ observed_at: '2026-10-08T15:04:00.000Z', observed_as: 'scraped' }),
    ).toBe('Scraped 8 Oct 2026');
  });
});

describe('video hook cache', () => {
  it('reuses a cached line and skips the model', async () => {
    const basis = videoHookBasis(fourthWing);
    const stored: StoredVideoHook = {
      text: 'Loved your "Fourth Wing reaction" video.',
      source: 'video',
      basis,
      edited: false,
      version: VIDEO_HOOK_VERSION,
      provenance: provenance(),
    };
    const chat = vi.fn(async () => '{"line":"should not run"}');
    const draft = await fillVideoHook({
      ...fourthWing,
      stored: {
        video_hook: stored.text,
        video_hook_source: stored.source,
        video_hook_basis: stored.basis,
        video_hook_version: stored.version,
        video_hook_provenance: stored.provenance,
      },
    }, chat);
    expect(chat).not.toHaveBeenCalled();
    expect(draft.cached).toBe(true);
    expect(draft.text).toBe(stored.text);
    expect(draft.provenance?.video_url).toBe(stored.provenance?.video_url);
    expect(reusableVideoHook({ ...stored, version: 2 }, basis, false)).toBeNull();
    expect(reusableVideoHook({ ...stored, provenance: null }, basis, false)).toBeNull();
    expect(VIDEO_HOOK_VERSION).toBe(3);
  });

  it('keeps an edited line when the captions change, until regenerate', () => {
    const edited: StoredVideoHook = {
      text: 'your annotated copy video was great.',
      source: 'video',
      basis: 'old-basis',
      edited: true,
      version: 1,
      provenance: null,
    };
    expect(reusableVideoHook(edited, 'new-basis', false)?.text).toBe(edited.text);
    expect(reusableVideoHook(edited, 'new-basis', true)).toBeNull();
  });

  it('calls the model once on a miss, and again only when forced', async () => {
    const chat = vi.fn(async () => '{"line":"your Fourth Wing reaction video was great."}');
    const first = await fillVideoHook({ ...fourthWing, model: 'openai/gpt-oss-20b' }, chat);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(first.source).toBe('video');
    expect(first.cached).toBe(false);
    expect(first.text.toLowerCase()).toContain('fourth wing');
    expect(first.provenance?.grounded).toBe(true);
    expect(first.provenance?.model).toBe('openai/gpt-oss-20b');

    const second = await fillVideoHook(
      {
        ...fourthWing,
        stored: {
          video_hook: first.text,
          video_hook_source: first.source,
          video_hook_basis: first.basis,
          video_hook_edited: false,
          video_hook_version: VIDEO_HOOK_VERSION,
          video_hook_provenance: first.provenance,
        },
      },
      chat,
    );
    expect(chat).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);

    await fillVideoHook(
      {
        ...fourthWing,
        force: true,
        stored: {
          video_hook: first.text,
          video_hook_source: first.source,
          video_hook_basis: first.basis,
        },
      },
      chat,
    );
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('does not call the model when there is no usable video, and falls back if the model invents a title', async () => {
    const chat = vi.fn(async () => '{"line":"your Dune review was great."}');
    const quiet = await fillVideoHook({ bio: 'just vibes', niches: [] }, chat);
    expect(chat).not.toHaveBeenCalled();
    expect(quiet.source).toBe('generic');

    const invented = await fillVideoHook(
      { ...fourthWing, model: 'openai/gpt-oss-20b' },
      chat,
    );
    expect(invented.text.toLowerCase()).toContain('fourth wing');
    expect(invented.text.toLowerCase()).not.toContain('dune');
    expect(invented.provenance?.model).toBeNull();
    expect(invented.provenance?.grounded).toBe(true);
  });

  it('rejects invented praise, copied first person, and a paraphrase that is not in the caption', async () => {
    const praise = vi.fn(async () => '{"line":"Intrigued by your insights."}');
    const tagsOnly = await fillVideoHook(
      {
        bio: 'Books',
        niches: ['booktok'],
        videos: [{ caption: '#booktok #booktokgermany #frankfurterbuchmesse' }],
        model: 'openai/gpt-oss-20b',
      },
      praise,
    );
    expect(praise).not.toHaveBeenCalled();
    expect(tagsOnly.text.toLowerCase()).not.toMatch(/insight|intrigued|discussion|selection/);
    expect(tagsOnly.provenance?.grounded).toBe(false);

    const copied = vi.fn(async () => '{"line":"I\'ve highlighted five favorites."}');
    const firstPerson = await fillVideoHook(
      {
        niches: ['booktok'],
        videos: [{ caption: "I've highlighted five favorites #booktok" }],
      },
      copied,
    );
    expect(copied).not.toHaveBeenCalled();
    expect(firstPerson.text.toLowerCase()).not.toContain('highlighted');
    expect(firstPerson.provenance?.grounded).toBe(false);

    const garbled = vi.fn(
      async () =>
        '{"line":"Loved your \\"the two-for-one part two and the horror reaction\\" video."}',
    );
    const draft = await fillVideoHook(
      {
        model: 'openai/gpt-oss-20b',
        videos: [
          {
            caption: 'Fourth Wing reaction — the ending wrecked me',
            video_url: 'https://www.tiktok.com/@reader/video/999',
            scraped_at: '2026-10-08T11:00:00.000Z',
          },
        ],
      },
      garbled,
    );
    expect(garbled).toHaveBeenCalled();
    expect(draft.text).toBe('Loved your "Fourth Wing reaction" video.');
    expect(draft.text.toLowerCase()).not.toContain('two-for-one');
    expect(draft.text.toLowerCase()).not.toContain('horror reaction');
    expect(draft.provenance?.model).toBeNull();
    expect(draft.provenance?.grounded).toBe(true);
    expect(draft.provenance?.video_url).toBe('https://www.tiktok.com/@reader/video/999');
    expect(draft.provenance?.observed_as).toBe('scraped');
  });

  it('records the one caption the phrase came from', async () => {
    const chat = vi.fn(async () => '{"line":"Loved your \\"Fourth Wing reaction\\" video."}');
    const draft = await fillVideoHook(
      {
        model: 'openai/gpt-oss-20b',
        now: '2026-10-08T16:00:00.000Z',
        foundAt: '2026-09-01T00:00:00.000Z',
        videos: [
          {
            caption: 'Shelf tour of my favourites',
            video_url: 'https://www.tiktok.com/@a/video/1',
            scraped_at: '2026-09-02T00:00:00.000Z',
          },
          {
            caption: 'Fourth Wing reaction — the ending wrecked me',
            video_url: 'https://www.tiktok.com/@a/video/2',
            scraped_at: '2026-10-08T11:00:00.000Z',
          },
        ],
      },
      chat,
    );
    expect(draft.provenance).toMatchObject({
      video_url: 'https://www.tiktok.com/@a/video/2',
      caption_snippet: 'Fourth Wing reaction',
      grounded: true,
      model: 'openai/gpt-oss-20b',
      observed_as: 'scraped',
      observed_at: '2026-10-08T11:00:00.000Z',
      generated_at: '2026-10-08T16:00:00.000Z',
      fields_used: ['caption'],
    });

    const found = fallbackVideoHook({
      foundAt: '2026-10-08T00:30:00.000Z',
      now: '2026-10-08T16:00:00.000Z',
      videos: [
        {
          caption: 'Fourth Wing reaction — wow',
          video_url: 'https://www.tiktok.com/@a/video/2',
        },
      ],
    });
    expect(found.provenance.observed_as).toBe('found');
    expect(found.provenance.observed_at).toBe('2026-10-08T00:30:00.000Z');
    expect(found.provenance.model).toBeNull();
    expect(found.provenance.grounded).toBe(true);
    expect(found.provenance.video_url).toBe('https://www.tiktok.com/@a/video/2');
    expect(hookDateLabel(found.provenance)).toBe('Found on 8 Oct 2026');
  });
});

describe('video hook parsing', () => {
  it('drops emoji, hype, and lines that run past 20 words', () => {
    expect(parseVideoHookLine('{"line":"your Fourth Wing reaction video was great 🔥"}')).toBe(
      'Loved your "Fourth Wing reaction" video.',
    );
    expect(
      parseVideoHookLine(
        '{"line":"Name, your \'What are you reading right now?\' video was great."}',
      ),
    ).toBe('Loved your "What are you reading right now?" video.');
    expect(
      normaliseVideoHook('Name, your take a scroll break and read with me video was great.'),
    ).toBe('Loved your "Take a scroll break and read with me" video.');
    expect(
      normaliseVideoHook('your Not every book you read has to be video stood out.'),
    ).toBeNull();
    expect(videoHookLooksBroken('Name, your video was great.')).toBe(true);
    expect(normaliseVideoHook('your amazing Fourth Wing video was perfect.')).toBeNull();
    expect(
      normaliseVideoHook(
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone',
      ),
    ).toBeNull();
    expect(parseVideoHookLine('not json')).toBeNull();
    for (const line of [
      'Intrigued by your insights.',
      'Appreciated the candid discussion.',
      'Intrigued by your selection.',
      'Intrigued by your recommendation style.',
      'Intrigued by your reading pace.',
      "I've highlighted five favorites.",
    ]) {
      expect(normaliseVideoHook(line)).toBeNull();
    }
    const prompt = buildVideoHookPrompt({
      handle: 'books',
      bio: 'Romance reader',
      niches: ['booktok'],
      videos: [
        { caption: '#booktok #booktokgermany #frankfurterbuchmesse' },
        { caption: 'Ich liebe dieses Buch so sehr' },
        { caption: 'Fourth Wing reaction — the ending wrecked me #fourthwing' },
      ],
    });
    expect(prompt).toContain('Fourth Wing reaction');
    expect(prompt).not.toContain('wrecked');
    expect(prompt).not.toContain('booktokgermany');
    expect(prompt).not.toContain('frankfurterbuchmesse');
    expect(prompt).not.toContain('liebe');
    expect(prompt).not.toContain('#');
    expect(VIDEO_HOOK_SYSTEM.toLowerCase()).toContain('first person');
    expect(VIDEO_HOOK_SYSTEM.toLowerCase()).toContain('insights');
    expect(VIDEO_HOOK_SYSTEM.toLowerCase()).toContain('do not invent');
    const roundTrip = readStoredVideoHook({
      video_hook: 'Loved your "Fourth Wing reaction" video.',
      video_hook_source: 'video',
      video_hook_provenance: provenance(),
    });
    expect(roundTrip?.provenance?.video_url).toContain('/video/1');
    expect(roundTrip?.provenance?.grounded).toBe(true);
  });
});

describe('template substitution', () => {
  it('fills first name, video hook, and store link, and matches the Netlify copy', () => {
    const input = {
      handle: 'kenzireads',
      appName: 'ExampleApp',
      videoHook: 'your Fourth Wing reaction video was great.',
      storeUrl: 'https://apps.apple.com/app/exampleapp',
    };
    const body = 'Hey {{first_name}}, {{video_hook}}\n\nAlex\n{{store_url}}';
    const rendered = renderTemplate(body, input);
    expect(rendered).toBe(
      "Hey there, your Fourth Wing reaction video was great.\n\nAlex\nhttps://apps.apple.com/app/exampleapp",
    );
    expect(renderMjs(body, input)).toBe(rendered);
    expect(renderTemplate('Alex\n{{store_url}}', { handle: 'kenzireads' })).toBe('Alex');
    expect(renderTemplate('{{video_hook}}', {})).toBe("I've been enjoying your content.");
  });
});

describe('ExampleApp preset seed', () => {
  it('inserts the v2 template only when that name and id are absent', () => {
    const sql = readFileSync(
      resolve('supabase/migrations/20261008120000_exampleapp_flat_fee_v2.sql'),
      'utf8',
    );
    expect(sql).toContain('ExampleApp flat-fee v2');
    expect(sql).toContain('Paid ExampleApp post, $75 flat');
    expect(sql).toContain('{{first_name}}');
    expect(sql).toContain('{{video_hook}}');
    expect(sql).toContain('{{store_url}}');
    expect(sql).toContain('a0000000-0000-4000-8000-0000000000e3');
    expect(sql).toMatch(/NOT EXISTS/i);
    expect(sql).not.toMatch(/DO UPDATE/i);
  });
});
