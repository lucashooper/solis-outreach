import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { expressApiUrl } from '../lib/settings';
import { useFeedback } from './feedback';

interface ApiKeyField {
  id: string;
  env: string;
  label: string;
  hint: string;
  group: 'apify' | 'groq' | 'resend' | 'gmail' | 'other';
  secret: boolean;
  testable: boolean;
  set: boolean;
  source: 'settings' | 'env' | null;
  display: string;
  detail: string;
}

interface KeysPayload {
  ok?: boolean;
  error?: string;
  gmailCallbackUrl?: string;
  fields?: ApiKeyField[];
  message?: string;
}

const GROUPS: Array<{ id: ApiKeyField['group']; title: string; blurb: string }> = [
  {
    id: 'apify',
    title: 'Apify',
    blurb: 'Creator search. Extra accounts are used when an earlier one is out of credit.',
  },
  {
    id: 'groq',
    title: 'Groq',
    blurb: 'Writes personalisation and classifies replies.',
  },
  {
    id: 'resend',
    title: 'Resend',
    blurb: 'Sends the email. The from address must be a verified domain.',
  },
  {
    id: 'gmail',
    title: 'Gmail',
    blurb: 'Reads replies. Add the callback URL to the Google OAuth client, then connect on Connectors.',
  },
  {
    id: 'other',
    title: 'Other',
    blurb: 'Optional providers and links. Leave a field empty to keep using the server environment.',
  },
];

async function readJson(res: Response): Promise<KeysPayload> {
  return (await res.json().catch(() => ({}))) as KeysPayload;
}

export function ApiKeysSection() {
  const { session } = useAuth();
  const { toast, confirm } = useFeedback();
  const [fields, setFields] = useState<ApiKeyField[]>([]);
  const [callbackUrl, setCallbackUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const token = session?.access_token ?? '';
  const api = expressApiUrl();

  const load = useCallback(async () => {
    if (!api || !token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${api}/api/settings/keys`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error || 'Could not load API keys.');
      setFields(body.fields ?? []);
      setCallbackUrl(body.gmailCallbackUrl || `${api}/api/gmail/oauth/callback`);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not load API keys.');
    } finally {
      setLoading(false);
    }
  }, [api, token, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const authHeaders = (json = false): HeadersInit => ({
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });

  const save = async (field: ApiKeyField, value: string | null) => {
    setBusy(field.id);
    try {
      const res = await fetch(`${api}/api/settings/keys`, {
        method: 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify({ id: field.id, value }),
      });
      const body = await readJson(res);
      if (!res.ok) throw new Error(body.error || 'Could not save that setting.');
      setFields(body.fields ?? []);
      setDrafts((current) => ({ ...current, [field.id]: '' }));
      setEditing((current) => ({ ...current, [field.id]: false }));
      toast('success', value ? 'Key saved.' : 'Key cleared.');
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not save that setting.');
    } finally {
      setBusy(null);
    }
  };

  const test = async (field: ApiKeyField) => {
    const draft = drafts[field.id]?.trim() ?? '';
    setBusy(`${field.id}:test`);
    try {
      const res = await fetch(`${api}/api/settings/keys/test`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ id: field.id, value: draft || undefined }),
      });
      const body = await readJson(res);
      if (!res.ok || !body.ok) throw new Error(body.message || body.error || 'Test failed.');
      toast('success', body.message || 'Test passed.');
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setBusy(null);
    }
  };

  const onClear = async (field: ApiKeyField) => {
    const ok = await confirm({
      title: `Clear ${field.label}?`,
      body: 'The saved value is removed. The server falls back to the environment variable when one is set.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    await save(field, null);
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      toast('success', 'Callback URL copied.');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('error', 'Could not copy the callback URL.');
    }
  };

  return (
    <section
      className="space-y-3"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
          event.preventDefault();
        }
      }}
    >
      <div>
        <h2 className="text-sm font-medium text-ink">API keys</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Stored in Supabase for the server only. This page shows a masked value. An empty field
          keeps the environment variable.
        </p>
      </div>

      {!api && <p className="text-sm text-ink-faint">The outreach API URL is not set.</p>}
      {api && loading && (
        <p className="flex items-center gap-2 text-sm text-ink-faint">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading API keys…
        </p>
      )}

      {api && !loading &&
        GROUPS.map((group) => {
          const rows = fields.filter((field) => field.group === group.id);
          if (!rows.length) return null;
          return (
            <div key={group.id} className="panel space-y-4 p-6">
              <div>
                <h3 className="text-sm font-medium text-ink">{group.title}</h3>
                <p className="mt-1 text-sm text-ink-muted">{group.blurb}</p>
              </div>
              {group.id === 'gmail' && callbackUrl && (
                <div className="rounded-xl border border-line bg-surface px-3 py-3">
                  <span className="label">Callback URL</span>
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                      {callbackUrl}
                    </code>
                    <button type="button" className="btn-secondary shrink-0" onClick={() => void onCopy()}>
                      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              )}
              {rows.map((field) => {
                const draft = drafts[field.id] ?? '';
                const replacing = Boolean(editing[field.id]);
                const rowBusy = busy === field.id || busy === `${field.id}:test`;
                const textValue = field.secret ? draft : replacing ? draft : field.display;
                return (
                  <div key={field.id} className="space-y-2 border-t border-line pt-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <label className="text-sm text-ink" htmlFor={`key-${field.id}`}>
                        {field.label}
                      </label>
                      {field.set && (
                        <span className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                          {field.source === 'env' ? 'From environment' : 'Saved'}
                          {field.detail ? ` · ${field.detail}` : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-faint">{field.hint}</p>
                    {field.secret && field.set && !editing[field.id] ? (
                      <p className="font-mono text-sm text-ink" id={`key-${field.id}`}>
                        {field.display}
                      </p>
                    ) : (
                      <input
                        id={`key-${field.id}`}
                        className="input font-mono text-xs"
                        type={field.secret ? 'password' : 'text'}
                        autoComplete="off"
                        spellCheck={false}
                        value={textValue}
                        placeholder={field.set ? 'Paste a replacement' : 'Not set'}
                        onFocus={() => {
                          if (!field.secret && !replacing) {
                            setEditing((current) => ({ ...current, [field.id]: true }));
                            setDrafts((current) => ({ ...current, [field.id]: field.display }));
                          }
                        }}
                        onChange={(event) => {
                          setDrafts((current) => ({ ...current, [field.id]: event.target.value }));
                          if (!field.secret) setEditing((current) => ({ ...current, [field.id]: true }));
                        }}
                      />
                    )}
                    <div className="flex flex-wrap gap-2">
                      {field.secret && field.set && !editing[field.id] && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setEditing((current) => ({ ...current, [field.id]: true }))}
                        >
                          Replace
                        </button>
                      )}
                      {(field.secret
                        ? replacing || !field.set
                        : replacing && draft.trim() !== field.display) && (
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={rowBusy || (field.secret && !draft.trim())}
                          onClick={() => {
                            const next = (field.secret ? draft : replacing ? draft : field.display).trim();
                            if (!next) {
                              toast('error', 'Paste a value, or use Clear.');
                              return;
                            }
                            void save(field, next);
                          }}
                        >
                          Save
                        </button>
                      )}
                      {field.secret && editing[field.id] && (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            setEditing((current) => ({ ...current, [field.id]: false }));
                            setDrafts((current) => ({ ...current, [field.id]: '' }));
                          }}
                        >
                          Cancel
                        </button>
                      )}
                      {field.source === 'settings' && (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={rowBusy}
                          onClick={() => void onClear(field)}
                        >
                          Clear
                        </button>
                      )}
                      {field.testable && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={rowBusy || (!field.set && !draft.trim())}
                          onClick={() => void test(field)}
                        >
                          {busy === `${field.id}:test` ? 'Testing…' : 'Test'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
    </section>
  );
}
