import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Megaphone,
  Users,
  Radar,
  ContactRound,
  Mail,
  Plug,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { displayNameOf } from '../lib/displayName';
import { useAppScope } from '../lib/apps';
import { prefetchAppShell } from '../lib/prefetch';
import { useCrmUnread } from '../lib/replyInbox';
import { isConfigured } from '../lib/settings';
import { AppSwitcher } from './AppSwitcher';
import { AddAppModal } from './AddAppModal';
import { UnreadBadge } from './UnreadBadge';

const COLLAPSE_KEY = 'solis-sidebar-collapsed';

const nav = [
  { to: '/', label: 'Dashboard', end: true, icon: LayoutDashboard },
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/creators', label: 'CRM', icon: Users },
  { to: '/discover', label: 'Discover', icon: Radar },
  { to: '/audiences', label: 'Audiences', icon: ContactRound },
  { to: '/templates', label: 'Templates', icon: Mail },
  { to: '/connectors', label: 'Connectors', icon: Plug },
];

export function Layout() {
  const connected = isConfigured();
  const { appId } = useAppScope();
  const { user, session, signOut } = useAuth();
  const unread = useCrmUnread(appId, session?.access_token);
  const email = user?.email ?? '';
  const name = displayNameOf(user);
  const [addOpen, setAddOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const statusLabel = connected ? 'Connected' : 'Not connected';

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    prefetchAppShell(appId);
  }, [appId]);

  const toggle = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className="flex min-h-screen bg-surface">
      <aside
        className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-line bg-surface-raised transition-[width] duration-200 ${
          collapsed ? 'w-[84px]' : 'w-[272px]'
        }`}
      >
        <div className={`flex items-start gap-2 px-4 pt-5 ${collapsed ? 'flex-col items-center px-3' : ''}`}>
          <AppSwitcher collapsed={collapsed} onAdd={() => setAddOpen(true)} />
          <button
            type="button"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-ink-faint hover:bg-white/[0.05] hover:text-ink"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggle}
          >
            {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </button>
        </div>

        <nav className="mt-6 flex flex-1 flex-col gap-1 px-3">
          {nav.map((item) => {
            const Icon = item.icon;
            const unreadCount = item.to === '/creators' ? unread.total : 0;
            const title =
              unreadCount > 0
                ? `${item.label}, ${unreadCount} unread ${unreadCount === 1 ? 'reply' : 'replies'}`
                : item.label;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={title}
                onMouseEnter={() => prefetchAppShell(appId)}
                className={({ isActive }) =>
                  `relative flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] font-medium transition ${
                    collapsed ? 'justify-center px-0' : ''
                  } ${
                    isActive
                      ? 'bg-white/[0.08] text-ink'
                      : 'text-ink-muted hover:bg-white/[0.04] hover:text-ink'
                  }`
                }
              >
                <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
                {!collapsed && <span className="min-w-0 flex-1">{item.label}</span>}
                {unreadCount > 0 && (
                  <UnreadBadge count={unreadCount} dot={collapsed} className={collapsed ? '' : 'ml-auto'} />
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="space-y-1 border-t border-line px-3 py-4">
          <div
            className={`flex items-center gap-3 rounded-xl px-3 py-2 ${collapsed ? 'justify-center px-0' : ''}`}
            role="status"
            aria-label={statusLabel}
            title={email ? `${name} · ${email}` : statusLabel}
          >
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                connected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-amber-400'
              }`}
            />
            {!collapsed && (
              <span className="min-w-0 truncate text-sm text-ink" title={email || undefined}>
                {name}
              </span>
            )}
          </div>
          <NavLink
            to="/settings"
            title="Settings"
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] font-medium ${
                collapsed ? 'justify-center px-0' : ''
              } ${isActive ? 'bg-white/[0.08] text-ink' : 'text-ink-muted hover:bg-white/[0.04] hover:text-ink'}`
            }
          >
            <Settings className="h-[18px] w-[18px]" strokeWidth={1.75} />
            {!collapsed && <span>Settings</span>}
          </NavLink>
          <button
            type="button"
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[15px] font-medium text-ink-muted hover:bg-white/[0.04] hover:text-ink ${
              collapsed ? 'justify-center px-0' : ''
            }`}
            onClick={() => void signOut()}
          >
            <LogOut className="h-[18px] w-[18px]" strokeWidth={1.75} />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <main className="page-frame">
          <Outlet />
        </main>
      </div>
      <AddAppModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
