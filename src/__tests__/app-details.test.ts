import { describe, expect, it } from 'vitest';
import { parseAppDetails } from '../apps/details.ts';

describe('parseAppDetails', () => {
  it('trims a rename and keeps an empty pitch', () => {
    expect(
      parseAppDetails({
        name: '  Astra – AI Book Reader  ',
        storeUrl: 'https://apps.apple.com/app/id123',
        valueProp: '  reads a book in a minute  ',
        iconUrl: '',
      }),
    ).toEqual({
      ok: true,
      patch: {
        name: 'Astra – AI Book Reader',
        store_url: 'https://apps.apple.com/app/id123',
        value_prop: 'reads a book in a minute',
        icon_url: null,
      },
    });
  });

  it('rejects a blank name and a link that is not a URL', () => {
    expect(parseAppDetails({ name: '   ', storeUrl: '', valueProp: '', iconUrl: '' })).toEqual({
      ok: false,
      error: 'Enter an app name.',
    });
    expect(
      parseAppDetails({
        name: 'Solis',
        storeUrl: 'not a link',
        valueProp: '',
        iconUrl: '',
      }).ok,
    ).toBe(false);
  });
});