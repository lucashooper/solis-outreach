import type { ReplySentiment } from './types.js';

const VALID_SENTIMENTS: readonly ReplySentiment[] = [
  'Interested',
  'Not Interested',
  'Price Question',
  'Unsubscribe',
] as const;

/**
 * Builds the LLM prompt for classifying a creator's email reply.
 */
export function buildReplyClassificationPrompt(replyText: string): string {
  return [
    'Classify the following creator email reply into exactly one label.',
    'Allowed labels (case-sensitive): Interested | Not Interested | Price Question | Unsubscribe.',
    'Rules:',
    '- Interested: positive interest, wants to learn more, open to collab.',
    '- Not Interested: decline, not a fit, no thanks.',
    '- Price Question: asks about rates, pricing, payment, budget.',
    '- Unsubscribe: asks to stop emailing / remove from list.',
    'Output JSON only: { "sentiment": "<one of the labels>" }.',
    '',
    'Reply:',
    replyText,
  ].join('\n');
}

/**
 * Parses LLM output into one of the four sentiment labels.
 * Accepts fenced JSON, bare JSON, or a label appearing plainly in the text.
 */
export function parseReplyClassification(raw: string): ReplySentiment {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Reply classification response is empty or not a string');
  }

  const trimmed = raw.trim();

  // Try JSON object first
  const jsonCandidate = tryExtractJson(trimmed);
  if (jsonCandidate !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonCandidate);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const sentiment = (parsed as Record<string, unknown>).sentiment;
      if (typeof sentiment === 'string') {
        const normalised = normaliseLabel(sentiment);
        if (normalised) return normalised;
      }
    }
  }

  // Fallback: look for an exact label in the text
  for (const label of VALID_SENTIMENTS) {
    if (trimmed === label || new RegExp(`\\b${escapeRegExp(label)}\\b`, 'i').test(trimmed)) {
      const found = normaliseLabel(label);
      if (found) return found;
    }
  }

  // Case-insensitive substring match on known labels
  const lower = trimmed.toLowerCase();
  for (const label of VALID_SENTIMENTS) {
    if (lower.includes(label.toLowerCase())) {
      return label;
    }
  }

  throw new Error(
    `Could not parse reply sentiment from: ${trimmed.slice(0, 200)}`,
  );
}

function tryExtractJson(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch?.[1]?.trim() ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function normaliseLabel(value: string): ReplySentiment | null {
  const trimmed = value.trim();
  for (const label of VALID_SENTIMENTS) {
    if (label.toLowerCase() === trimmed.toLowerCase()) return label;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
