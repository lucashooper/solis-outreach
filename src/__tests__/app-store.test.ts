import { describe, expect, it } from 'vitest';
import { classifyStoreQuery, normaliseStoreApp } from '../../netlify/lib/appStore.mjs';

describe('classifyStoreQuery', () => {
  it('treats a numeric id as a track id', () => {
    expect(classifyStoreQuery('1234567890')).toEqual({ trackId: '1234567890' });
  });

  it('treats a reverse-dns string as a bundle id', () => {
    expect(classifyStoreQuery('com.solis.astra')).toEqual({
      bundleId: 'com.solis.astra',
    });
  });

  it('treats a name as a search term', () => {
    expect(classifyStoreQuery('  Astra  ')).toEqual({ term: 'Astra' });
  });

  it('keeps Cal AI as a name and a long number as a track id', () => {
    expect(classifyStoreQuery('Cal AI')).toEqual({ term: 'Cal AI' });
    expect(classifyStoreQuery('6809022889')).toEqual({ trackId: '6809022889' });
    expect(classifyStoreQuery('com.lucashooper.astra')).toEqual({
      bundleId: 'com.lucashooper.astra',
    });
  });
});

describe('normaliseStoreApp', () => {
  it('keeps icon, name and developer from a software result', () => {
    const app = normaliseStoreApp({
      kind: 'software',
      trackId: 42,
      trackName: 'Astra',
      artistName: 'Solis Labs',
      bundleId: 'com.solis.astra',
      artworkUrl100: 'http://example.com/100x100bb.jpg',
      trackViewUrl: 'https://apps.apple.com/app/id42',
    });
    expect(app).toEqual({
      trackId: '42',
      name: 'Astra',
      developer: 'Solis Labs',
      bundleId: 'com.solis.astra',
      iconUrl: 'https://example.com/512x512bb.jpg',
      storeUrl: 'https://apps.apple.com/app/id42',
      genre: null,
    });
  });

  it('drops non-app kinds', () => {
    expect(normaliseStoreApp({ kind: 'song', trackName: 'Astra' })).toBeNull();
  });
});
