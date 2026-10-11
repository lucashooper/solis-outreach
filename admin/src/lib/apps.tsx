import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './auth';
import { isConfigured } from './settings';
import { fetchApps } from './supabase';
import type { SolisApp } from './types';

const STORAGE_KEY = 'solis-selected-app';

interface AppScopeState {
  apps: SolisApp[];
  appId: string | null;
  selected: SolisApp | null;
  ready: boolean;
  error: string | null;
  selectApp: (id: string) => void;
  replaceApp: (app: SolisApp) => void;
  removeApp: (id: string) => void;
  refreshApps: () => Promise<void>;
}

const AppScopeContext = createContext<AppScopeState | null>(null);

export function AppScopeProvider({ children }: { children: ReactNode }) {
  const { loading: authLoading, session } = useAuth();
  const [apps, setApps] = useState<SolisApp[]>([]);
  const [appId, setAppId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshApps = useCallback(async () => {
    if (!isConfigured()) {
      setApps([]);
      setAppId(null);
      setError(null);
      return;
    }
    try {
      const rows = await fetchApps();
      setApps(rows);
      setError(null);
      setAppId((current) => {
        const stored = current || localStorage.getItem(STORAGE_KEY);
        const match = rows.find((app) => app.id === stored);
        const next = match?.id ?? rows[0]?.id ?? null;
        if (next) localStorage.setItem(STORAGE_KEY, next);
        else localStorage.removeItem(STORAGE_KEY);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load apps');
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    void refreshApps().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, session?.user?.id, refreshApps]);

  const selectApp = useCallback((id: string) => {
    setAppId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  const replaceApp = useCallback((app: SolisApp) => {
    setApps((current) => {
      const exists = current.some((row) => row.id === app.id);
      if (!exists) return [...current, app];
      return current.map((row) => (row.id === app.id ? app : row));
    });
  }, []);

  const removeApp = useCallback((id: string) => {
    setApps((current) => {
      const next = current.filter((row) => row.id !== id);
      setAppId((selectedId) => {
        if (selectedId !== id) return selectedId;
        const fallback = next[0]?.id ?? null;
        if (fallback) localStorage.setItem(STORAGE_KEY, fallback);
        else localStorage.removeItem(STORAGE_KEY);
        return fallback;
      });
      return next;
    });
  }, []);

  const selected = apps.find((app) => app.id === appId) ?? null;

  const value = useMemo<AppScopeState>(
    () => ({
      apps,
      appId,
      selected,
      ready,
      error,
      selectApp,
      replaceApp,
      removeApp,
      refreshApps,
    }),
    [apps, appId, selected, ready, error, selectApp, replaceApp, removeApp, refreshApps],
  );

  return <AppScopeContext.Provider value={value}>{children}</AppScopeContext.Provider>;
}

export function useAppScope(): AppScopeState {
  const ctx = useContext(AppScopeContext);
  if (!ctx) throw new Error('useAppScope must be used within AppScopeProvider');
  return ctx;
}
