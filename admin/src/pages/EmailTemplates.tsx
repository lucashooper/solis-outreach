import { useEffect, useRef, useState } from 'react';
import { Copy, FlaskConical, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { IconButton } from '../components/IconButton';
import { SHOW_MORE_LIMIT, ShowMore, useExpandedList } from '../components/ShowMore';
import { useFeedback } from '../components/feedback';
import { TemplatePreview } from '../components/TemplatePreview';
import { useAppScope } from '../lib/apps';
import {
  createEmailTemplate,
  deleteEmailTemplate,
  fetchEmailTemplates,
  sendTemplateTest,
  updateEmailTemplate,
  type EmailTemplate,
} from '../lib/supabase';
import { TemplateTokenPicker } from '../components/TemplateTokenPicker';

function snippet(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim();
  if (!line) return '—';
  return line.length > 96 ? `${line.slice(0, 93).trimEnd()}…` : line;
}

function when(value: string): string {
  return new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London' });
}

const EMPTY: Pick<EmailTemplate, 'name' | 'subject' | 'body'> = {
  name: '',
  subject: '',
  body: '',
};

export function EmailTemplates() {
  const { appId, selected } = useAppScope();
  const { toast, undoable } = useFeedback();
  const templateList = useExpandedList();
  const [rows, setRows] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EmailTemplate | 'new' | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [focus, setFocus] = useState<'subject' | 'body'>('body');
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const load = () => {
    setLoading(true);
    fetchEmailTemplates(appId)
      .then(setRows)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load templates');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const openNew = () => {
    setDraft(EMPTY);
    setEditing('new');
    setError(null);
  };

  const openEdit = (row: EmailTemplate) => {
    setDraft({ name: row.name, subject: row.subject, body: row.body });
    setEditing(row);
    setError(null);
  };

  const insertToken = (token: string) => {
    const chip = `{{${token}}}`;
    const field = focus;
    const el = field === 'subject' ? subjectRef.current : bodyRef.current;
    const value = field === 'subject' ? draft.subject : draft.body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${chip}${value.slice(end)}`;
    setDraft((current) => ({ ...current, [field]: next }));
    window.requestAnimationFrame(() => {
      el?.focus();
      const pos = start + chip.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  const onSave = async () => {
    if (!draft.name.trim()) {
      setError('Name the template before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editing && editing !== 'new') {
        const saved = await updateEmailTemplate(editing.id, draft);
        setRows((current) => current.map((row) => (row.id === saved.id ? saved : row)));
        setEditing(saved);
      } else {
        const saved = await createEmailTemplate({ ...draft, appId });
        setRows((current) => [saved, ...current]);
        setEditing(saved);
      }
      toast('success', 'Template saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const onDuplicate = async (row: EmailTemplate) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await createEmailTemplate({
        name: `Copy of ${row.name}`,
        subject: row.subject,
        body: row.body,
        appId: row.app_id,
      });
      setRows((current) => [saved, ...current]);
      openEdit(saved);
      toast('success', 'Template duplicated.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not duplicate the template');
    } finally {
      setBusy(false);
    }
  };

  const onDelete = (row: EmailTemplate) => {
    const snapshot = rows;
    setRows((current) => current.filter((item) => item.id !== row.id));
    if (editing && editing !== 'new' && editing.id === row.id) setEditing(null);
    undoable(
      `Deleted “${row.name}”.`,
      () => deleteEmailTemplate(row.id),
      () => setRows(snapshot),
    );
  };

  const onTest = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendTemplateTest({
        to: testTo.trim(),
        subject: draft.subject || 'A note from {{app_name}}',
        template: draft.body,
        appName: selected?.name || 'Solis',
      });
      toast('success', 'Test email sent with the sample creator.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="page-title">Templates</h1>
        {!editing && (
          <button type="button" className="btn-primary" onClick={openNew}>
            <Plus className="h-4 w-4" />
            New template
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {editing ? (
        <div className="space-y-4">
          <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
            Back to templates
          </button>
          <div>
            <label className="label" htmlFor="template-name">
              Name
            </label>
            <input
              id="template-name"
              className="input"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Welcome note"
            />
          </div>
          <div>
            <label className="label" htmlFor="template-subject">
              Subject
            </label>
            <input
              id="template-subject"
              ref={subjectRef}
              className="input"
              value={draft.subject}
              onFocus={() => setFocus('subject')}
              onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))}
              placeholder="A note from {{app_name}}"
            />
          </div>
          <div>
            <label className="label" htmlFor="template-body">
              Body
            </label>
            <textarea
              id="template-body"
              ref={bodyRef}
              className="input min-h-[240px] text-sm leading-7"
              value={draft.body}
              onFocus={() => setFocus('body')}
              onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
              spellCheck={false}
            />
          </div>
          <TemplateTokenPicker onInsert={insertToken} />
          <TemplatePreview
            subject={draft.subject}
            template={draft.body}
            appName={selected?.name || 'Solis'}
            valueProp={selected?.value_prop || undefined}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="label" htmlFor="template-test-to">
                Send test
              </label>
              <input
                id="template-test-to"
                className="input"
                type="email"
                placeholder="you@example.com"
                value={testTo}
                onChange={(event) => setTestTo(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !testTo.trim() || !draft.body.trim()}
              onClick={() => void onTest()}
            >
              <FlaskConical className="h-4 w-4" />
              Send test
            </button>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !draft.name.trim()}
            onClick={() => void onSave()}
          >
            <Save className="h-4 w-4" />
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : loading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-sm text-ink-muted">
          No templates yet.
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          {templateList.slice(rows).map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{row.name}</p>
                <p className="mt-1 truncate text-sm text-ink-muted">{row.subject || '—'}</p>
                <p className="mt-1 truncate text-xs text-ink-faint">{snippet(row.body)}</p>
                <p className="mt-1 text-xs text-ink-faint" title={`Last edited ${when(row.updated_at)}`}>
                  Last edited {when(row.updated_at)}
                </p>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <IconButton label="Edit" onClick={() => openEdit(row)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton label="Duplicate" disabled={busy} onClick={() => void onDuplicate(row)}>
                  <Copy className="h-4 w-4" />
                </IconButton>
                <IconButton label="Delete" tone="danger" disabled={busy} onClick={() => void onDelete(row)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </li>
          ))}
          {rows.length > SHOW_MORE_LIMIT && (
            <li>
              <ShowMore
                total={rows.length}
                expanded={templateList.expanded}
                onToggle={templateList.toggle}
              />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
