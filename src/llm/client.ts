/**
 * OpenAI-compatible chat client pointed at Groq (or any LLM_BASE_URL).
 * Never logs API keys.
 */

export interface ChatJsonOptions {
  system?: string;
  user: string;
  temperature?: number;
  /** Override model (defaults to LLM_MODEL env). */
  model?: string;
  /** Cap completion length. Video hooks pass a small limit. */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

export interface ChatJsonResult {
  content: string;
  model: string;
}

function requireGroqApiKey(): string {
  const key = process.env.GROQ_API_KEY?.trim() ?? '';
  if (!key) {
    throw new Error(
      'GROQ_API_KEY is missing. Set it in .env or .env.local.secrets (see .env.example).',
    );
  }
  return key;
}

function llmBaseUrl(): string {
  const base =
    process.env.LLM_BASE_URL?.trim() || 'https://api.groq.com/openai/v1';
  return base.replace(/\/+$/, '');
}

function llmModel(override?: string): string {
  return (
    override?.trim() ||
    process.env.LLM_MODEL?.trim() ||
    'openai/gpt-oss-120b'
  );
}

/** True when GROQ_API_KEY is present (does not validate the key). */
export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

/**
 * Call chat/completions and return the assistant message content as a string.
 * Requests JSON object response_format when the API supports it.
 */
export async function chatJson(
  options: ChatJsonOptions,
): Promise<ChatJsonResult> {
  const apiKey = requireGroqApiKey();
  const model = llmModel(options.model);
  const fetchFn = options.fetchImpl ?? fetch;
  const url = `${llmBaseUrl()}/chat/completions`;

  const messages: Array<{ role: string; content: string }> = [];
  if (options.system?.trim()) {
    messages.push({ role: 'system', content: options.system.trim() });
  }
  messages.push({ role: 'user', content: options.user });

  const body: Record<string, unknown> = {
    model,
    temperature: options.temperature ?? 0.7,
    messages,
    response_format: { type: 'json_object' },
  };
  if (options.maxTokens && options.maxTokens > 0) {
    body.max_tokens = options.maxTokens;
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string; type?: string };
    model?: string;
  };

  if (!res.ok) {
    const detail =
      payload.error?.message ?? JSON.stringify(payload).slice(0, 300);
    throw new Error(`Groq LLM ${res.status}: ${detail}`);
  }

  const content = payload.choices?.[0]?.message?.content ?? '';
  if (!content.trim()) {
    throw new Error('Groq LLM returned an empty message content');
  }

  return { content, model: payload.model ?? model };
}
