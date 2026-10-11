import { describe, expect, it } from 'vitest';
import {
  buildReplyClassificationPrompt,
  parseReplyClassification,
} from '../reply-classifier.js';

describe('buildReplyClassificationPrompt', () => {
  it('lists all four labels and includes the reply text', () => {
    const prompt = buildReplyClassificationPrompt('Sounds interesting!');
    expect(prompt).toContain('Interested');
    expect(prompt).toContain('Not Interested');
    expect(prompt).toContain('Price Question');
    expect(prompt).toContain('Unsubscribe');
    expect(prompt).toContain('Sounds interesting!');
    expect(prompt).toMatch(/JSON only/i);
  });
});

describe('parseReplyClassification', () => {
  it('parses Interested from clean JSON', () => {
    expect(parseReplyClassification('{"sentiment":"Interested"}')).toBe(
      'Interested',
    );
  });

  it('parses Not Interested from fenced JSON', () => {
    const raw = '```json\n{"sentiment":"Not Interested"}\n```';
    expect(parseReplyClassification(raw)).toBe('Not Interested');
  });

  it('parses Price Question with leading prose', () => {
    const raw =
      'Classification result:\n{"sentiment":"Price Question"}\nDone.';
    expect(parseReplyClassification(raw)).toBe('Price Question');
  });

  it('parses Unsubscribe from plain label text', () => {
    expect(parseReplyClassification('Unsubscribe')).toBe('Unsubscribe');
  });

  it('normalises case for known labels inside JSON', () => {
    expect(parseReplyClassification('{"sentiment":"interested"}')).toBe(
      'Interested',
    );
  });

  it('throws on unrecognised output', () => {
    expect(() => parseReplyClassification('Maybe later?')).toThrow(
      /Could not parse reply sentiment/i,
    );
  });

  it('throws on empty input', () => {
    expect(() => parseReplyClassification('')).toThrow(/empty/i);
  });
});
