import {
  isPublicHttpsApi,
  resolveExpressApiUrl,
} from '../../../src/expressApiUrl.ts';
import type { AppSettings } from './types';

const STORAGE_KEY = 'creator-outreach-admin-settings';

const DEFAULTS: AppSettings = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  discordWebhookUrl: '',
  appName: 'Solis',
  appValueProp: 'helps creators and brands work together through Solis Labs',
  apiBaseUrl: '',
  apifyTokenNote: '',
};

function envTrim(key: keyof ImportMetaEnv): string {
  return String(import.meta.env[key] ?? '').trim();
}

/** True when Vite baked-in env has both Supabase credentials. */
export function hasViteSupabaseEnv(): boolean {
  return Boolean(envTrim('VITE_SUPABASE_URL') && envTrim('VITE_SUPABASE_ANON_KEY'));
}

/** Which settings fields are provided by Vite env (non-empty). */
export type EnvProvidedField =
  | 'supabaseUrl'
  | 'supabaseAnonKey'
  | 'apiBaseUrl'
  | 'appName'
  | 'appValueProp'
  | 'discordWebhookUrl';

export function getEnvProvidedFields(): Set<EnvProvidedField> {
  const set = new Set<EnvProvidedField>();
  if (envTrim('VITE_SUPABASE_URL')) set.add('supabaseUrl');
  if (envTrim('VITE_SUPABASE_ANON_KEY')) set.add('supabaseAnonKey');
  // An empty bake must stay editable. Only a real public URL locks the field.
  const expressEnv =
    envTrim('VITE_EXPRESS_API_URL') || envTrim('VITE_API_BASE_URL');
  if (isPublicHttpsApi(expressEnv)) set.add('apiBaseUrl');
  if (envTrim('VITE_APP_NAME')) set.add('appName');
  if (envTrim('VITE_APP_VALUE_PROP')) set.add('appValueProp');
  if (envTrim('VITE_DISCORD_WEBHOOK_URL')) set.add('discordWebhookUrl');
  return set;
}

function readStoredApiBase(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '';
  } catch {
    return '';
  }
}

function expressInputs(storedApiBase?: string | null) {
  return {
    viteExpress: envTrim('VITE_EXPRESS_API_URL'),
    viteApiBase: envTrim('VITE_API_BASE_URL'),
    storedApiBase: storedApiBase ?? readStoredApiBase(),
    production: Boolean(import.meta.env.PROD),
  };
}

function resolveApiBaseUrl(fromStored: Partial<AppSettings>): string {
  return resolveExpressApiUrl(expressInputs(fromStored.apiBaseUrl));
}

/**
 * Express API for discovery, autopilot, Gmail status, reply sync, and Approve & Pitch.
 * Vite, then Settings/localStorage, then the production Railway host.
 * Never returns "" in a production build.
 */
export function expressApiUrl(): string {
  return resolveExpressApiUrl(expressInputs());
}

/**
 * Merge Vite env defaults with localStorage (demo).
 * Prefer import.meta.env for ALL known VITE_* fields when set
 * so a stale localStorage cannot override admin/.env.
 */
export function loadSettings(): AppSettings {
  const envUrl = envTrim('VITE_SUPABASE_URL');
  const envAnon = envTrim('VITE_SUPABASE_ANON_KEY');
  const envAppName = envTrim('VITE_APP_NAME');
  const envValueProp = envTrim('VITE_APP_VALUE_PROP');
  const envDiscord = envTrim('VITE_DISCORD_WEBHOOK_URL');

  let stored: Partial<AppSettings> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<AppSettings>;
  } catch {
    /* ignore corrupt storage */
  }

  const fromStored = Object.fromEntries(
    Object.entries(stored).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
  ) as Partial<AppSettings>;

  const merged: AppSettings = {
    ...DEFAULTS,
    ...fromStored,
    // Env always wins when present
    supabaseUrl: envUrl || fromStored.supabaseUrl || DEFAULTS.supabaseUrl,
    supabaseAnonKey:
      envAnon || fromStored.supabaseAnonKey || DEFAULTS.supabaseAnonKey,
    apiBaseUrl: resolveApiBaseUrl(fromStored),
    appName: envAppName || fromStored.appName || DEFAULTS.appName,
    appValueProp:
      envValueProp || fromStored.appValueProp || DEFAULTS.appValueProp,
    discordWebhookUrl:
      envDiscord || fromStored.discordWebhookUrl || DEFAULTS.discordWebhookUrl,
  };

  return merged;
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function clearStoredSettings(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasSupabaseConfig(settings: AppSettings): boolean {
  return Boolean(settings.supabaseUrl?.trim() && settings.supabaseAnonKey?.trim());
}

/** Connected if Vite env OR loaded settings have URL + anon key. */
export function isConfigured(): boolean {
  if (hasViteSupabaseEnv()) return true;
  return hasSupabaseConfig(loadSettings());
}
