import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import type { DiscoveryPreset } from '../lib/supabase';

const VISIBLE = 4;

function PresetMenu({
  preset,
  onRename,
  onDelete,
  onClose,
}: {
  preset: DiscoveryPreset;
  onRename: (preset: DiscoveryPreset) => void;
  onDelete: (preset: DiscoveryPreset) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="menu"
      className="absolute right-0 top-full z-20 mt-1 w-36 rounded-xl border border-line bg-surface-overlay p-1 shadow-raised"
    >
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-white/[0.05]"
        onClick={() => {
          onRename(preset);
          onClose();
        }}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-white/[0.05]"
        onClick={() => {
          onDelete(preset);
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}

function PresetPill({
  preset,
  menuOpen,
  renaming,
  draft,
  onDraft,
  onApply,
  onToggleMenu,
  onRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  preset: DiscoveryPreset;
  menuOpen: boolean;
  renaming: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onApply: (preset: DiscoveryPreset) => void;
  onToggleMenu: (id: string) => void;
  onRename: (preset: DiscoveryPreset) => void;
  onCommitRename: (preset: DiscoveryPreset) => void;
  onCancelRename: () => void;
  onDelete: (preset: DiscoveryPreset) => void;
}) {
  if (renaming) {
    return (
      <form
        className="inline-flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCommitRename(preset);
        }}
      >
        <input
          className="input !w-40 !py-1"
          value={draft}
          autoFocus
          aria-label={`Rename ${preset.name}`}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancelRename();
          }}
        />
        <button type="submit" className="btn-secondary !px-2 !py-1 text-xs">
          Save
        </button>
      </form>
    );
  }

  return (
    <span className="relative inline-flex items-center rounded-full border border-line bg-white/[0.03]">
      <button
        type="button"
        className="max-w-[12rem] truncate px-3 py-1 text-sm text-ink hover:text-accent"
        onClick={() => onApply(preset)}
      >
        {preset.name}
      </button>
      <button
        type="button"
        className="pr-2 text-ink-faint hover:text-ink"
        aria-label={`Actions for ${preset.name}`}
        aria-expanded={menuOpen}
        onClick={() => onToggleMenu(preset.id)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menuOpen && (
        <PresetMenu
          preset={preset}
          onRename={onRename}
          onDelete={onDelete}
          onClose={() => onToggleMenu('')}
        />
      )}
    </span>
  );
}

export function DiscoveryPresets({
  presets,
  onApply,
  onRename,
  onDelete,
}: {
  presets: DiscoveryPreset[];
  onApply: (preset: DiscoveryPreset) => void;
  onRename: (preset: DiscoveryPreset, name: string) => void;
  onDelete: (preset: DiscoveryPreset) => void;
}) {
  const [menuId, setMenuId] = useState('');
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [renamingId, setRenamingId] = useState('');
  const [draft, setDraft] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuId && !overflowOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuId('');
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [menuId, overflowOpen]);

  if (presets.length === 0) return null;

  const visible = presets.slice(0, VISIBLE);
  const hidden = presets.slice(VISIBLE);

  const startRename = (preset: DiscoveryPreset) => {
    setRenamingId(preset.id);
    setDraft(preset.name);
    setMenuId('');
    setOverflowOpen(false);
  };

  const commitRename = (preset: DiscoveryPreset) => {
    const name = draft.trim();
    if (!name || name === preset.name) {
      setRenamingId('');
      return;
    }
    onRename(preset, name);
    setRenamingId('');
  };

  const pillProps = (preset: DiscoveryPreset) => ({
    preset,
    menuOpen: menuId === preset.id,
    renaming: renamingId === preset.id,
    draft,
    onDraft: setDraft,
    onApply,
    onToggleMenu: (id: string) => {
      setOverflowOpen(false);
      setMenuId((current) => (current === id ? '' : id));
    },
    onRename: startRename,
    onCommitRename: commitRename,
    onCancelRename: () => setRenamingId(''),
    onDelete,
  });

  return (
    <div ref={rootRef} className="space-y-2">
      <p className="label !mb-0">Saved presets</p>
      <div className="flex flex-wrap items-center gap-2">
        {visible.map((preset) => (
          <PresetPill key={preset.id} {...pillProps(preset)} />
        ))}
        {hidden.length > 0 && (
          <span className="relative">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-sm text-ink-muted hover:text-ink"
              aria-expanded={overflowOpen}
              onClick={() => {
                setMenuId('');
                setOverflowOpen((open) => !open);
              }}
            >
              {hidden.length} more
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {overflowOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 flex min-w-[14rem] flex-col gap-1 rounded-xl border border-line bg-surface-overlay p-2 shadow-raised">
                {hidden.map((preset) => (
                  <PresetPill key={preset.id} {...pillProps(preset)} />
                ))}
              </div>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
