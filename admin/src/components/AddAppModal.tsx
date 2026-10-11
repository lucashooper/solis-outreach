import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { createApp, searchStoreApps, type StoreAppResult } from '../lib/supabase';
import { useAppScope } from '../lib/apps';

export function AddAppModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { refreshApps, selectApp } = useAppScope();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StoreAppResult[]>([]);
  const [picked, setPicked] = useState<StoreAppResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setPicked(null);
    setError(null);
    setSearched(false);
  }, [open]);

  if (!open) return null;

  const onSearch = async () => {
    const term = query.trim();
    if (!term) return;
    setBusy(true);
    setError(null);
    setPicked(null);
    try {
      const rows = await searchStoreApps(term);
      setResults(rows);
      setSearched(true);
    } catch (err) {
      setResults([]);
      setSearched(true);
      setError(err instanceof Error ? err.message : 'App Store lookup failed');
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await createApp({
        name: picked.name,
        developer: picked.developer,
        bundleId: picked.bundleId,
        trackId: picked.trackId,
        iconUrl: picked.iconUrl,
        storeUrl: picked.storeUrl,
      });
      await refreshApps();
      selectApp(saved.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the app');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]">
      <div
        className="panel w-full max-w-lg p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-app-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="add-app-title" className="text-lg font-medium tracking-tight text-ink">
              Add app
            </h2>
            <p className="mt-1 text-sm text-ink-faint">
              Search the App Store by name, bundle ID, or track ID.
            </p>
          </div>
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onSearch();
          }}
        >
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Astra, com.example.app, or 123456789"
            aria-label="App Store search"
            autoFocus
          />
          <button type="submit" className="btn-primary shrink-0" disabled={busy || !query.trim()}>
            <Search className="h-4 w-4" />
            Search
          </button>
        </form>

        {busy && <p className="mt-3 text-sm text-ink-muted">Searching the UK and US App Stores…</p>}

        {error && (
          <p className="mt-3 text-sm text-red-300" role="alert">
            {error}
          </p>
        )}

        {results.length > 0 && (
          <ul className="mt-4 max-h-80 space-y-2 overflow-y-auto" role="listbox" aria-label="App Store results">
            {results.map((app) => {
              const selected = picked?.trackId === app.trackId && picked?.name === app.name;
              return (
                <li key={`${app.trackId ?? app.bundleId ?? app.name}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => setPicked(app)}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                      selected
                        ? 'border-accent/50 bg-accent/10'
                        : 'border-line hover:bg-white/[0.04]'
                    }`}
                  >
                    {app.iconUrl ? (
                      <img
                        src={app.iconUrl}
                        alt=""
                        className="h-12 w-12 rounded-xl bg-surface object-cover"
                      />
                    ) : (
                      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface text-sm text-ink-faint">
                        {app.name.slice(0, 1)}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{app.name}</span>
                      <span className="block truncate text-xs text-ink-faint">
                        {app.developer || 'Unknown developer'}
                        {app.genre ? ` · ${app.genre}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {searched && results.length === 0 && !error && !busy && (
          <p className="mt-4 text-sm text-ink-muted">
            Nothing on the UK or US App Store matched that. If the app is not released on those storefronts, it will not appear here.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!picked || busy} onClick={() => void onSave()}>
            {busy ? 'Saving…' : 'Add app'}
          </button>
        </div>
      </div>
    </div>
  );
}
