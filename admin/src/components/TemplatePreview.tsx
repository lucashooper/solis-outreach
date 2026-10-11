import {
  renderTemplate,
  sampleTemplateContext,
  type TemplateContext,
} from '../../../src/templates/tokens.ts';
import type { VideoHookProvenance } from '../../../src/templates/videoHook.ts';
import { HookSourceDisclosure } from './HookSourceDisclosure';

export function TemplatePreview({
  template,
  subject,
  context,
  appName,
  valueProp,
  hookProvenance,
  hookEdited = false,
}: {
  template: string;
  subject?: string;
  context?: TemplateContext;
  appName?: string;
  valueProp?: string;
  /** Set when this preview is a real creator line, not the sample. */
  hookProvenance?: VideoHookProvenance | null;
  hookEdited?: boolean;
}) {
  const sample = context ?? sampleTemplateContext(appName, valueProp);
  const preview = renderTemplate(template, sample);
  const renderedSubject = subject != null ? renderTemplate(subject, sample) : '';
  const showsHook = /\{\{\s*video_hook\s*\}\}/.test(`${subject ?? ''}\n${template}`);
  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-5">
      <p className="text-xs text-ink-faint">Preview</p>
      {subject != null && (
        <p className="mt-3 text-base font-medium tracking-tight text-ink">{renderedSubject || '—'}</p>
      )}
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-ink-muted">{preview || 'Nothing to preview yet.'}</p>
      {showsHook && (hookProvenance || hookEdited) && (
        <HookSourceDisclosure provenance={hookProvenance} edited={hookEdited} />
      )}
    </div>
  );
}
