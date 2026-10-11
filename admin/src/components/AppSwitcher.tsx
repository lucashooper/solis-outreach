import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { parseAppDetails, type AppDetailsPatch } from '../../../src/apps/details.ts';
import { planAppRemoval } from '../../../src/apps/deleteApp.ts';
import { useFeedback } from './feedback';
import { useAppScope } from '../lib/apps';
import { countAppRecords, deleteApp, setAppArchived, updateApp } from '../lib/supabase';
import type { SolisApp } from '../lib/types';

function AppIcon({ app, active }: { app: SolisApp; active: boolean }) {
  const letter = app.name.slice(0, 1).toUpperCase() || 'S';
  return (
    <span
      className={`relative inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-2xl border border-line text-sm font-medium shadow-none ring-0 ${
        active ? 'bg-white/[0.04]' : 'bg-transparent'
      }`}
      title={app.name}
    >
      {app.icon_url ? (
        <img src={app.icon_url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-ink-muted">{letter}</span>
      )}
    </span>
  );
}

type MenuMode = 'menu' | 'rename' | 'details';

interface MenuState {
  appId: string;
  top: number;
  left: number;
  mode: MenuMode;
  focusIcon?: boolean;
}

function placeMenu(anchor: HTMLElement): { top: number; left: number } {
  const rect = anchor.getBoundingClientRect();
  return {
    top: Math.min(rect.bottom + 6, window.innerHeight - 320),
    left: Math.min(Math.max(8, rect.left), window.innerWidth - 280),
  };
}

export function AppSwitcher({
  collapsed,
  onAdd,
}: {
  collapsed: boolean;
  onAdd: () => void;
}) {
  const { apps, selected, selectApp, replaceApp, removeApp, ready } = useAppScope();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const seeded = useRef(false);
  const requested = params.get('app');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftStore, setDraftStore] = useState('');
  const [draftPitch, setDraftPitch] = useState('');
  const [draftIcon, setDraftIcon] = useState('');
  const [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const iconRef = useRef<HTMLInputElement | null>(null);

  const menuApp = apps.find((app) => app.id === menu?.appId) ?? null;

  useEffect(() => {
    if (!ready || !selected || seeded.current) return;
    seeded.current = true;
    if (requested) return;
    const next = new URLSearchParams(params);
    next.set('app', selected.id);
    setParams(next, { replace: true });
  }, [ready, selected, requested, params, setParams]);

  useEffect(() => {
    if (!ready || !requested || requested === selected?.id) return;
    if (apps.some((app) => app.id === requested)) selectApp(requested);
  }, [ready, requested, selected?.id, apps, selectApp]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  useEffect(() => {
    if (menu?.mode === 'details' && menu.focusIcon) iconRef.current?.focus();
  }, [menu]);

  const choose = (id: string) => {
    if (id === selected?.id) return;
    const next = new URLSearchParams(params);
    next.set('app', id);
    navigate({ pathname: window.location.pathname, search: next.toString() });
    selectApp(id);
  };

  const openMenu = (app: SolisApp, anchor: HTMLElement, mode: MenuMode, focusIcon = false) => {
    const place = placeMenu(anchor);
    setDraftName(app.name);
    setDraftStore(app.store_url ?? '');
    setDraftPitch(app.value_prop ?? '');
    setDraftIcon(app.icon_url ?? '');
    setMenu({ appId: app.id, ...place, mode, focusIcon });
  };

  const commit = async (app: SolisApp, patch: AppDetailsPatch, message: string) => {
    const previous: AppDetailsPatch = {
      name: app.name,
      store_url: app.store_url,
      value_prop: app.value_prop ?? null,
      icon_url: app.icon_url,
    };
    if (
      previous.name === patch.name &&
      previous.store_url === patch.store_url &&
      (previous.value_prop ?? null) === patch.value_prop &&
      previous.icon_url === patch.icon_url
    ) {
      setMenu(null);
      return;
    }
    setSaving(true);
    replaceApp({ ...app, ...patch, value_prop: patch.value_prop });
    try {
      const saved = await updateApp(app.id, patch);
      replaceApp(saved);
      setMenu(null);
      toast('success', message, {
        undo: () => {
          replaceApp({ ...saved, ...previous, value_prop: previous.value_prop });
          void updateApp(app.id, previous)
            .then((row) => replaceApp(row))
            .catch((err: unknown) => {
              replaceApp(saved);
              toast('error', err instanceof Error ? err.message : 'Could not undo that change');
            });
        },
      });
    } catch (err) {
      replaceApp(app);
      toast('error', err instanceof Error ? err.message : 'Could not save the app');
    } finally {
      setSaving(false);
    }
  };

  const saveRename = () => {
    if (!menuApp || saving) return;
    const parsed = parseAppDetails({
      name: draftName,
      storeUrl: menuApp.store_url ?? '',
      valueProp: menuApp.value_prop ?? '',
      iconUrl: menuApp.icon_url ?? '',
    });
    if (!parsed.ok) {
      toast('error', parsed.error);
      return;
    }
    void commit(menuApp, parsed.patch, `Renamed to ${parsed.patch.name}.`);
  };

  const removeThisApp = async (app: SolisApp) => {
    const plan = planAppRemoval({
      visibleApps: apps.length,
      campaigns: 0,
      creators: 0,
    });
    if (plan.action === 'keep') {
      toast('error', plan.detail);
      setMenu(null);
      return;
    }
    setSaving(true);
    try {
      const counts = await countAppRecords(app.id);
      const next = planAppRemoval({
        visibleApps: apps.length,
        campaigns: counts.campaigns,
        creators: counts.creators,
      });
      if (next.action === 'keep') {
        toast('error', next.detail);
        return;
      }
      const leave = () => {
        const remaining = apps.filter((row) => row.id !== app.id);
        const nextId = selected?.id === app.id ? remaining[0]?.id : null;
        if (nextId) {
          const search = new URLSearchParams(params);
          search.set('app', nextId);
          navigate({ pathname: window.location.pathname, search: search.toString() });
        }
        removeApp(app.id);
        setMenu(null);
      };
      if (next.action === 'archive') {
        await setAppArchived(app.id, true);
        leave();
        toast('info', `Archived ${app.name}. ${next.detail}`, {
          undo: () => {
            replaceApp(app);
            selectApp(app.id);
            void setAppArchived(app.id, false).catch((err: unknown) => {
              removeApp(app.id);
              toast('error', err instanceof Error ? err.message : 'Could not undo that');
            });
          },
        });
        return;
      }
      try {
        await deleteApp(app.id);
      } catch (err) {
        await setAppArchived(app.id, true);
        leave();
        toast('info', `Archived ${app.name}. Linked rows stay in place.`, {
          undo: () => {
            replaceApp(app);
            selectApp(app.id);
            void setAppArchived(app.id, false).catch(() => {
              removeApp(app.id);
              toast('error', err instanceof Error ? err.message : 'Could not undo that');
            });
          },
        });
        return;
      }
      leave();
      toast('info', `Deleted ${app.name}. ${next.detail}`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Could not delete that app');
    } finally {
      setSaving(false);
    }
  };

  const saveDetails = () => {
    if (!menuApp || saving) return;
    const parsed = parseAppDetails({
      name: draftName,
      storeUrl: draftStore,
      valueProp: draftPitch,
      iconUrl: draftIcon,
    });
    if (!parsed.ok) {
      toast('error', parsed.error);
      return;
    }
    const renamed = parsed.patch.name !== menuApp.name;
    void commit(menuApp, parsed.patch, renamed ? `Renamed to ${parsed.patch.name}.` : 'App details saved.');
  };

  return (
    <div className={`min-w-0 flex-1 ${collapsed ? 'flex flex-col items-center' : ''}`}>
      <div className={`flex flex-wrap items-center gap-2 ${collapsed ? 'justify-center' : ''}`}>
        {apps.map((app) => (
          <div key={app.id} className="group relative">
            <button
              type="button"
              aria-label={`Switch to ${app.name}`}
              aria-pressed={app.id === selected?.id}
              className="rounded-2xl shadow-none ring-0 outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white/25"
              onClick={() => choose(app.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(app, event.currentTarget, 'menu');
              }}
            >
              <AppIcon app={app} active={app.id === selected?.id} />
            </button>
            <button
              type="button"
              className="absolute -right-1 -top-1 hidden h-5 w-5 items-center justify-center rounded-full border border-line bg-surface-raised text-[11px] leading-none text-ink-faint hover:text-ink group-hover:inline-flex group-focus-within:inline-flex"
              aria-label={`Options for ${app.name}`}
              onClick={(event) => openMenu(app, event.currentTarget, 'menu')}
            >
              …
            </button>
          </div>
        ))}
        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-dashed border-line text-ink-faint hover:border-line-strong hover:text-ink"
          aria-label="Add app"
          onClick={onAdd}
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>
      {!collapsed && (
        <button
          type="button"
          className="mt-3 block max-w-full truncate text-left text-sm font-medium text-ink hover:text-white"
          onClick={(event) => {
            if (!selected) return;
            openMenu(selected, event.currentTarget, 'menu');
          }}
        >
          {ready ? selected?.name || 'Choose an app' : 'Loading apps…'}
        </button>
      )}

      {menu && menuApp && (
        <div
          ref={menuRef}
          className="fixed z-[80] w-64 rounded-xl border border-white/10 bg-surface-raised p-1.5 text-sm shadow-lg"
          style={{ top: menu.top, left: menu.left }}
          role="menu"
        >
          {menu.mode === 'menu' && (
            <>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded-md px-2.5 py-2 text-left text-ink hover:bg-white/[0.04]"
                onClick={() => setMenu({ ...menu, mode: 'rename' })}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded-md px-2.5 py-2 text-left text-ink hover:bg-white/[0.04]"
                onClick={() => setMenu({ ...menu, mode: 'details' })}
              >
                Edit details
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded-md px-2.5 py-2 text-left text-ink hover:bg-white/[0.04]"
                onClick={() => setMenu({ ...menu, mode: 'details', focusIcon: true })}
              >
                Change icon
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded-md px-2.5 py-2 text-left text-red-300 hover:bg-white/[0.04] disabled:opacity-40"
                disabled={saving}
                onClick={() => void removeThisApp(menuApp)}
              >
                Delete app
              </button>
            </>
          )}
          {menu.mode === 'rename' && (
            <form
              className="p-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                saveRename();
              }}
            >
              <label className="label" htmlFor="app-rename">
                Name
              </label>
              <input
                id="app-rename"
                className="input"
                value={draftName}
                autoFocus
                disabled={saving}
                onChange={(event) => setDraftName(event.target.value)}
              />
              <p className="mt-2 text-[11px] text-ink-faint">Enter to save. Esc to cancel.</p>
            </form>
          )}
          {menu.mode === 'details' && (
            <form
              className="space-y-3 p-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                saveDetails();
              }}
            >
              <label className="block">
                <span className="label">Name</span>
                <input
                  className="input"
                  value={draftName}
                  disabled={saving}
                  onChange={(event) => setDraftName(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">App Store link</span>
                <input
                  className="input"
                  value={draftStore}
                  placeholder="https://apps.apple.com/…"
                  disabled={saving}
                  onChange={(event) => setDraftStore(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Value proposition</span>
                <textarea
                  className="input min-h-[72px]"
                  value={draftPitch}
                  placeholder="One-line pitch used as {{value_prop}}"
                  disabled={saving}
                  onChange={(event) => setDraftPitch(event.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Icon link</span>
                <input
                  ref={iconRef}
                  className="input"
                  value={draftIcon}
                  placeholder="https://…"
                  disabled={saving}
                  onChange={(event) => setDraftIcon(event.target.value)}
                />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setMenu(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary !px-2.5 !py-1 text-xs" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
