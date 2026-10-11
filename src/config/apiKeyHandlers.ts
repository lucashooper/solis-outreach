/**
 * HTTP handlers for Settings → API keys.
 * The signed-in admin JWT is required. Webhook shared secrets are not enough.
 * Responses never include a full secret.
 */
import {
  buildPublicFields,
  ensureRuntimeSecrets,
  requireSignedInUser,
  runIntegrationTest,
  saveIntegrationField,
  type SecretsQuery,
} from './runtimeSecrets.js';

export interface ApiKeyHttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function authorised(client: SecretsQuery, authorization: string | undefined): Promise<ApiKeyHttpResult | null> {
  const auth = await requireSignedInUser(client, authorization);
  if (!auth.ok) return { status: 401, body: { ok: false, error: auth.error } };
  return null;
}

export async function handleApiKeysGet(
  client: SecretsQuery,
  authorization: string | undefined,
  gmailCallbackUrl: string,
): Promise<ApiKeyHttpResult> {
  const denied = await authorised(client, authorization);
  if (denied) return denied;
  await ensureRuntimeSecrets({ client });
  return {
    status: 200,
    body: {
      ok: true,
      gmailCallbackUrl,
      fields: buildPublicFields(),
    },
  };
}

export async function handleApiKeysPut(
  client: SecretsQuery,
  authorization: string | undefined,
  body: unknown,
): Promise<ApiKeyHttpResult> {
  const denied = await authorised(client, authorization);
  if (denied) return denied;
  const record = (body ?? {}) as { id?: unknown; value?: unknown };
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return { status: 400, body: { ok: false, error: 'Choose a setting to save.' } };
  if (record.value != null && typeof record.value !== 'string') {
    return { status: 400, body: { ok: false, error: 'That value is not text.' } };
  }
  try {
    await saveIntegrationField(client, id, typeof record.value === 'string' ? record.value : null);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not save that setting.';
    const status = message === 'Unknown setting.' ? 400 : 400;
    return { status, body: { ok: false, error: message } };
  }
  return {
    status: 200,
    body: { ok: true, fields: buildPublicFields() },
  };
}

export async function handleApiKeysTest(
  client: SecretsQuery,
  authorization: string | undefined,
  body: unknown,
  fetchImpl?: typeof fetch,
): Promise<ApiKeyHttpResult> {
  const denied = await authorised(client, authorization);
  if (denied) return denied;
  await ensureRuntimeSecrets({ client });
  const record = (body ?? {}) as { id?: unknown; value?: unknown };
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return { status: 400, body: { ok: false, error: 'Choose a setting to test.' } };
  if (record.value != null && typeof record.value !== 'string') {
    return { status: 400, body: { ok: false, error: 'That value is not text.' } };
  }
  const result = await runIntegrationTest({
    id,
    draft: typeof record.value === 'string' ? record.value : null,
    fetchImpl,
  });
  return {
    status: result.ok ? 200 : 502,
    body: { ok: result.ok, message: result.message },
  };
}
