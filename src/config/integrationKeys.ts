/**
 * API keys and paired settings an admin can save.
 * Supabase URL, anon key, and service role stay in the environment:
 * the server cannot read this table until those are set.
 * British English comments.
 */

export type IntegrationGroup = 'apify' | 'groq' | 'resend' | 'gmail' | 'other';

export type IntegrationTest =
  | 'apify'
  | 'groq'
  | 'resend'
  | 'gmail'
  | 'discord'
  | 'slack'
  | 'instantly'
  | 'smartlead';

export interface IntegrationField {
  /** Row key in integration_secrets. */
  id: string;
  /** process.env name. Settings win when the row is non-empty. */
  env: string;
  label: string;
  hint: string;
  group: IntegrationGroup;
  /** Mask in API responses. Non-secrets (models, addresses) are shown. */
  secret: boolean;
  test?: IntegrationTest;
}

export const INTEGRATION_FIELDS: readonly IntegrationField[] = [
  {
    id: 'apify_token',
    env: 'APIFY_TOKEN',
    label: 'Apify token',
    hint: 'Primary Apify account.',
    group: 'apify',
    secret: true,
    test: 'apify',
  },
  {
    id: 'apify_token_fallback',
    env: 'APIFY_TOKEN_FALLBACK',
    label: 'Apify fallback token',
    hint: 'Used when the primary account is out of credit.',
    group: 'apify',
    secret: true,
    test: 'apify',
  },
  {
    id: 'apify_tokens',
    env: 'APIFY_TOKENS',
    label: 'Extra Apify tokens',
    hint: 'Comma-separated further accounts. Duplicates are ignored.',
    group: 'apify',
    secret: true,
    test: 'apify',
  },
  {
    id: 'groq_api_key',
    env: 'GROQ_API_KEY',
    label: 'Groq API key',
    hint: 'Personalisation and reply classification.',
    group: 'groq',
    secret: true,
    test: 'groq',
  },
  {
    id: 'llm_model',
    env: 'LLM_MODEL',
    label: 'Groq model',
    hint: 'Optional. Defaults to openai/gpt-oss-120b.',
    group: 'groq',
    secret: false,
  },
  {
    id: 'llm_base_url',
    env: 'LLM_BASE_URL',
    label: 'LLM base URL',
    hint: 'Optional OpenAI-compatible base. Defaults to Groq.',
    group: 'groq',
    secret: false,
  },
  {
    id: 'llm_hook_model',
    env: 'LLM_HOOK_MODEL',
    label: 'Hook model',
    hint: 'Optional smaller model for video hooks.',
    group: 'groq',
    secret: false,
  },
  {
    id: 'resend_api_key',
    env: 'RESEND_API_KEY',
    label: 'Resend API key',
    hint: 'Sends outreach, blasts, and follow-ups.',
    group: 'resend',
    secret: true,
    test: 'resend',
  },
  {
    id: 'resend_from_email',
    env: 'RESEND_FROM_EMAIL',
    label: 'From address',
    hint: 'Verified sender. A display name can be included as Name <you@example.com>.',
    group: 'resend',
    secret: false,
  },
  {
    id: 'resend_from_name',
    env: 'RESEND_FROM_NAME',
    label: 'From name',
    hint: 'Optional display name when the from address has no angle brackets.',
    group: 'resend',
    secret: false,
  },
  {
    id: 'resend_reply_to',
    env: 'RESEND_REPLY_TO',
    label: 'Reply-to address',
    hint: 'Where creator replies land. Usually the Gmail mailbox.',
    group: 'resend',
    secret: false,
  },
  {
    id: 'gmail_client_id',
    env: 'GMAIL_CLIENT_ID',
    label: 'Gmail OAuth client ID',
    hint: 'From the Google Cloud OAuth client.',
    group: 'gmail',
    secret: true,
    test: 'gmail',
  },
  {
    id: 'gmail_client_secret',
    env: 'GMAIL_CLIENT_SECRET',
    label: 'Gmail OAuth client secret',
    hint: 'Paired with the client ID. The refresh token is saved when you connect Gmail.',
    group: 'gmail',
    secret: true,
    test: 'gmail',
  },
  {
    id: 'gmail_mailbox',
    env: 'GMAIL_MAILBOX',
    label: 'Gmail mailbox',
    hint: 'Login hint for Connect. Defaults to the reply-to address.',
    group: 'gmail',
    secret: false,
  },
  {
    id: 'discord_webhook_url',
    env: 'DISCORD_WEBHOOK_URL',
    label: 'Discord webhook',
    hint: 'Same value as Connectors. Alerts for replies and sends.',
    group: 'other',
    secret: true,
    test: 'discord',
  },
  {
    id: 'slack_webhook_url',
    env: 'SLACK_WEBHOOK_URL',
    label: 'Slack webhook',
    hint: 'Optional Slack incoming webhook.',
    group: 'other',
    secret: true,
    test: 'slack',
  },
  {
    id: 'instantly_api_key',
    env: 'INSTANTLY_API_KEY',
    label: 'Instantly API key',
    hint: 'Optional cold-email provider.',
    group: 'other',
    secret: true,
    test: 'instantly',
  },
  {
    id: 'instantly_campaign_id',
    env: 'INSTANTLY_CAMPAIGN_ID',
    label: 'Instantly campaign ID',
    hint: 'Optional campaign used by the Instantly path.',
    group: 'other',
    secret: false,
  },
  {
    id: 'smartlead_api_key',
    env: 'SMARTLEAD_API_KEY',
    label: 'Smartlead API key',
    hint: 'Optional cold-email provider.',
    group: 'other',
    secret: true,
    test: 'smartlead',
  },
  {
    id: 'smartlead_campaign_id',
    env: 'SMARTLEAD_CAMPAIGN_ID',
    label: 'Smartlead campaign ID',
    hint: 'Optional campaign used by the Smartlead path.',
    group: 'other',
    secret: false,
  },
  {
    id: 'webhook_shared_secret',
    env: 'WEBHOOK_SHARED_SECRET',
    label: 'Webhook shared secret',
    hint: 'Verifies inbound webhooks. Send it as x-webhook-secret.',
    group: 'other',
    secret: true,
  },
  {
    id: 'public_api_url',
    env: 'PUBLIC_API_URL',
    label: 'Public API URL',
    hint: 'Builds the Gmail callback. Example: https://api.example.com',
    group: 'other',
    secret: false,
  },
  {
    id: 'admin_base_url',
    env: 'ADMIN_BASE_URL',
    label: 'Admin base URL',
    hint: 'Links in alerts. Example: https://admin.example.com',
    group: 'other',
    secret: false,
  },
  {
    id: 'app_name',
    env: 'APP_NAME',
    label: 'App name',
    hint: 'Fallback product name when a campaign has none.',
    group: 'other',
    secret: false,
  },
  {
    id: 'app_value_prop',
    env: 'APP_VALUE_PROP',
    label: 'Value proposition',
    hint: 'Fallback one-line pitch.',
    group: 'other',
    secret: false,
  },
];

export const INTEGRATION_FIELD_IDS = INTEGRATION_FIELDS.map((field) => field.id);

export function integrationField(id: string): IntegrationField | undefined {
  return INTEGRATION_FIELDS.find((field) => field.id === id);
}
