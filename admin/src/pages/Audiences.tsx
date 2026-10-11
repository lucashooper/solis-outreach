import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { IconButton } from '../components/IconButton';
import { AudienceDrawer } from '../components/AudienceDrawer';
import { AudienceFacts } from '../components/AudienceFacts';
import { ConnectBanner } from '../components/ConnectBanner';
import { SHOW_MORE_LIMIT, ShowMore, useExpandedList } from '../components/ShowMore';
import { useFeedback } from '../components/feedback';
import { useAppScope } from '../lib/apps';
import { isConfigured } from '../lib/settings';
import {
  createAudience,
  deleteAudience,
  fetchAudiences,
  type AudienceGroup,
} from '../lib/supabase';

export function Audiences() {
  const connected = isConfigured();
  const { appId, ready } = useAppScope();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { toast, undoable } = useFeedback();
  const audienceList = useExpandedList();
  const [groups, setGroups] = useState<AudienceGroup[]>([]);
  const [loading, setLoading] = useState(connected);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');

  const reload = useCallback(async () => {
    if (!connected || !ready || !appId) return;
    setLoading(true);
    try {
      setGroups(await fetchAudiences(appId));
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not load audiences');
    } finally {
      setLoading(false);
    }
  }, [connected, ready, appId, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openGroup = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('group', id);
    setParams(next);
  };

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const created = await createAudience(newName.trim(), appId);
      setNewName('');
      toast('success', `Created “${created.name}”.`);
      await reload();
      openGroup(created.id);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const onDeleteGroup = (id: string, name: string) => {
    const snapshot = groups;
    setGroups((rows) => rows.filter((row) => row.id !== id));
    if (params.get('group') === id) navigate(-1);
    undoable(
      `Deleted “${name}”.`,
      () => deleteAudience(id),
      () => setGroups(snapshot),
    );
  };

  return (
    <div className="page">
      <h1 className="page-title">Audiences</h1>
      {!connected && <ConnectBanner />}

      <form onSubmit={(event) => void onCreate(event)} className="flex gap-2">
        <input
          className="input"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="Audience name"
          disabled={!connected || busy}
        />
        <button type="submit" className="btn-primary shrink-0" disabled={!connected || busy || !newName.trim()}>
          <Plus className="h-4 w-4" />
          Create
        </button>
      </form>

      {loading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-ink-faint">No audiences for this app yet.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          {audienceList
            .slice([...groups].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)))
            .map((group) => {
            return (
              <li key={group.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openGroup(group.id)}>
                  <p className="truncate text-sm font-medium text-ink">{group.name}</p>
                  <AudienceFacts group={group} />
                </button>
                <IconButton
                  label="Delete"
                  tone="danger"
                  disabled={busy}
                  onClick={() => void onDeleteGroup(group.id, group.name)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            );
          })}
          {groups.length > SHOW_MORE_LIMIT && (
            <li>
              <ShowMore
                total={groups.length}
                expanded={audienceList.expanded}
                onToggle={audienceList.toggle}
              />
            </li>
          )}
        </ul>
      )}

      <AudienceDrawer
        groupId={params.get('group')}
        onClose={() => navigate(-1)}
        onChanged={() => void reload()}
      />
    </div>
  );
}
