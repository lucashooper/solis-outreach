import { type FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ConnectBanner } from '../components/ConnectBanner';
import { CreatorForm } from '../components/CreatorForm';
import { useAppScope } from '../lib/apps';
import { goBack, hasInAppHistory } from '../lib/back';
import { isConfigured } from '../lib/settings';
import { fetchCreator, upsertCreator } from '../lib/supabase';
import type { CreatorFormData } from '../lib/types';

const EMPTY: CreatorFormData = {
  handle: '',
  platform: 'tiktok',
  bio: '',
  email: '',
  follower_count: '',
  outreach_status: 'pending',
};

export function CreatorEdit() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const { appId } = useAppScope();
  const navigate = useNavigate();
  const connected = isConfigured();

  const [form, setForm] = useState<CreatorFormData>(EMPTY);
  const [loading, setLoading] = useState(!isNew && connected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew || !connected || !id) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchCreator(id)
      .then((c) => {
        if (cancelled || !c) {
          if (!cancelled && !c) setError('Creator not found');
          return;
        }
        setForm({
          handle: c.handle,
          platform: c.platform,
          bio: c.bio ?? '',
          email: c.email ?? '',
          follower_count: c.follower_count != null ? String(c.follower_count) : '',
          outreach_status: c.outreach_status,
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isNew, connected, id]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!connected) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        handle: form.handle.trim().replace(/^@/, ''),
        platform: form.platform,
        bio: form.bio.trim() || null,
        email: form.email.trim() || null,
        follower_count: form.follower_count.trim()
          ? Number(form.follower_count)
          : null,
        outreach_status: form.outreach_status,
        ...(isNew && appId ? { app_id: appId } : {}),
      };
      const saved = await upsertCreator(payload, isNew ? undefined : id);
      navigate(`/creators/${saved.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (!connected) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">
          {isNew ? 'Add creator' : 'Edit creator'}
        </h1>
        <ConnectBanner />
      </div>
    );
  }

  if (loading) {
    return <p className="text-slate-500">Loading…</p>;
  }

  return (
    <div className="page">
      <div>
        <button
          type="button"
          className="text-xs text-slate-500 hover:text-accent"
          onClick={() => goBack(navigate, isNew ? '/creators' : `/creators/${id}`)}
        >
          ← {hasInAppHistory() ? 'Back' : 'Creators'}
        </button>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
          {isNew ? 'Add creator' : 'Edit creator'}
        </h1>
      </div>
      <CreatorForm
        value={form}
        onChange={setForm}
        onSubmit={(e) => void onSubmit(e)}
        submitLabel={isNew ? 'Create creator' : 'Save changes'}
        busy={busy}
        error={error}
      />
    </div>
  );
}
