import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { useFeedback } from './feedback';
import { TemplatePreview } from './TemplatePreview';
import { TemplateTokenPicker } from './TemplateTokenPicker';
import {
  createEmailTemplate,
  fetchEmailTemplates,
  type EmailTemplate,
} from '../lib/supabase';

export function TemplateFields({
  appId,
  templateId,
  subject,
  body,
  appName,
  valueProp,
  showPreview = true,
  dense = false,
  onChange,
  onBlur,
}: {
  appId?: string | null;
  templateId: string | null;
  subject: string;
  body: string;
  appName?: string;
  valueProp?: string;
  showPreview?: boolean;
  /** Shorter body and a quiet save action, for the send drawer. */
  dense?: boolean;
  onChange: (next: { templateId: string | null; subject: string; body: string }) => void;
  onBlur?: () => void;
}) {
  const { toast } = useFeedback();
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<'subject' | 'body'>('body');
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const insertToken = (token: string) => {
    const chip = `{{${token}}}`;
    const field = focus;
    const el = field === 'subject' ? subjectRef.current : bodyRef.current;
    const value = field === 'subject' ? subject : body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${chip}${value.slice(end)}`;
    onChange(field === 'subject' ? { templateId, subject: next, body } : { templateId, subject, body: next });
    window.requestAnimationFrame(() => {
      el?.focus();
      const pos = start + chip.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => {
    let cancelled = false;
    fetchEmailTemplates(appId)
      .then((rows) => {
        if (!cancelled) setTemplates(rows);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const selected = templates.some((row) => row.id === templateId) ? templateId || '' : '';

  const onSave = async () => {
    const name = saveName.trim();
    if (!name) {
      toast('info', 'Name the template before saving.');
      return;
    }
    setSaving(true);
    try {
      const created = await createEmailTemplate({
        name,
        subject,
        body,
        appId,
      });
      setTemplates((current) => [created, ...current.filter((row) => row.id !== created.id)]);
      onChange({ templateId: created.id, subject, body });
      setSaveOpen(false);
      setSaveName('');
      toast('success', 'Template saved.');
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Could not save the template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="label" htmlFor="template-picker">
          Template
        </label>
        <select
          id="template-picker"
          className="input"
          value={selected}
          onChange={(event) => {
            const id = event.target.value;
            const found = templates.find((row) => row.id === id);
            if (!found) {
              onChange({ templateId: null, subject, body });
              return;
            }
            onChange({ templateId: found.id, subject: found.subject, body: found.body });
          }}
        >
          <option value="">Choose a template</option>
          {templates.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="template-subject">
          Subject
        </label>
        <input
          id="template-subject"
          ref={subjectRef}
          className="input"
          value={subject}
          onFocus={() => setFocus('subject')}
          onChange={(event) => onChange({ templateId, subject: event.target.value, body })}
          onBlur={onBlur}
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
          className={`input font-mono text-sm ${dense ? 'min-h-[96px]' : 'min-h-[180px]'}`}
          value={body}
          onFocus={() => setFocus('body')}
          onChange={(event) => onChange({ templateId, subject, body: event.target.value })}
          onBlur={onBlur}
        />
        <div className="mt-2">
          <TemplateTokenPicker onInsert={insertToken} />
        </div>
      </div>
      {showPreview && (
        <TemplatePreview subject={subject} template={body} appName={appName} valueProp={valueProp} />
      )}
      {saveOpen ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            className="input"
            placeholder="Template name"
            value={saveName}
            onChange={(event) => setSaveName(event.target.value)}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={saving}
            onClick={() => void onSave()}
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn-ghost" disabled={saving} onClick={() => setSaveOpen(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="text-xs text-ink-faint hover:text-ink"
          onClick={() => setSaveOpen(true)}
        >
          Save as template
        </button>
      )}
    </div>
  );
}
