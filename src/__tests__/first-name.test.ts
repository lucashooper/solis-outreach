import { describe, expect, it } from 'vitest';
import { firstNameOf, renderTemplate } from '../templates/tokens.js';
import { firstNameOf as firstNameMjs, renderTemplate as renderMjs } from '../../netlify/lib/templateTokens.mjs';

describe('firstNameOf', () => {
  it('uses a real first name from a display name and ignores a handle mash', () => {
    expect(firstNameOf('Sam Wall', 'samwallreadsbooks')).toBe('Sam');
    expect(firstNameOf('Sam | BookTok', 'samwallreadsbooks')).toBe('Sam');
    expect(firstNameOf('samwallreadsbooks', 'samwallreadsbooks')).toBe('there');
    expect(firstNameOf('Samwallreads', 'samwallreadsbooks')).toBe('there');
    expect(firstNameOf('', 'kenzireads')).toBe('there');
    expect(firstNameMjs('Sam Wall', 'samwallreadsbooks')).toBe('Sam');
    expect(firstNameMjs('samwallreadsbooks', 'samwallreadsbooks')).toBe('there');
  });

  it('reads a confident name from the bio and otherwise stays template-safe', () => {
    expect(firstNameOf('samwallreadsbooks', 'samwallreadsbooks', "book reviews · I'm Sam")).toBe('Sam');
    expect(firstNameOf('', 'collectingandreading', 'your friend on booktok')).toBe('there');
    const body = 'Hey {{first_name}},';
    expect(renderTemplate(body, { handle: 'samwallreadsbooks', displayName: 'samwallreadsbooks' })).toBe(
      'Hey there,',
    );
    expect(
      renderMjs(body, { handle: 'samwallreadsbooks', displayName: 'Sam Wall' }),
    ).toBe(renderTemplate(body, { handle: 'samwallreadsbooks', displayName: 'Sam Wall' }));
    expect(renderTemplate(body, { handle: 'samwallreadsbooks', displayName: 'Sam Wall' })).toBe('Hey Sam,');
  });
});
