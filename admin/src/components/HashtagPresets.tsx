import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { HashtagPack } from '../../../src/discovery/hashtagPacks.ts';

function PackMenu({
  pack,
  onRename,
  onDelete,
  onClose,
}: {
  pack: HashtagPack;
  onRename: (pack: HashtagPack) => void;
  onDelete: (pack: HashtagPack) => void;
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
          onRename(pack);
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
          onDelete(pack);
          onClose();
        }}
      >
        Delete
      </button>
    </div>
  );
}

function PackPill({
  pack,
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
  pack: HashtagPack;
  menuOpen: boolean;
  renaming: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onApply: (pack: HashtagPack) => void;
  onToggleMenu: (id: string) => void;
  onRename: (pack: HashtagPack) => void;
  onCommitRename: (pack: HashtagPack) => void;
  onCancelRename: () => void;
  onDelete: (pack: HashtagPack) => void;
}) {
  if (renaming) {
    return (
      <form
        className="inline-flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onCommitRename(pack);
        }}
      >
        <input
          className="input !w-36 !py-1"
          value={draft}
          autoFocus
          aria-label={`Rename ${pack.name}`}
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
        title={pack.hashtags.join(' ')}
        onClick={() => onApply(pack)}
      >
        {pack.name}
      </button>
      {!pack.system && (
        <button
          type="button"
          className="pr-2 text-ink-faint hover:text-ink"
          aria-label={`Actions for ${pack.name}`}
          aria-expanded={menuOpen}
          onClick={() => onToggleMenu(pack.id)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      )}
      {menuOpen && !pack.system && (
        <PackMenu
          pack={pack}
          onRename={onRename}
          onDelete={onDelete}
          onClose={() => onToggleMenu('')}
        />
      )}
    </span>
  );
}

function PackRow({
  label,
  packs,
  menuId,
  renamingId,
  draft,
  onDraft,
  onApply,
  onToggleMenu,
  onRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  label: string;
  packs: HashtagPack[];
  menuId: string;
  renamingId: string;
  draft: string;
  onDraft: (value: string) => void;
  onApply: (pack: HashtagPack) => void;
  onToggleMenu: (id: string) => void;
  onRename: (pack: HashtagPack) => void;
  onCommitRename: (pack: HashtagPack) => void;
  onCancelRename: () => void;
  onDelete: (pack: HashtagPack) => void;
}) {
  if (packs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="label !mb-0">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        {packs.map((pack) => (
          <PackPill
            key={pack.id}
            pack={pack}
            menuOpen={menuId === pack.id}
            renaming={renamingId === pack.id}
            draft={draft}
            onDraft={onDraft}
            onApply={onApply}
            onToggleMenu={onToggleMenu}
            onRename={onRename}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

export function HashtagPresets({
  custom,
  system,
  saving,
  onApply,
  onSave,
  onRename,
  onDelete,
}: {
  custom: HashtagPack[];
  system: HashtagPack[];
  saving: boolean;
  onApply: (pack: HashtagPack) => void;
  onSave: (name: string) => Promise<boolean> | boolean;
  onRename: (pack: HashtagPack, name: string) => void;
  onDelete: (pack: HashtagPack) => void;
}) {
  const [menuId, setMenuId] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [draft, setDraft] = useState('');
  const [naming, setNaming] = useState(false);
  const [packName, setPackName] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const both = custom.length > 0 && system.length > 0;

  useEffect(() => {
    if (!menuId) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuId('');
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [menuId]);

  const startRename = (pack: HashtagPack) => {
    setRenamingId(pack.id);
    setDraft(pack.name);
    setMenuId('');
  };

  const commitRename = (pack: HashtagPack) => {
    const name = draft.trim();
    if (!name || name === pack.name) {
      setRenamingId('');
      return;
    }
    onRename(pack, name);
    setRenamingId('');
  };

  const rowProps = {
    menuId,
    renamingId,
    draft,
    onDraft: setDraft,
    onApply,
    onToggleMenu: (id: string) => setMenuId((current) => (current === id ? '' : id)),
    onRename: startRename,
    onCommitRename: commitRename,
    onCancelRename: () => setRenamingId(''),
    onDelete,
  };

  return (
    <div ref={rootRef} className="mt-3 space-y-2">
      {both ? (
        <>
          <PackRow label="Your presets" packs={custom} {...rowProps} />
          <PackRow label="System presets" packs={system} {...rowProps} />
        </>
      ) : (
        <PackRow
          label="Hashtag presets"
          packs={custom.length > 0 ? custom : system}
          {...rowProps}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-ghost !px-2 !py-1 text-xs"
          onClick={() => setNaming((open) => !open)}
        >
          Save pack
        </button>
        {naming && (
          <>
            <input
              className="input !w-40 !py-1"
              aria-label="Name this pack"
              placeholder="Name this pack"
              value={packName}
              onChange={(event) => setPackName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void Promise.resolve(onSave(packName)).then((saved) => {
                    if (!saved) return;
                    setPackName('');
                    setNaming(false);
                  });
                }
              }}
            />
            <button
              type="button"
              className="btn-secondary !px-2 !py-1 text-xs"
              disabled={saving}
              onClick={() => {
                void Promise.resolve(onSave(packName)).then((saved) => {
                  if (!saved) return;
                  setPackName('');
                  setNaming(false);
                });
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
