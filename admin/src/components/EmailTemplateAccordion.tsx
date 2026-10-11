import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fetchEmailTemplates, type EmailTemplate } from '../lib/supabase';
import { TemplateFields } from './TemplateFields';

export function EmailTemplateAccordion({
  campaignId,
  defaultOpen,
  appId,
  templateId,
  subject,
  body,
  appName,
  valueProp,
  onChange,
  onBlur,
  embedded = false,
  mode = 'template',
  enabled = false,
  onEnabledChange,
  reveal = 0,
}: {
  campaignId: string;
  defaultOpen: boolean;
  appId?: string | null;
  templateId: string | null;
  subject: string;
  body: string;
  appName?: string;
  valueProp?: string;
  onChange: (next: { templateId: string | null; subject: string; body: string }) => void;
  onBlur?: () => void;
  embedded?: boolean;
  mode?: 'template' | 'auto-email';
  enabled?: boolean;
  onEnabledChange?: (next: boolean) => void;
  /** Increment to open the template editor, for example when Auto-email needs a body. */
  reveal?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [forCampaign, setForCampaign] = useState(campaignId);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);

  if (forCampaign !== campaignId) {
    setForCampaign(campaignId);
    setOpen(defaultOpen);
  }

  useEffect(() => {
    if (reveal > 0) setOpen(true);
  }, [reveal]);

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

  const templateName = templates.find((row) => row.id === templateId)?.name || '';
  const summary = templateName || (subject.trim() || body.trim() ? 'Custom email' : '');

  const Tag = embedded ? 'div' : 'section';
  const autoEmail = mode === 'auto-email';

  return (
    <Tag className={embedded ? '' : 'section'}>
      <div className="flex w-full items-center justify-between gap-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span
            className="block text-sm font-medium text-ink"
            title={autoEmail ? 'Off by default. Sends after discovery only when a template is set.' : undefined}
          >
            {autoEmail ? 'Auto-email found creators' : 'Attach email template'}
          </span>
          {!autoEmail && !open && summary ? (
            <span className="mt-1 block truncate text-sm text-ink-faint">{summary}</span>
          ) : null}
        </button>
        {autoEmail && onEnabledChange ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Auto-email found creators"
            title="Off by default. Sends after discovery only when a template is set."
            className={enabled ? 'toggle-on' : 'toggle-off'}
            onClick={() => {
              if (!enabled) setOpen(true);
              onEnabledChange(!enabled);
            }}
          >
            <span className="toggle-knob" style={{ left: enabled ? '1.25rem' : '0.125rem' }} />
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost !px-2"
            aria-label={open ? 'Hide template' : 'Show template'}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-ink-faint transition-transform duration-200 ${
                open ? 'rotate-180' : ''
              }`}
            />
          </button>
        )}
      </div>
      <div className="accordion-panel" data-open={open ? 'true' : 'false'}>
        <div className="accordion-inner">
          <div className="pt-5">
            <TemplateFields
              appId={appId}
              templateId={templateId}
              subject={subject}
              body={body}
              appName={appName}
              valueProp={valueProp}
              onChange={onChange}
              onBlur={onBlur}
            />
          </div>
        </div>
      </div>
    </Tag>
  );
}
