import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Upload, UserPlus } from 'lucide-react';
import { IconButton } from './IconButton';
import { dashOrCount } from '../lib/metrics';
import {
  addAudienceMembers,
  deleteAudienceMember,
  fetchAudience,
  type AudienceMember,
} from '../lib/supabase';
import { useFeedback } from './feedback';
import { Drawer } from './Drawer';
import { SHOW_MORE_LIMIT, ShowMore, useExpandedList } from './ShowMore';

function parseCsv(text: string): Array<{ email: string; display_name?: string }> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const first = lines[0]!.toLowerCase();
  const hasHeader = first.includes('email');
  const start = hasHeader ? 1 : 0;
  const headerCols = hasHeader ? first.split(',').map((col) => col.trim()) : [];
  const emailIdx = headerCols.findIndex((col) => col === 'email');
  const nameIdx = headerCols.findIndex(
    (col) => col === 'display_name' || col === 'display name' || col === 'name',
  );
  const out: Array<{ email: string; display_name?: string }> = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((col) => col.trim().replace(/^"|"$/g, ''));
    const email = hasHeader ? (cols[emailIdx >= 0 ? emailIdx : 0] ?? '') : (cols.find((col) => col.includes('@')) ?? '');
    const display_name = hasHeader
      ? nameIdx >= 0
        ? cols[nameIdx]
        : cols[1]
      : cols.find((col) => col !== email);
    if (email.includes('@')) out.push({ email, display_name });
  }
  return out;
}

export function AudienceDrawer({
  groupId,
  onClose,
  onChanged,
}: {
  groupId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const navigate = useNavigate();
  const { toast, undoable } = useFeedback();
  const memberList = useExpandedList();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<AudienceMember[]>([]);
  const [query, setQuery] = useState('');
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    setQuery('');
    setPaste('');
    setLoading(true);
    fetchAudience(groupId)
      .then((detail) => {
        if (cancelled) return;
        setName(detail.name);
        setMembers(detail.members ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast('error', err instanceof Error ? err.message : 'Could not load members');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, toast]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return members;
    return members.filter(
      (member) =>
        member.email.toLowerCase().includes(needle) ||
        (member.display_name ?? '').toLowerCase().includes(needle),
    );
  }, [members, query]);

  const refresh = async () => {
    if (!groupId) return;
    const detail = await fetchAudience(groupId);
    setName(detail.name);
    setMembers(detail.members ?? []);
    onChanged?.();
  };

  const onAdd = async () => {
    if (!groupId || !paste.trim()) return;
    setBusy(true);
    try {
      const emails = paste
        .split(/[\n,;]+/)
        .map((part) => part.trim())
        .filter((part) => part.includes('@'));
      const result = await addAudienceMembers(groupId, { emails });
      setPaste('');
      await refresh();
      toast('success', `Added ${result.added}.`);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not add members');
    } finally {
      setBusy(false);
    }
  };

  const onCsv = async (file: File | null) => {
    if (!groupId || !file) return;
    setBusy(true);
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.length === 0) {
        toast('error', 'No emails found in that CSV.');
        return;
      }
      const result = await addAudienceMembers(groupId, { members: parsed });
      await refresh();
      toast('success', `Imported ${result.added}.`);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'CSV import failed');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = (member: AudienceMember) => {
    if (!groupId) return;
    const snapshot = members;
    setMembers((rows) => rows.filter((row) => row.id !== member.id));
    undoable(
      `Removed “${member.email}”.`,
      async () => {
        await deleteAudienceMember(groupId, member.id);
        onChanged?.();
      },
      () => setMembers(snapshot),
    );
  };

  const countLabel = members.length === 1 ? '1 member' : `${dashOrCount(members.length) === '—' ? '—' : members.length} members`;

  return (
    <Drawer open={Boolean(groupId)} title={name || 'Audience'} subtitle={countLabel} onClose={onClose}>
      <div className="space-y-4">
        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => {
            if (!groupId) return;
            navigate(`/campaigns/new?type=direct_blast&audience=${groupId}`);
          }}
        >
          Start direct blast
        </button>
        <input
          className="input"
          placeholder="Search name or email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-ink-faint">No members match.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {memberList.slice(visible).map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{member.display_name || '—'}</p>
                  <p className="truncate text-xs text-ink-faint">{member.email}</p>
                </div>
                <IconButton
                  label="Remove"
                  tone="danger"
                  className="shrink-0"
                  onClick={() => onRemove(member)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            ))}
            {visible.length > SHOW_MORE_LIMIT && (
              <li>
                <ShowMore
                  total={visible.length}
                  expanded={memberList.expanded}
                  onToggle={memberList.toggle}
                />
              </li>
            )}
          </ul>
        )}
        <div>
          <label className="label" htmlFor="audience-paste">
            Add emails
          </label>
          <textarea
            id="audience-paste"
            className="input min-h-[88px] font-mono text-xs"
            placeholder={'one@example.com\ntwo@example.com'}
            value={paste}
            onChange={(event) => setPaste(event.target.value)}
          />
          <button type="button" className="btn-secondary mt-2" disabled={busy || !paste.trim()} onClick={() => void onAdd()}>
            <UserPlus className="h-4 w-4" />
            Add
          </button>
        </div>
        <div>
          <label className="label inline-flex items-center gap-1.5">
            <Upload className="h-3.5 w-3.5" />
            CSV
          </label>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            className="block w-full text-xs text-ink-faint file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-xs file:text-ink"
            disabled={busy}
            onChange={(event) => void onCsv(event.target.files?.[0] ?? null)}
          />
        </div>
      </div>
    </Drawer>
  );
}
