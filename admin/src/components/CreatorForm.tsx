import type { FormEvent } from 'react';
import type { CreatorFormData, OutreachStatus, Platform } from '../lib/types';
import {
  outreachStatusChoiceValue,
  outreachStatusChoices,
} from '../../../src/crm/statusLabel.ts';
import { PLATFORMS } from '../lib/types';

interface Props {
  value: CreatorFormData;
  onChange: (next: CreatorFormData) => void;
  onSubmit: (e: FormEvent) => void;
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
}

export function CreatorForm({
  value,
  onChange,
  onSubmit,
  submitLabel,
  busy,
  error,
}: Props) {
  const set = <K extends keyof CreatorFormData>(key: K, v: CreatorFormData[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <form onSubmit={onSubmit} className="card space-y-4">
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="handle">
            Handle
          </label>
          <input
            id="handle"
            className="input"
            required
            placeholder="@creator"
            value={value.handle}
            onChange={(e) => set('handle', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="platform">
            Platform
          </label>
          <select
            id="platform"
            className="input"
            value={value.platform}
            onChange={(e) => set('platform', e.target.value as Platform)}
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p === 'tiktok' ? 'TikTok' : 'Instagram'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            placeholder="creator@example.com"
            value={value.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="followers">
            Follower count
          </label>
          <input
            id="followers"
            type="number"
            min={0}
            className="input"
            placeholder="10000"
            value={value.follower_count}
            onChange={(e) => set('follower_count', e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="status">
            Outreach status
          </label>
          <select
            id="status"
            className="input"
            value={outreachStatusChoiceValue(value.outreach_status)}
            onChange={(e) => set('outreach_status', e.target.value as OutreachStatus)}
          >
            {outreachStatusChoices().map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="bio">
            Bio
          </label>
          <textarea
            id="bio"
            className="input min-h-[100px] resize-y"
            placeholder="Creator bio for personalisation…"
            value={value.bio}
            onChange={(e) => set('bio', e.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}
