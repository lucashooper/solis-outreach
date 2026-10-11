/**
 * Audience CRUD + direct blast send/test routes (service role).
 * Mounted from server/index.ts.
 */
import type { Express, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyBlastTemplate,
  parseAudienceMembersInput,
  sendBlastEmail,
  sleep,
} from '../src/pipeline/blast.js';
import { lookupSuppression } from '../src/outreach/suppression.js';
import { asTemplateId, insertSendRow } from '../src/pipeline/sendRecord.js';

type ServiceClientFactory = () => SupabaseClient | null;

export function registerAudienceBlastRoutes(
  app: Express,
  serviceClient: ServiceClientFactory,
): void {
  // -------------------------------------------------------------------------
  // Audiences
  // -------------------------------------------------------------------------

  app.get('/api/audiences', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const appId = typeof req.query.appId === 'string' ? req.query.appId.trim() : '';
    let groupsQuery = sb
      .from('audience_groups')
      .select('*')
      .order('created_at', { ascending: false });
    if (/^[0-9a-f-]{36}$/i.test(appId)) {
      groupsQuery = groupsQuery.or(`app_id.eq.${appId},app_id.is.null`);
    }
    const { data: groups, error } = await groupsQuery;
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    const ids = (groups ?? []).map((g) => g.id as string);
    let counts = new Map<string, number>();
    if (ids.length) {
      const { data: members } = await sb
        .from('audience_members')
        .select('group_id')
        .in('group_id', ids);
      counts = new Map();
      for (const m of members ?? []) {
        const gid = m.group_id as string;
        counts.set(gid, (counts.get(gid) ?? 0) + 1);
      }
    }
    res.json({
      ok: true,
      audiences: (groups ?? []).map((g) => ({
        ...g,
        member_count: counts.get(g.id as string) ?? 0,
      })),
    });
  });

  app.post('/api/audiences', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const appId =
      typeof req.body?.app_id === 'string' ? req.body.app_id.trim() : '';
    const insert: { name: string; app_id?: string; source?: string } = { name };
    if (/^[0-9a-f-]{36}$/i.test(appId)) insert.app_id = appId;
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    if (/^[a-z][a-z0-9_-]{0,31}$/.test(source)) insert.source = source;
    const { data, error } = await sb
      .from('audience_groups')
      .insert(insert)
      .select()
      .single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json(data);
  });

  app.get('/api/audiences/:id', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const id = req.params.id;
    const { data: group, error } = await sb
      .from('audience_groups')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    if (!group) {
      res.status(404).json({ error: 'Audience not found' });
      return;
    }
    const { data: members, error: mErr } = await sb
      .from('audience_members')
      .select('*')
      .eq('group_id', id)
      .order('created_at', { ascending: false });
    if (mErr) {
      res.status(500).json({ error: mErr.message });
      return;
    }
    res.json({ ...group, members: members ?? [] });
  });

  app.patch('/api/audiences/:id', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const { data, error } = await sb
      .from('audience_groups')
      .update({ name })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json(data);
  });

  app.delete('/api/audiences/:id', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const { error } = await sb
      .from('audience_groups')
      .delete()
      .eq('id', req.params.id);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true, id: req.params.id });
  });

  app.get('/api/audiences/:id/members', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const { data, error } = await sb
      .from('audience_members')
      .select('*')
      .eq('group_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true, members: data ?? [] });
  });

  app.post('/api/audiences/:id/members', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const groupId = req.params.id;
    const { data: group } = await sb
      .from('audience_groups')
      .select('id')
      .eq('id', groupId)
      .maybeSingle();
    if (!group) {
      res.status(404).json({ error: 'Audience not found' });
      return;
    }

    const parsed = parseAudienceMembersInput(req.body);
    if (parsed.length === 0) {
      res.status(400).json({
        error:
          'Provide emails: string[] or members: {email, display_name?}[] (comma/newline ok)',
      });
      return;
    }

    const rows = parsed.map((m) => ({
      group_id: groupId,
      email: m.email,
      display_name: m.display_name,
    }));

    const { data, error } = await sb
      .from('audience_members')
      .upsert(rows, { onConflict: 'group_id,email', ignoreDuplicates: false })
      .select();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(201).json({
      ok: true,
      added: data?.length ?? 0,
      members: data ?? [],
    });
  });

  app.delete('/api/audiences/:id/members/:memberId', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const { error } = await sb
      .from('audience_members')
      .delete()
      .eq('id', req.params.memberId)
      .eq('group_id', req.params.id);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Blasts
  // -------------------------------------------------------------------------

  app.post('/api/blasts/:campaignId/test', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const to =
      typeof req.body?.to === 'string' ? req.body.to.trim().toLowerCase() : '';
    if (!to || !to.includes('@')) {
      res.status(400).json({ error: 'to (email) is required' });
      return;
    }

    const campaign = await loadBlastCampaign(sb, req.params.campaignId, res);
    if (!campaign) return;

    const appName =
      (campaign.app_name as string)?.trim() ||
      process.env.APP_NAME?.trim() ||
      'Solis';
    const gate = await lookupSuppression(sb, { email: to, override: true });
    if (gate.skip) {
      res.status(409).json({ ok: false, error: gate.reason });
      return;
    }

    const subject = applyBlastTemplate(String(campaign.email_subject ?? ''), {
      display_name: 'Alex',
      creator_name: 'Alex',
      creator_handle: 'alexfits',
      hook: 'Your training clips feel like a natural fit.',
      app_name: appName,
      platform: 'tiktok',
      recent_video_topic: 'morning workout',
    });
    const body = applyBlastTemplate(String(campaign.email_body ?? ''), {
      display_name: 'Alex',
      creator_name: 'Alex',
      creator_handle: 'alexfits',
      hook: 'Your training clips feel like a natural fit.',
      app_name: appName,
      platform: 'tiktok',
      recent_video_topic: 'morning workout',
    });

    if (!subject.trim() || !body.trim()) {
      res.status(400).json({
        error: 'Campaign needs email_subject and email_body before testing',
      });
      return;
    }

    const result = await sendBlastEmail({
      to,
      subject: `[TEST] ${subject}`,
      body,
      resendApiKey: process.env.RESEND_API_KEY,
      resendFrom: process.env.RESEND_FROM_EMAIL,
      campaignId: campaign.id as string,
    });

    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error });
      return;
    }
    res.json({
      ok: true,
      to,
      providerMessageId: result.providerMessageId,
      dryRun: Boolean(result.dryRun),
      note: result.error,
    });
  });

  app.post('/api/blasts/:campaignId/send-one', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }

    const campaign = await loadBlastCampaign(sb, req.params.campaignId, res);
    if (!campaign) return;

    const groupId = campaign.audience_group_id as string | null;
    if (!groupId) {
      res.status(400).json({ error: 'Campaign has no audience_group_id' });
      return;
    }

    const memberId =
      typeof req.body?.memberId === 'string' ? req.body.memberId.trim() : '';
    const isFirst = Boolean(req.body?.isFirst);
    const isLast = Boolean(req.body?.isLast);

    let member: {
      id: string;
      email: string;
      display_name: string | null;
    } | null = null;

    if (memberId) {
      const { data, error } = await sb
        .from('audience_members')
        .select('id, email, display_name')
        .eq('id', memberId)
        .eq('group_id', groupId)
        .maybeSingle();
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }
      member = data as typeof member;
    } else if (
      typeof req.body?.email === 'string' &&
      req.body.email.includes('@')
    ) {
      const { data, error } = await sb
        .from('audience_members')
        .select('id, email, display_name')
        .eq('group_id', groupId)
        .eq('email', String(req.body.email).trim().toLowerCase())
        .maybeSingle();
      if (error) {
        res.status(500).json({ error: error.message });
        return;
      }
      member = data as typeof member;
    }

    if (!member) {
      res
        .status(400)
        .json({ error: 'memberId or email (in audience) is required' });
      return;
    }

    const appName =
      (campaign.app_name as string)?.trim() ||
      process.env.APP_NAME?.trim() ||
      'Solis';
    const subjectTpl = String(campaign.email_subject ?? '');
    const bodyTpl = String(campaign.email_body ?? '');
    if (!subjectTpl.trim() || !bodyTpl.trim()) {
      res.status(400).json({
        error: 'Campaign needs email_subject and email_body before sending',
      });
      return;
    }

    if (isFirst) {
      await sb
        .from('campaigns')
        .update({ status: 'outreaching' })
        .eq('id', campaign.id);
    }

    const gate = await lookupSuppression(sb, {
      email: String(member.email),
      override: Boolean(req.body?.override),
    });
    if (gate.skip) {
    const templateId = asTemplateId(campaign.template_id);
    const { data: row, error: insErr } = await insertSendRow(
      sb,
      'blast_sends',
      {
        campaign_id: campaign.id,
        member_id: member.id,
        email: member.email,
        status: 'skipped',
        error: gate.reason,
        sent_at: null,
        ...(templateId ? { template_id: templateId } : {}),
      },
      { select: true },
    );
      if (insErr) {
        res.status(500).json({ error: insErr.message });
        return;
      }
      if (isLast) {
        await sb.from('campaigns').update({ status: 'done' }).eq('id', campaign.id);
      }
      res.json({
        ok: true,
        status: 'skipped',
        email: member.email,
        error: gate.reason,
        send: row,
        campaignId: campaign.id,
      });
      return;
    }

    const vars = {
      display_name: (member.display_name as string) || 'there',
      creator_name: (member.display_name as string) || '',
      hook: '',
      app_name: appName,
      creator_handle: '',
    };
    const subject = applyBlastTemplate(subjectTpl, vars);
    const emailBody = applyBlastTemplate(bodyTpl, vars);
    const result = await sendBlastEmail({
      to: String(member.email),
      subject,
      body: emailBody,
      resendApiKey: process.env.RESEND_API_KEY,
      resendFrom: process.env.RESEND_FROM_EMAIL,
      campaignId: campaign.id as string,
    });

    const status = result.ok ? 'sent' : 'failed';
    const templateId = asTemplateId(campaign.template_id);
    const { data: row, error: insErr } = await insertSendRow(
      sb,
      'blast_sends',
      {
        campaign_id: campaign.id,
        member_id: member.id,
        email: member.email,
        status,
        error: result.ok
          ? result.dryRun
            ? result.error ?? null
            : null
          : result.error ?? 'send failed',
        provider_message_id: result.providerMessageId,
        sent_at: result.ok ? new Date().toISOString() : null,
        ...(templateId ? { template_id: templateId } : {}),
      },
      { select: true },
    );
    if (insErr) {
      res.status(500).json({ error: insErr.message });
      return;
    }

    if (isLast) {
      await sb
        .from('campaigns')
        .update({ status: 'done' })
        .eq('id', campaign.id);
    }

    res.json({
      ok: result.ok,
      status,
      email: member.email,
      display_name: member.display_name,
      subject,
      body: emailBody,
      dryRun: Boolean(result.dryRun),
      error: result.ok ? null : result.error,
      providerMessageId: result.providerMessageId,
      send: row,
      campaignId: campaign.id,
    });
  });

  app.post('/api/blasts/:campaignId/send', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }

    const campaign = await loadBlastCampaign(sb, req.params.campaignId, res);
    if (!campaign) return;

    const groupId = campaign.audience_group_id as string | null;
    if (!groupId) {
      res.status(400).json({ error: 'Campaign has no audience_group_id' });
      return;
    }

    const { data: members, error: mErr } = await sb
      .from('audience_members')
      .select('id, email, display_name')
      .eq('group_id', groupId);
    if (mErr) {
      res.status(500).json({ error: mErr.message });
      return;
    }
    if (!members?.length) {
      res.status(400).json({ error: 'Audience has no members' });
      return;
    }

    const appName =
      (campaign.app_name as string)?.trim() ||
      process.env.APP_NAME?.trim() ||
      'Solis';
    const subjectTpl = String(campaign.email_subject ?? '');
    const bodyTpl = String(campaign.email_body ?? '');
    if (!subjectTpl.trim() || !bodyTpl.trim()) {
      res.status(400).json({
        error: 'Campaign needs email_subject and email_body before sending',
      });
      return;
    }

    await sb
      .from('campaigns')
      .update({ status: 'outreaching' })
      .eq('id', campaign.id);

    // Respond immediately; process asynchronously so the request does not time out.
    res.json({
      ok: true,
      queued: members.length,
      campaignId: campaign.id,
      note: 'Blast started — check blast_sends / analytics for progress',
    });

    void (async () => {
      let sent = 0;
      let failed = 0;
      for (let i = 0; i < members.length; i++) {
        const member = members[i]!;
        const gate = await lookupSuppression(sb, { email: String(member.email) });
        if (gate.skip) {
          await insertSendRow(sb, 'blast_sends', {
            campaign_id: campaign.id,
            member_id: member.id,
            email: member.email,
            status: 'skipped',
            error: gate.reason,
            sent_at: null,
            ...(asTemplateId(campaign.template_id)
              ? { template_id: asTemplateId(campaign.template_id) }
              : {}),
          });
          if (i < members.length - 1) await sleep(500);
          continue;
        }
        const vars = {
          display_name: (member.display_name as string) || 'there',
          creator_name: (member.display_name as string) || '',
          hook: '',
          app_name: appName,
          creator_handle: '',
        };
        const subject = applyBlastTemplate(subjectTpl, vars);
        const body = applyBlastTemplate(bodyTpl, vars);
        const result = await sendBlastEmail({
          to: String(member.email),
          subject,
          body,
          resendApiKey: process.env.RESEND_API_KEY,
          resendFrom: process.env.RESEND_FROM_EMAIL,
          campaignId: campaign.id as string,
        });

        const status = result.ok ? 'sent' : 'failed';
        if (result.ok) sent += 1;
        else failed += 1;

        await insertSendRow(sb, 'blast_sends', {
          campaign_id: campaign.id,
          member_id: member.id,
          email: member.email,
          status,
          error: result.ok
            ? result.dryRun
              ? result.error ?? null
              : null
            : result.error ?? 'send failed',
          provider_message_id: result.providerMessageId,
          sent_at: result.ok ? new Date().toISOString() : null,
          ...(asTemplateId(campaign.template_id)
            ? { template_id: asTemplateId(campaign.template_id) }
            : {}),
        });

        if (i < members.length - 1) {
          await sleep(500);
        }
      }

      await sb
        .from('campaigns')
        .update({ status: 'done' })
        .eq('id', campaign.id);

      console.log(
        `[blast] campaign ${campaign.id} finished: sent=${sent} failed=${failed}`,
      );
    })().catch((err) => {
      console.error(
        '[blast] background send failed',
        err instanceof Error ? err.message : err,
      );
    });
  });

  app.get('/api/blasts/:campaignId/sends', async (req, res) => {
    const sb = serviceClient();
    if (!sb) {
      res.status(500).json({ error: 'Supabase not configured on server' });
      return;
    }
    const { data, error } = await sb
      .from('blast_sends')
      .select('*')
      .eq('campaign_id', req.params.campaignId)
      .order('created_at', { ascending: false });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    const rows = data ?? [];
    const counts = { sent: 0, failed: 0, opened: 0 };
    for (const r of rows) {
      const s = String(r.status);
      if (s === 'sent') counts.sent += 1;
      else if (s === 'failed') counts.failed += 1;
      else if (s === 'opened') counts.opened += 1;
    }
    res.json({ ok: true, counts, sends: rows });
  });
}

async function loadBlastCampaign(
  sb: SupabaseClient,
  campaignId: string,
  res: Response,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await sb
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }
  if (!data) {
    res.status(404).json({ error: 'Campaign not found' });
    return null;
  }
  if (data.campaign_type !== 'direct_blast') {
    res.status(400).json({
      error: 'Campaign is not a direct_blast (set campaign_type=direct_blast)',
    });
    return null;
  }
  return data as Record<string, unknown>;
}

/** Extend analytics payload with blast_sends counts (mutates / returns extras). */
export async function blastAnalyticsExtras(
  sb: SupabaseClient,
): Promise<{
  blastSent: number;
  blastFailed: number;
  blastOpened: number;
}> {
  const { data, error } = await sb.from('blast_sends').select('status');
  if (error) {
    console.warn('[analytics] blast_sends:', error.message);
    return { blastSent: 0, blastFailed: 0, blastOpened: 0 };
  }
  let blastSent = 0;
  let blastFailed = 0;
  let blastOpened = 0;
  for (const row of data ?? []) {
    const s = String(row.status);
    if (s === 'sent') blastSent += 1;
    else if (s === 'failed') blastFailed += 1;
    else if (s === 'opened') blastOpened += 1;
  }
  return { blastSent, blastFailed, blastOpened };
}

/** Shared create-campaign payload builder for direct_blast branch. */
export function buildDirectBlastPayload(
  body: Record<string, unknown>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'name is required' };

  const audienceGroupId =
    typeof body.audience_group_id === 'string'
      ? body.audience_group_id.trim()
      : '';
  if (!audienceGroupId) {
    return { ok: false, error: 'audience_group_id is required for direct_blast' };
  }

  const emailSubject =
    typeof body.email_subject === 'string' ? body.email_subject : '';
  const emailBody =
    typeof body.email_body === 'string' ? body.email_body : '';
  if (!emailSubject.trim()) {
    return { ok: false, error: 'email_subject is required for direct_blast' };
  }
  if (!emailBody.trim()) {
    return { ok: false, error: 'email_body is required for direct_blast' };
  }

  const appName =
    (typeof body.app_name === 'string' && body.app_name.trim()) ||
    process.env.APP_NAME?.trim() ||
    'Solis';
  const valueProp =
    (typeof body.value_prop === 'string' && body.value_prop.trim()) ||
    process.env.APP_VALUE_PROP?.trim() ||
    'helps creators monetise short-form content without ads';

  const payload: Record<string, unknown> = {
    name,
    niches: [],
    platforms: [],
    follower_min: null,
    follower_max: null,
    engagement_rate_min: null,
    result_limit: 1,
    auto_outreach: false,
    is_autopilot_enabled: false,
    schedule_cron: '0 10 * * *',
    status: 'draft',
    app_name: appName,
    value_prop: valueProp,
    campaign_type: 'direct_blast',
    audience_group_id: audienceGroupId,
    email_subject: emailSubject,
    email_body: emailBody,
    template_id:
      typeof body.template_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.template_id.trim())
        ? body.template_id.trim()
        : null,
  };
  const appId = typeof body.app_id === 'string' ? body.app_id.trim() : '';
  if (/^[0-9a-f-]{36}$/i.test(appId)) payload.app_id = appId;

  return { ok: true, payload };
}
