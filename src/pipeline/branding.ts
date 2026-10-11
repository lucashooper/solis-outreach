import type { SupabaseClient } from '@supabase/supabase-js';

const GENERIC_VALUE_PROPS = new Set([
  'helps creators and brands work together through Solis Labs',
  'helps creators monetise short-form content without ads',
]);

export function isGenericValueProp(value: string | null | undefined): boolean {
  return GENERIC_VALUE_PROPS.has((value ?? '').trim());
}

/**
 * Emails use the linked app. A campaign snapshot of "Solis" is only a fallback
 * when the app row has no name. A generic Solis value prop loses to one stored
 * on the app, and loses to a campaign prop the user actually wrote.
 */
export function resolveOutreachBranding(input: {
  appName?: string | null;
  appValueProp?: string | null;
  campaignAppName?: string | null;
  campaignValueProp?: string | null;
  fallbackAppName?: string | null;
  fallbackValueProp?: string | null;
}): { appName: string; valueProp: string } {
  const appName =
    input.appName?.trim() ||
    input.campaignAppName?.trim() ||
    input.fallbackAppName?.trim() ||
    'Solis';
  const appProp = input.appValueProp?.trim() || '';
  const campaignProp = input.campaignValueProp?.trim() || '';
  const fallback =
    input.fallbackValueProp?.trim() ||
    'helps creators and brands work together through Solis Labs';
  if (appProp) return { appName, valueProp: appProp };
  if (campaignProp && !isGenericValueProp(campaignProp)) return { appName, valueProp: campaignProp };
  if (campaignProp) return { appName, valueProp: campaignProp };
  return { appName, valueProp: fallback };
}

/** App name, and value_prop when that column exists. Missing column is not an error. */
export async function readAppBranding(
  sb: SupabaseClient,
  appId: string | null | undefined,
): Promise<{ name: string | null; valueProp: string | null }> {
  if (!appId) return { name: null, valueProp: null };
  const full = await sb.from('apps').select('name, value_prop').eq('id', appId).maybeSingle();
  if (full.error && /value_prop/i.test(full.error.message)) {
    const nameOnly = await sb.from('apps').select('name').eq('id', appId).maybeSingle();
    const name = typeof nameOnly.data?.name === 'string' ? nameOnly.data.name : null;
    return { name, valueProp: null };
  }
  const name = typeof full.data?.name === 'string' ? full.data.name : null;
  const valueProp =
    typeof full.data?.value_prop === 'string' && full.data.value_prop.trim()
      ? full.data.value_prop.trim()
      : null;
  return { name, valueProp };
}
