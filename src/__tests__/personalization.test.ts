import { describe, expect, it } from 'vitest';
import {
  buildPersonalizationPrompt,
  mergeHookIntoTemplate,
  parsePersonalizationResponse,
} from '../personalization.js';

describe('buildPersonalizationPrompt', () => {
  it('includes bio, app name, value prop, and JSON-only instruction', () => {
    const prompt = buildPersonalizationPrompt(
      'UK fashion TikToker',
      'StyleKit',
      'turns looks into shoppable links',
    );
    expect(prompt).toContain('UK fashion TikToker');
    expect(prompt).toContain('StyleKit');
    expect(prompt).toContain('turns looks into shoppable links');
    expect(prompt).toMatch(/Output JSON only/i);
    expect(prompt).toContain('"hook"');
  });
});

describe('parsePersonalizationResponse', () => {
  it('parses clean JSON', () => {
    const result = parsePersonalizationResponse(
      '{"hook":"Your street-style edits would shine with StyleKit."}',
    );
    expect(result).toEqual({
      hook: 'Your street-style edits would shine with StyleKit.',
    });
  });

  it('parses fenced ```json blocks', () => {
    const raw = [
      '```json',
      '{',
      '  "hook": "Love how you mix thrift finds — StyleKit fits that vibe."',
      '}',
      '```',
    ].join('\n');
    const result = parsePersonalizationResponse(raw);
    expect(result.hook).toBe(
      'Love how you mix thrift finds — StyleKit fits that vibe.',
    );
  });

  it('parses leading prose + JSON', () => {
    const raw =
      'Sure! Here is the personalisation:\n\n{"hook":"Your GRWM energy pairs perfectly with StyleKit."}\n\nHope that helps!';
    const result = parsePersonalizationResponse(raw);
    expect(result.hook).toBe(
      'Your GRWM energy pairs perfectly with StyleKit.',
    );
  });

  it('throws when hook is missing', () => {
    expect(() => parsePersonalizationResponse('{"foo":"bar"}')).toThrow(
      /missing non-empty string "hook"/i,
    );
  });

  it('throws when hook is empty', () => {
    expect(() => parsePersonalizationResponse('{"hook":"   "}')).toThrow(
      /missing non-empty string "hook"/i,
    );
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePersonalizationResponse('not json at all')).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => parsePersonalizationResponse('')).toThrow(/empty/i);
  });
});

describe('mergeHookIntoTemplate', () => {
  it('replaces {{hook}} and extra vars', () => {
    const template =
      'Hi {{handle}}, {{hook}} Try {{appName}} — {{valueProp}}.';
    const out = mergeHookIntoTemplate(
      template,
      'your aesthetic is perfect for us.',
      { handle: '@maya', appName: 'StyleKit', valueProp: 'shoppable links' },
    );
    expect(out).toBe(
      'Hi @maya, your aesthetic is perfect for us. Try StyleKit — shoppable links.',
    );
  });

  it('leaves unknown placeholders intact', () => {
    const out = mergeHookIntoTemplate('{{hook}} {{unknown}}', 'hello');
    expect(out).toBe('hello {{unknown}}');
  });
});
