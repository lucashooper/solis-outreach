import { describe, expect, it } from 'vitest';
import {
  PRODUCTION_EXPRESS_URL,
  LOCAL_EXPRESS_URL,
  resolveExpressApiUrl,
} from '../expressApiUrl.ts';

describe('resolveExpressApiUrl', () => {
  it('does not collapse to an empty string when Vite baked an empty Express URL', () => {
    expect(
      resolveExpressApiUrl({
        viteExpress: '',
        viteApiBase: '',
        storedApiBase: '',
        production: true,
      }),
    ).toBe(PRODUCTION_EXPRESS_URL);
  });

  it('prefers a public Vite URL over Settings and the production fallback', () => {
    expect(
      resolveExpressApiUrl({
        viteExpress: 'https://api.example.com/',
        viteApiBase: 'https://other.example',
        storedApiBase: 'https://stored.example',
        production: true,
      }),
    ).toBe('https://api.example.com');
  });

  it('uses Settings apiBaseUrl when the Vite bake is empty or localhost', () => {
    expect(
      resolveExpressApiUrl({
        viteExpress: '',
        viteApiBase: 'http://localhost:3001',
        storedApiBase: 'https://api.example/',
        production: true,
      }),
    ).toBe('https://api.example');
  });

  it('keeps local dev on localhost when nothing else is set', () => {
    expect(
      resolveExpressApiUrl({
        viteExpress: '',
        viteApiBase: '',
        storedApiBase: '',
        production: false,
      }),
    ).toBe(LOCAL_EXPRESS_URL);
  });

  it('lets a dev env URL override the localhost default', () => {
    expect(
      resolveExpressApiUrl({
        viteExpress: 'http://127.0.0.1:3001/',
        storedApiBase: 'http://localhost:3999',
        production: false,
      }),
    ).toBe('http://127.0.0.1:3001');
  });
});
