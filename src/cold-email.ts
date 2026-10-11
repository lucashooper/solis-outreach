import type { ColdEmailInput } from './types.js';

/**
 * Builds a provider-specific outbound payload for Resend, Instantly, or Smartlead.
 *
 * Resend: realistic REST body (from, to, subject, html).
 * Instantly / Smartlead: stub shapes aligned with their lead/campaign APIs;
 * sequenceTags are attached for campaign tagging (document in n8n HTTP node).
 */
export function buildColdEmailPayload(
  input: ColdEmailInput,
): Record<string, unknown> {
  const {
    provider,
    to,
    from,
    replyTo,
    subject,
    htmlOrText,
    sequenceTags = [],
    creatorId,
    sequenceStep,
  } = input;

  const meta = {
    creator_id: creatorId,
    sequence_step: sequenceStep,
    sequence_tags: sequenceTags,
  };

  switch (provider) {
    case 'resend':
      return buildResendPayload({ to, from, replyTo, subject, htmlOrText, meta });
    case 'instantly':
      return buildInstantlyPayload({ to, from, subject, htmlOrText, sequenceTags, meta });
    case 'smartlead':
      return buildSmartleadPayload({ to, from, subject, htmlOrText, sequenceTags, meta });
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported email provider: ${String(_exhaustive)}`);
    }
  }
}

function buildResendPayload(args: {
  to: string;
  from?: string;
  replyTo?: string;
  subject: string;
  htmlOrText: string;
  meta: Record<string, unknown>;
}): Record<string, unknown> {
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(args.htmlOrText);
  const payload: Record<string, unknown> = {
    // Resend requires a verified from address — supply via input.from or env in n8n
    from: args.from ?? 'outreach@example.com',
    to: [args.to],
    subject: args.subject,
    tags: [
      { name: 'creator_id', value: String(args.meta.creator_id) },
      { name: 'sequence_step', value: String(args.meta.sequence_step) },
    ],
  };
  if (args.replyTo?.trim()) {
    payload.reply_to = args.replyTo.trim();
  }
  if (looksLikeHtml) {
    payload.html = args.htmlOrText;
  } else {
    payload.text = args.htmlOrText;
  }
  return payload;
}

/**
 * Instantly.ai — add lead / campaign enqueue shape (API v2-style stub).
 * POST typically to https://api.instantly.ai/api/v2/leads
 * Attach sequenceTags as custom variables / campaign labels in the HTTP node.
 */
function buildInstantlyPayload(args: {
  to: string;
  from?: string;
  subject: string;
  htmlOrText: string;
  sequenceTags: string[];
  meta: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    email: args.to,
    // Campaign ID should be set in n8n from INSTANTLY_CAMPAIGN_ID
    campaign: null,
    skip_if_in_workspace: true,
    custom_variables: {
      subject: args.subject,
      body: args.htmlOrText,
      from_override: args.from ?? null,
      creator_id: args.meta.creator_id,
      sequence_step: args.meta.sequence_step,
      sequence_tags: args.sequenceTags,
    },
    // Documented: map sequenceTags onto Instantly "labels" or custom vars in the HTTP Request node
    _docs: {
      sequenceTags:
        'Pass sequenceTags into Instantly labels or custom_variables; set campaign from INSTANTLY_CAMPAIGN_ID.',
    },
  };
}

/**
 * Smartlead.ai — lead add / campaign lead shape (stub aligned with public API).
 * POST typically to https://server.smartlead.ai/api/v1/campaigns/{campaign_id}/leads
 */
function buildSmartleadPayload(args: {
  to: string;
  from?: string;
  subject: string;
  htmlOrText: string;
  sequenceTags: string[];
  meta: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    lead_list: [
      {
        email: args.to,
        custom_fields: {
          subject: args.subject,
          email_body: args.htmlOrText,
          from_email: args.from ?? null,
          creator_id: args.meta.creator_id,
          sequence_step: String(args.meta.sequence_step),
          sequence_tags: args.sequenceTags.join(','),
        },
      },
    ],
    settings: {
      ignore_duplicate_leads_in_other_campaign: true,
    },
    // Documented: sequenceTags land in custom_fields.sequence_tags; set path campaign_id from SMARTLEAD_CAMPAIGN_ID
    _docs: {
      sequenceTags:
        'sequenceTags are joined into custom_fields.sequence_tags; set campaign_id in the URL from SMARTLEAD_CAMPAIGN_ID.',
    },
  };
}
