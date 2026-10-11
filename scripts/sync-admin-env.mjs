#!/usr/bin/env node
/**
 * Sync admin/.env from SETUP-DETAILS.md (Project URL + Anon key + Discord webhook)
 * plus fixed Solis branding / local API URLs.
 * Usage: npm run sync:admin-env
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const adminEnvPath = resolve(root, 'admin/.env');
const setupPath = resolve(root, 'SETUP-DETAILS.md');
const rootEnvPath = resolve(root, '.env');

const DEFAULT_API = 'http://localhost:3001';
const DEFAULT_APP_NAME = 'Solis';
const DEFAULT_VALUE_PROP =
  'helps creators and brands work together through Solis Labs';

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
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
    out[key] = val;
  }
  return out;
}

function extractFromSetupDetails(md) {
  let url = '';
  let anon = '';
  let discord = '';
  const urlMatch = md.match(/\|\s*Project URL\s*\|\s*`([^`]+)`\s*\|/i);
  if (urlMatch) url = urlMatch[1].trim();
  const anonMatch = md.match(/\|\s*Anon key\s*\|\s*`([^`]+)`\s*\|/i);
  if (anonMatch) anon = anonMatch[1].trim();
  const discordMatch = md.match(/\|\s*Webhook URL\s*\|\s*`([^`]+)`\s*\|/i);
  if (discordMatch) discord = discordMatch[1].trim();
  return { url, anon, discord };
}

let url = '';
let anon = '';
let discord = '';
let source = '';

if (existsSync(setupPath)) {
  const extracted = extractFromSetupDetails(readFileSync(setupPath, 'utf8'));
  if (extracted.url && extracted.anon) {
    url = extracted.url;
    anon = extracted.anon;
    discord = extracted.discord || '';
    source = 'SETUP-DETAILS.md';
  }
}

if ((!url || !anon) && existsSync(rootEnvPath)) {
  const env = parseEnvFile(readFileSync(rootEnvPath, 'utf8'));
  url = url || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '';
  anon = anon || env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '';
  discord =
    discord ||
    env.DISCORD_WEBHOOK_URL ||
    env.VITE_DISCORD_WEBHOOK_URL ||
    '';
  if (url && anon) source = source || 'root .env';
}

if (!url || !anon) {
  console.error(
    'Could not find Supabase Project URL + Anon key in SETUP-DETAILS.md or root .env.\n' +
      'Copy them into admin/.env manually (see admin/.env.example).',
  );
  process.exit(1);
}

// Prefer Discord from root .env if SETUP-DETAILS missed it
if (!discord && existsSync(rootEnvPath)) {
  const env = parseEnvFile(readFileSync(rootEnvPath, 'utf8'));
  discord = env.DISCORD_WEBHOOK_URL || env.VITE_DISCORD_WEBHOOK_URL || '';
}

const body = [
  '# Synced by npm run sync:admin-env — do not commit secrets.',
  `# Source: ${source}`,
  '# Service keys (Apify/Groq/Resend) stay on the Express server only — never VITE_*.',
  `VITE_SUPABASE_URL=${url}`,
  `VITE_SUPABASE_ANON_KEY=${anon}`,
  `VITE_EXPRESS_API_URL=${DEFAULT_API}`,
  `VITE_API_BASE_URL=${DEFAULT_API}`,
  `VITE_APP_NAME=${DEFAULT_APP_NAME}`,
  `VITE_APP_VALUE_PROP=${DEFAULT_VALUE_PROP}`,
  `VITE_DISCORD_WEBHOOK_URL=${discord}`,
  `VITE_ADMIN_EMAIL=owner@example.com`,
  '',
].join('\n');

writeFileSync(adminEnvPath, body, 'utf8');
console.log(`Wrote ${adminEnvPath} from ${source} (Supabase + Discord + Solis + admin email).`);
console.log('Login uses Supabase Auth — set password in the UI (no VITE_ADMIN_PASSWORD).');
if (!discord) {
  console.warn(
    'Warning: Discord webhook URL not found — VITE_DISCORD_WEBHOOK_URL left empty.',
  );
}
console.log(
  'Restart the admin Vite dev server (npm run dev) so Vite picks up the new env.',
);
