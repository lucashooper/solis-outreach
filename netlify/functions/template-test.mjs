/** Send a rendered preview of a pitch or follow-up template to one address. */
import { handleOptions, json, serviceClient } from '../lib/blastShared.mjs';
import { ensureRuntimeSecrets } from '../lib/runtimeSecrets.mjs';
import { renderTemplate } from '../lib/templateTokens.mjs';
import { lookupSuppression } from '../lib/suppression.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
  if (!to.includes('@')) return json(400, { error: 'A test email address is required.' });
  const template = typeof body.template === 'string' ? body.template : '';
  const subjectTpl = typeof body.subject === 'string' && body.subject.trim()
    ? body.subject
    : 'Test: {{app_name}}';
  if (!template.trim()) return json(400, { error: 'Write a template before sending a test.' });

  const sb = serviceClient();
  if (sb) {
    try {
      const gate = await lookupSuppression(sb, { email: to, override: true });
      if (gate.skip) return json(409, { ok: false, error: gate.reason });
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : 'Could not check the block list' });
    }
  }

  const context = {
    creatorName: 'Alex',
    displayName: 'Alex',
    handle: 'alexfits',
    appName: typeof body.appName === 'string' && body.appName.trim() ? body.appName : 'Solis',
    platform: 'tiktok',
    hook: 'Your training clips feel like a natural fit.',
    recentVideoTopic: 'morning workout',
    valueProp: 'a clearer way to share the app',
  };
  const subject = `[TEST] ${renderTemplate(subjectTpl, context)}`;
  const emailBody = renderTemplate(template, context);
  await ensureRuntimeSecrets();
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from =
    String(process.env.RESEND_FROM_EMAIL || '').trim() ||
    'Alex from Example <outreach@example.com>';
  if (!apiKey) {
    return json(200, { ok: true, dryRun: true, subject, body: emailBody });
  }
  const html = /<[a-z][\s\S]*>/i.test(emailBody) ? emailBody : emailBody.replace(/\n/g, '<br>\n');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      tags: [{ name: 'type', value: 'template_test' }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return json(502, { ok: false, error: `Resend ${res.status}: ${JSON.stringify(data).slice(0, 300)}` });
  }
  return json(200, { ok: true, dryRun: false, subject });
}
