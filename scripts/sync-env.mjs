#!/usr/bin/env node
/**
 * Sync root .env + admin/.env from SETUP-DETAILS.md (and merge existing root .env).
 * Usage: npm run sync:env
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const setupPath = resolve(root, 'SETUP-DETAILS.md');
const rootEnvPath = resolve(root, '.env');
const secretsPath = resolve(root, '.env.local.secrets');
const adminEnvPath = resolve(root, 'admin/.env');

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = val;
  }
  return out;
}

function extractSetup(md) {
  const get = (label) => {
    const re = new RegExp(
      '\\|\\s*' + label + '\\s*\\|\\s*`([^`]+)`\\s*\\|',
      'i',
    );
    const m = md.match(re);
    return m ? m[1].trim() : '';
  };
  const stripActor = (v) =>
    (v || '')
      .replace(/\s*\(override.*$/i, '')
      .replace(/\s*\(.*\)$/, '')
      .trim();
  return {
    SUPABASE_URL: get('Project URL'),
    SUPABASE_ANON_KEY: get('Anon key'),
    SUPABASE_SERVICE_ROLE_KEY: get('Service role key').replace(
      /\s*\(\*\*.*$/,
      '',
    ),
    DISCORD_WEBHOOK_URL: get('Webhook URL'),
    RESEND_API_KEY: get('API key'),
    RESEND_FROM_EMAIL:
      get('From email').replace(/^([^`]*)$/, '$1') || 'outreach@example.com',
    // Apify — "API token" row (distinct from Resend "API key")
    APIFY_TOKEN: get('API token'),
    APIFY_TIKTOK_ACTOR: stripActor(get('TikTok actor')),
    APIFY_INSTAGRAM_ACTOR: stripActor(get('Instagram actor')),
  };
}

const existing = existsSync(rootEnvPath)
  ? parseEnv(readFileSync(rootEnvPath, 'utf8'))
  : {};
const secrets = existsSync(secretsPath)
  ? parseEnv(readFileSync(secretsPath, 'utf8'))
  : {};
const fromSetup = existsSync(setupPath)
  ? extractSetup(readFileSync(setupPath, 'utf8'))
  : {};

// Clean service role if comment leaked
if (fromSetup.SUPABASE_SERVICE_ROLE_KEY) {
  fromSetup.SUPABASE_SERVICE_ROLE_KEY = fromSetup.SUPABASE_SERVICE_ROLE_KEY
    .split(/\s/)[0]
    .trim();
}
if (fromSetup.RESEND_FROM_EMAIL && fromSetup.RESEND_FROM_EMAIL.includes('`')) {
  const m = fromSetup.RESEND_FROM_EMAIL.match(/`([^`]+)`/);
  if (m) fromSetup.RESEND_FROM_EMAIL = m[1];
}
// From email row is like outreach@example.com in backticks already via get()

const merged = {
  PORT: '3001',
  APP_NAME: 'Solis',
  APP_VALUE_PROP:
    'helps creators and brands work together through Solis Labs',
  LLM_MODEL: 'openai/gpt-oss-120b',
  LLM_BASE_URL: 'https://api.groq.com/openai/v1',
  RESEND_FROM_EMAIL: 'outreach@example.com',
  APIFY_TIKTOK_ACTOR: 'clockworks/tiktok-scraper',
  APIFY_FOLLOWERS_ACTOR: 'clockworks/tiktok-followers-scraper',
  APIFY_INSTAGRAM_ACTOR: 'apify/instagram-scraper',
  ...fromSetup,
  ...secrets,
  ...existing, // existing wins so manual edits persist
};

// Prefer SETUP/service keys if existing missing
for (const k of [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DISCORD_WEBHOOK_URL',
  'RESEND_API_KEY',
  'APIFY_TOKEN',
  'APIFY_TIKTOK_ACTOR',
  'APIFY_FOLLOWERS_ACTOR',
  'APIFY_INSTAGRAM_ACTOR',
  'GROQ_API_KEY',
]) {
  if (!merged[k] && (fromSetup[k] || secrets[k])) {
    merged[k] = fromSetup[k] || secrets[k];
  }
}

// Always refresh Apify token/actors from SETUP-DETAILS when present
for (const k of ['APIFY_TOKEN', 'APIFY_TIKTOK_ACTOR', 'APIFY_INSTAGRAM_ACTOR']) {
  if (fromSetup[k]) merged[k] = fromSetup[k];
}

const GMAIL_KEYS = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];

const rootLines = [
  '# Synced by npm run sync:env — committed intentionally for private marketing-bot.',
  '# Express reads this file for SUPABASE_SERVICE_ROLE_KEY (bypasses RLS).',
];
for (const [k, v] of Object.entries(merged)) {
  if (GMAIL_KEYS.includes(k)) continue;
  if (v === undefined || v === null || v === '') continue;
  rootLines.push(`${k}=${v}`);
}
rootLines.push(
  '# Gmail reply sync — leave blank until Google OAuth is completed (docs/webhook-setup.md).',
);
for (const k of GMAIL_KEYS) {
  rootLines.push(`${k}=${merged[k] || ''}`);
}
writeFileSync(rootEnvPath, rootLines.join('\n') + '\n', 'utf8');

const adminBody = [
  '# Synced by npm run sync:env — committed intentionally for private marketing-bot.',
  `VITE_SUPABASE_URL=${merged.SUPABASE_URL || ''}`,
  `VITE_SUPABASE_ANON_KEY=${merged.SUPABASE_ANON_KEY || ''}`,
  'VITE_EXPRESS_API_URL=http://localhost:3001',
  'VITE_API_BASE_URL=http://localhost:3001',
  'VITE_APP_NAME=Solis',
  'VITE_APP_VALUE_PROP=helps creators and brands work together through Solis Labs',
  `VITE_DISCORD_WEBHOOK_URL=${merged.DISCORD_WEBHOOK_URL || ''}`,
  'VITE_ADMIN_EMAIL=owner@example.com',
  '',
].join('\n');
writeFileSync(adminEnvPath, adminBody, 'utf8');

const ok =
  Boolean(merged.SUPABASE_URL) && Boolean(merged.SUPABASE_SERVICE_ROLE_KEY);
console.log(`Wrote ${rootEnvPath}`);
console.log(`Wrote ${adminEnvPath}`);
if (!ok) {
  console.error(
    'ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY still missing — check SETUP-DETAILS.md',
  );
  process.exit(1);
}
console.log(
  'OK — restart npm run dev. API should log: Supabase client ready (service role)',
);
