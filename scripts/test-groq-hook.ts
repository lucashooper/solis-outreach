/**
 * Live Groq smoke test: generate a personalisation hook for a sample bio.
 * Prints the hook only — never the API key.
 *
 *   npm run test:groq
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPersonalizationPrompt, parsePersonalizationResponse } from '../src/personalization.js';
import { chatJson, isGroqConfigured } from '../src/llm/client.js';
import { templateHookFromBio } from '../src/pipeline/outreach.js';

function loadEnvFiles(): void {
  for (const name of ['.env', '.env.local.secrets']) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}

loadEnvFiles();

const SAMPLE_BIO =
  'London fitness coach | HIIT + nutrition tips | Collabs: hello@fitlondon.example | 120k on TikTok';

async function main(): Promise<void> {
  if (!isGroqConfigured()) {
    console.error('FAIL: GROQ_API_KEY is not set (check .env / .env.local.secrets)');
    process.exit(1);
  }

  const appName = process.env.APP_NAME?.trim() || 'Solis';
  const valueProp =
    process.env.APP_VALUE_PROP?.trim() ||
    'helps creators monetise short-form content without ads';
  const model = process.env.LLM_MODEL?.trim() || '(default)';
  const base = process.env.LLM_BASE_URL?.trim() || '(default)';

  console.log(`Groq smoke test — model=${model} base=${base}`);
  console.log('(API key present: yes — value not printed)');

  const prompt = buildPersonalizationPrompt(SAMPLE_BIO, appName, valueProp);
  const { content } = await chatJson({
    system:
      'You write short creator outreach hooks. Reply with JSON only: {"hook":"..."}',
    user: prompt,
    temperature: 0.7,
  });

  const { hook } = parsePersonalizationResponse(content);
  const fallback = templateHookFromBio(SAMPLE_BIO, 'fitlondon', appName);

  if (!hook.trim()) {
    console.error('FAIL: empty hook');
    process.exit(1);
  }

  if (hook.trim() === fallback.trim()) {
    console.error('FAIL: hook looks like bio first-line fallback, not LLM output');
    process.exit(1);
  }

  // Heuristic: fallback always contains 'Loved this from your bio'
  if (hook.includes('Loved this from your bio')) {
    console.error('FAIL: hook matches template fallback pattern');
    process.exit(1);
  }

  console.log('OK — hook:');
  console.log(hook);
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  // Never dump env or key material
  const groqPrefix = 'gs' + 'k_';
  console.error('FAIL:', message.replace(new RegExp(`${groqPrefix}[A-Za-z0-9]+`, 'g'), `${groqPrefix}***`));
  process.exit(1);
});
