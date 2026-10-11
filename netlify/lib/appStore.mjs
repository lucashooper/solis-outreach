/**
 * Apple iTunes Search / Lookup. Server-side so the admin does not depend on
 * browser CORS. Results are the live catalogue only.
 */

const ITUNES = 'https://itunes.apple.com';

export function classifyStoreQuery(raw) {
  const q = String(raw ?? '').trim();
  if (/^\d{5,}$/.test(q)) return { trackId: q };
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(q)) return { bundleId: q };
  return { term: q };
}

export function normaliseStoreApp(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = String(item.kind || '');
  if (kind && kind !== 'software' && kind !== 'mac-software') return null;
  const name = String(item.trackName || '').trim();
  if (!name) return null;
  const artwork = String(
    item.artworkUrl512 || item.artworkUrl100 || item.artworkUrl60 || '',
  );
  const iconUrl = artwork
    ? artwork.replace(/\d+x\d+bb/, '512x512bb').replace(/^http:\/\//, 'https://')
    : null;
  return {
    trackId: item.trackId != null ? String(item.trackId) : null,
    name,
    developer: String(item.artistName || '').trim() || null,
    bundleId: item.bundleId ? String(item.bundleId) : null,
    genre: String(item.primaryGenreName || '').trim() || null,
    iconUrl,
    storeUrl: item.trackViewUrl ? String(item.trackViewUrl) : null,
  };
}

async function fetchJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SolisOutreachAdmin/1.0',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    throw new Error(`App Store lookup could not be reached (${message}).`);
  }
  if (!res.ok) {
    throw new Error(`App Store lookup failed (${res.status}) for ${url}.`);
  }
  return res.json();
}

function resultsFromPayload(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const app = normaliseStoreApp(row);
    if (!app) continue;
    const key = app.trackId || app.bundleId || app.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(app);
  }
  return out;
}

async function lookup(classified, country, fetchImpl) {
  let url;
  if (classified.trackId) {
    url = `${ITUNES}/lookup?id=${encodeURIComponent(classified.trackId)}&country=${country}`;
  } else if (classified.bundleId) {
    url = `${ITUNES}/lookup?bundleId=${encodeURIComponent(classified.bundleId)}&country=${country}`;
  } else {
    url =
      `${ITUNES}/search?term=${encodeURIComponent(classified.term)}` +
      `&entity=software&limit=8&country=${country}`;
  }
  const payload = await fetchJson(url, fetchImpl);
  return resultsFromPayload(payload);
}

function mergeResults(groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const app of group) {
      const key = app.trackId || app.bundleId || app.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(app);
    }
  }
  return out;
}

export async function searchAppStore(rawQuery, options = {}) {
  const classified = classifyStoreQuery(rawQuery);
  if (!classified.term && !classified.trackId && !classified.bundleId) {
    throw new Error('Enter an app name, bundle ID, or track ID.');
  }
  if (classified.term === '') {
    throw new Error('Enter an app name, bundle ID, or track ID.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const countries = ['us', 'gb'];
  const groups = [];
  const errors = [];
  for (const country of countries) {
    try {
      groups.push(await lookup(classified, country, fetchImpl));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'App Store lookup failed.');
    }
  }
  const results = mergeResults(groups);
  if (results.length === 0 && errors.length === countries.length) {
    throw new Error(errors[0] || 'App Store lookup failed.');
  }
  return results;
}
