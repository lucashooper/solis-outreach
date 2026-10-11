import type { PersonalizationResult } from './types.js';

/**
 * Builds the LLM prompt that asks for a single personalised hook sentence.
 * Output is expected as JSON only: { "hook": "..." }.
 */
export function buildPersonalizationPrompt(
  bio: string,
  appName: string,
  valueProp: string,
): string {
  return [
    `Analyze this creator's bio and content: ${bio}.`,
    `Generate 1 personalized, informal sentence explaining why our app (${appName}) fits their specific style.`,
    `Our value proposition: ${valueProp}.`,
    `Output JSON only.`,
    `Expected shape: { "hook": "..." }`,
  ].join(' ');
}

/**
 * Strips optional markdown fences and extracts a JSON object with a non-empty hook.
 */
export function parsePersonalizationResponse(raw: string): PersonalizationResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Personalisation response is empty or not a string');
  }

  const jsonText = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Personalisation response is not valid JSON: ${message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Personalisation response must be a JSON object');
  }

  const hook = (parsed as Record<string, unknown>).hook;
  if (typeof hook !== 'string' || hook.trim() === '') {
    throw new Error('Personalisation response missing non-empty string "hook"');
  }

  return { hook: hook.trim() };
}

/**
 * Replaces {{hook}} and any {{key}} placeholders from vars in the email template.
 */
export function mergeHookIntoTemplate(
  template: string,
  hook: string,
  vars?: Record<string, string>,
): string {
  const replacements: Record<string, string> = { hook, ...(vars ?? {}) };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      return replacements[key] ?? '';
    }
    return match;
  });
}

/** Pull the first JSON object from raw LLM text (handles fences and leading prose). */
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();

  // ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    const fromFence = sliceFirstObject(inner);
    if (fromFence !== null) return fromFence;
  }

  const fromBody = sliceFirstObject(trimmed);
  if (fromBody !== null) return fromBody;

  throw new Error('Could not find a JSON object in personalisation response');
}

function sliceFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
