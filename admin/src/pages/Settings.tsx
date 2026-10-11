import { type FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Save, Radio } from 'lucide-react';
import { InfoTip } from '../components/InfoTip';
import { GmailConnectorCard } from '../components/GmailConnectorCard';
import { ApiKeysSection } from '../components/ApiKeysSection';
import { useFeedback } from '../components/feedback';
import { useAuth } from '../lib/auth';
import { savedDisplayName } from '../lib/displayName';
import {
  clearStoredSettings,
  getEnvProvidedFields,
  loadSettings,
  saveSettings,
  type EnvProvidedField,
} from '../lib/settings';
import { useQuickMode } from '../lib/quickMode';
import { pingDiscordWebhook, resetSupabaseClient } from '../lib/supabase';
import type { AppSettings } from '../lib/types';

export function Settings() {
  const [form, setForm] = useState<AppSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);
  const [pingBusy, setPingBusy] = useState(false);
  const [pingMsg, setPingMsg] = useState<string | null>(null);
  const [quick, setQuick] = useQuickMode();
  const { user, updateDisplayName } = useAuth();
  const { toast } = useFeedback();
  const [displayName, setDisplayName] = useState(() => savedDisplayName(user));
  const envFields = getEnvProvidedFields();

  useEffect(() => {
    setDisplayName(savedDisplayName(user));
  }, [user]);

  const fromEnv = (key: EnvProvidedField) => envFields.has(key);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    saveSettings(form);
    resetSupabaseClient();
    try {
      if (displayName.trim() !== savedDisplayName(user)) {
        await updateDisplayName(displayName);
      }
      setSaved(true);
      toast('success', 'Settings saved.');
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not save your display name');
    }
  };

  const onClear = () => {
    clearStoredSettings();
    resetSupabaseClient();
    setForm(loadSettings());
    setSaved(false);
    setPingMsg(null);
  };

  const onPing = async () => {
    if (!form.discordWebhookUrl.trim()) {
      setPingMsg('Paste a Discord webhook URL first.');
      return;
    }
    setPingBusy(true);
    setPingMsg(null);
    try {
      saveSettings(form);
      await pingDiscordWebhook(form.discordWebhookUrl);
      setPingMsg('Ping sent. Check the Discord channel.');
    } catch (err: unknown) {
      setPingMsg(err instanceof Error ? err.message : 'Ping failed');
    } finally {
      setPingBusy(false);
    }
  };

  return (
    <div className="page">
      <div>
        <h1 className="page-title">Settings</h1>
      </div>

      <form onSubmit={onSave} className="page">
        <section className="panel space-y-4 p-6">
          <h2 className="text-sm font-medium text-ink">You</h2>
          <label className="block">
            <span className="label">
              <span className="inline-flex items-center gap-1.5">
                Display name
                <InfoTip
                  label="Display name details"
                  text="Rename an app, its App Store link, and its one-line pitch from the app switcher. Right-click an avatar, or choose the name underneath."
                />
              </span>
            </span>
            <input
              id="displayName"
              className="input"
              value={displayName}
              placeholder={user?.email?.split('@')[0] || 'Your name'}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSaved(false);
              }}
              autoComplete="nickname"
            />
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn-primary">
              <Save className="h-4 w-4" />
              Save
            </button>
            {saved && <span className="text-sm text-emerald-300">Saved</span>}
          </div>
        </section>

        <section className="panel flex items-center justify-between gap-4 p-6">
          <h2 className="inline-flex items-center gap-1.5 text-sm font-medium text-ink">
            Quick Mode
            <InfoTip
              label="Quick Mode details"
              text="Sends go out immediately. Deletes happen on the first tap, and you can undo them."
            />
          </h2>
          <button
            type="button"
            role="switch"
            aria-checked={quick}
            aria-label="Quick Mode"
            className={quick ? 'toggle-on' : 'toggle-off'}
            onClick={() => setQuick(!quick)}
          >
            <span
              className="toggle-knob"
              style={{ left: quick ? '1.25rem' : '0.125rem' }}
            />
          </button>
        </section>

        <ApiKeysSection />

        <section className="space-y-3">
          <div className="flex items-end justify-between">
            <h2 className="text-sm font-medium text-ink">Connectors</h2>
            <Link to="/connectors" className="text-sm text-ink-muted hover:text-ink">
              Open Connectors
            </Link>
          </div>
          <GmailConnectorCard />
        </section>

        <details className="rounded-2xl border border-line bg-surface-raised">
          <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-ink-muted">
            Advanced
          </summary>
          <div className="space-y-4 border-t border-line px-5 py-4">
            <label className="block">
              <span className="label">Project URL</span>
              <input
                className="input font-mono text-xs"
                value={form.supabaseUrl}
                onChange={(e) => set('supabaseUrl', e.target.value)}
                readOnly={fromEnv('supabaseUrl')}
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="label">Anon key</span>
              <textarea
                className="input min-h-[72px] font-mono text-xs"
                value={form.supabaseAnonKey}
                onChange={(e) => set('supabaseAnonKey', e.target.value)}
                readOnly={fromEnv('supabaseAnonKey')}
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="label">Express API base URL</span>
              <input
                className="input font-mono text-xs"
                value={form.apiBaseUrl}
                onChange={(e) => set('apiBaseUrl', e.target.value)}
                readOnly={fromEnv('apiBaseUrl')}
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="label">
                <span className="inline-flex items-center gap-1.5">
                  Discord webhook
                  <InfoTip
                    label="Discord webhook details"
                    text="Reply and campaign alerts use the webhook saved on Connectors."
                  />
                </span>
              </span>
              <input
                className="input font-mono text-xs"
                value={form.discordWebhookUrl}
                onChange={(e) => set('discordWebhookUrl', e.target.value)}
                readOnly={fromEnv('discordWebhookUrl')}
                autoComplete="off"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-secondary"
                disabled={pingBusy || !form.discordWebhookUrl.trim()}
                onClick={() => void onPing()}
              >
                <Radio className="h-4 w-4" />
                {pingBusy ? 'Sending…' : 'Test ping'}
              </button>
              <button type="button" className="btn-ghost" onClick={onClear}>
                Clear local overrides
              </button>
              {pingMsg && <span className="text-sm text-ink-faint">{pingMsg}</span>}
            </div>
          </div>
        </details>
      </form>
    </div>
  );
}
