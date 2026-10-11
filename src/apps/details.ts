export interface AppDetailsInput {
  name: string;
  storeUrl: string;
  valueProp: string;
  iconUrl: string;
}

export interface AppDetailsPatch {
  name: string;
  store_url: string | null;
  value_prop: string | null;
  icon_url: string | null;
}

function tidy(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Validate a switcher edit before it is written to apps. */
export function parseAppDetails(
  input: AppDetailsInput,
): { ok: true; patch: AppDetailsPatch } | { ok: false; error: string } {
  const name = tidy(input.name);
  if (!name) return { ok: false, error: 'Enter an app name.' };
  if (name.length > 80) return { ok: false, error: 'App name must be 80 characters or fewer.' };

  const storeUrl = input.storeUrl.trim();
  if (storeUrl && !isHttpUrl(storeUrl)) {
    return { ok: false, error: 'App Store link must start with https://.' };
  }

  const iconUrl = input.iconUrl.trim();
  if (iconUrl && !isHttpUrl(iconUrl)) {
    return { ok: false, error: 'Icon link must start with https://.' };
  }

  const valueProp = tidy(input.valueProp);
  if (valueProp.length > 280) {
    return { ok: false, error: 'Value proposition must be 280 characters or fewer.' };
  }

  return {
    ok: true,
    patch: {
      name,
      store_url: storeUrl || null,
      value_prop: valueProp || null,
      icon_url: iconUrl || null,
    },
  };
}
