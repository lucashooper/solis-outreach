# Creator outreach — n8n workflow wiring

Step-by-step node graph matching the in-house blueprint. Paste the Code-node
scripts from `n8n/code-nodes/`. Configure credentials via n8n env / credential
store (never hard-code secrets).

## Architecture (happy path)

```
Supabase DB Webhook (creators INSERT)
        │
        ▼
[1] Webhook Trigger
        │
        ▼
[2] Supabase — Fetch creator (by id)
        │
        ▼
[3a] Code — Personalisation (mode=build) → { prompt }
        │
        ▼
[3b] OpenAI / Anthropic — chat completion
        │
        ▼
[4] Code — Personalisation (mode=merge) → { hook, emailBody }
        │
        ▼
[5] HTTP Request — Send cold email (Resend | Instantly | Smartlead)
        │
        ▼
    Supabase — Insert outreach_logs + set outreach_status='sent'

─── parallel reply path ───

Provider reply webhook
        │
        ▼
[6a] Webhook Trigger (verify shared secret)
        │
        ▼
[6b] Code — Reply classifier (mode=build) → { prompt }
        │
        ▼
[6c] LLM classify
        │
        ▼
[6d] Code — Reply classifier (mode=parse)
        → { sentiment, shouldNotify, updateStatus }
        │
        ├─ shouldNotify? → Slack / Discord
        └─ always → Supabase: outreach_status='replied'
                    + append outreach_logs.webhook_events
```

---

## Node-by-node

### 1. Trigger on `creators` INSERT

- **Node:** Webhook (POST)
- **Path:** e.g. `/creator-inserted`
- **Auth:** Header Auth — `Authorization: Bearer {{$env.WEBHOOK_SHARED_SECRET}}`
  (or `x-webhook-secret`)
- **Source:** Supabase Database Webhook on `public.creators` / INSERT
  (see `docs/webhook-setup.md`)
- **Typical payload fields:** `record.id`, `record.handle`, `record.bio`,
  `record.email`, `type`, `table`

Map `record` onto the workflow item, e.g. Set node:

| field | value |
|-------|-------|
| `creatorId` | `{{$json.record.id}}` |
| `bio` | `{{$json.record.bio}}` |
| `email` | `{{$json.record.email}}` |
| `handle` | `{{$json.record.handle}}` |
| `platform` | `{{$json.record.platform}}` |

Optional guard: IF node — continue only when `email` is non-empty and
`outreach_status === 'pending'`.

### 2. Fetch creator

- **Node:** Supabase (or HTTP Request to PostgREST)
- **Op:** `GET /rest/v1/creators?id=eq.{{creatorId}}&select=*`
- **Auth:** service role key (`SUPABASE_SERVICE_ROLE_KEY`)
- Merge fetched row with upstream fields. Set `outreach_status` → `queued`
  before sending (PATCH).

### 3. LLM personalisation

**3a. Code node** — paste `n8n/code-nodes/personalization-code-node.js`

- Ensure `$json.mode = 'build'` (or omit; default is build when no LLM raw)
- Requires `$json.bio`, `$env.APP_NAME`, `$env.APP_VALUE_PROP`
- Output: `{ prompt }`

**3b. OpenAI / Anthropic node**

- System: `You output JSON only.`
- User: `{{$json.prompt}}`
- Temperature: low (e.g. 0.3)
- Pass through original item fields (creatorId, email, handle, template)

### 4. Merge template

**Code node** — same personalisation script with `$json.mode = 'merge'`

- Set `$json.raw` (or rely on message.content from the LLM node)
- Set `$json.template` — your step-1 email body, e.g.

  ```
  Hi {{handle}},

  {{hook}}

  Would you be open to trying {{appName}}? {{valueProp}}

  Cheers
  ```

- Set `$json.vars` = `{ handle, appName, valueProp, ... }`
- Output: `{ hook, emailBody }`
- Persist hook: PATCH `creators.ai_variables` ← `{"hook": "..."}`

### 5. Send cold email API

**Option A — Resend**

- HTTP Request `POST https://api.resend.com/emails`
- Header: `Authorization: Bearer {{$env.RESEND_API_KEY}}`
- Body (JSON) — build with the TS helper or inline:

  ```json
  {
    "from": "{{$env.RESEND_FROM_EMAIL}}",
    "to": ["{{$json.email}}"],
    "subject": "Quick idea for {{$json.handle}}",
    "html": "{{$json.emailBody}}"
  }
  ```

**Option B — Instantly**

- `POST https://api.instantly.ai/api/v2/leads`
- Body shape from `buildColdEmailPayload({ provider: 'instantly', ... })`
- Set `campaign` from `INSTANTLY_CAMPAIGN_ID`; map `sequenceTags`

**Option C — Smartlead**

- `POST https://server.smartlead.ai/api/v1/campaigns/{{$env.SMARTLEAD_CAMPAIGN_ID}}/leads`
- Body shape from `buildColdEmailPayload({ provider: 'smartlead', ... })`

After success:

1. INSERT `outreach_logs` — `creator_id`, `message_body`, `sequence_step=1`,
   `sent_at=now()`, `provider`, `provider_message_id`
2. PATCH `creators.outreach_status` → `sent`

For steps 2–3 (follow-ups), clone this branch with `sequence_step` 2 / 3 and
different templates; gate on time delay or Instantly/Smartlead native sequences.

### 6. Reply webhook → classify → notify + update

**6a. Webhook** — e.g. `/email-reply`

- Verify `WEBHOOK_SHARED_SECRET`
- Normalise provider payloads into `{ replyText, creatorId, providerMessageId }`
  (Set / Code node per provider)

**6b–6d. Classifier** — paste `n8n/code-nodes/reply-classifier-code-node.js`

1. mode `build` → LLM → mode `parse`
2. Output: `sentiment`, `shouldNotify`, `updateStatus`

**IF `shouldNotify`** (Interested | Price Question):

- Slack Incoming Webhook or Discord webhook
- Message example: `Creator {{handle}} replied: {{sentiment}}\n{{replyText}}`

**Always (on successful classify):**

- PATCH `creators` SET `outreach_status = 'replied'` WHERE `id = creatorId`
- UPDATE `outreach_logs` — append to `webhook_events`, e.g.

  ```sql
  webhook_events = webhook_events || jsonb_build_array(
    jsonb_build_object(
      'at', now(),
      'sentiment', $sentiment,
      'provider_event', $rawEvent
    )
  )
  ```

  (Use Supabase RPC or read-modify-write in n8n.)

**Unsubscribe branch:** optionally stop sequences via provider API and flag the
creator (still set `replied` or add a dedicated status later).

---

## Minimal importable skeleton (n8n workflow JSON)

n8n versions differ; treat this as a starting skeleton — recreate credentials
and paste Code-node bodies after import.

```json
{
  "name": "Creator Outreach Engine",
  "nodes": [
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "creator-inserted",
        "responseMode": "onReceived"
      },
      "name": "Creators INSERT Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 0],
      "webhookId": "creator-inserted"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            { "name": "creatorId", "value": "={{ $json.record.id }}", "type": "string" },
            { "name": "bio", "value": "={{ $json.record.bio }}", "type": "string" },
            { "name": "email", "value": "={{ $json.record.email }}", "type": "string" },
            { "name": "handle", "value": "={{ $json.record.handle }}", "type": "string" },
            { "name": "mode", "value": "build", "type": "string" }
          ]
        }
      },
      "name": "Map Insert Payload",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [220, 0]
    },
    {
      "parameters": {
        "jsCode": "// Paste contents of n8n/code-nodes/personalization-code-node.js"
      },
      "name": "Build Personalisation Prompt",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [440, 0]
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "email-reply",
        "responseMode": "onReceived"
      },
      "name": "Email Reply Webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 400],
      "webhookId": "email-reply"
    },
    {
      "parameters": {
        "jsCode": "// Paste contents of n8n/code-nodes/reply-classifier-code-node.js"
      },
      "name": "Reply Classifier",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [440, 400]
    }
  ],
  "connections": {
    "Creators INSERT Webhook": {
      "main": [[{ "node": "Map Insert Payload", "type": "main", "index": 0 }]]
    },
    "Map Insert Payload": {
      "main": [[{ "node": "Build Personalisation Prompt", "type": "main", "index": 0 }]]
    }
  },
  "settings": { "executionOrder": "v1" }
}
```

Wire the remaining nodes (LLM, merge Code, HTTP send, Supabase updates, Slack)
manually following steps 2–6 above.

## Env vars used by this flow

See `.env.example` and `docs/webhook-setup.md` — at minimum:

`APP_NAME`, `APP_VALUE_PROP`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`WEBHOOK_SHARED_SECRET`, provider API keys, `SLACK_WEBHOOK_URL` or
`DISCORD_WEBHOOK_URL`.

---

## Express API paths (preferred v1)

For reliability, discovery + Resend run in Express (`npm run server`). n8n is optional.

| Method | Path | Role |
|--------|------|------|
| `POST` | `http://localhost:3001/api/campaigns/:id/run` | Body `{ "provider": "demo" \| "apify" }` — discover, upsert, optional outreach |
| `GET` | `http://localhost:3001/api/health` | Config flags (Apify / Supabase / Resend / Discord) |
| `POST` | `http://localhost:3001/api/webhooks/email-reply` | Reply classify → Discord on Interested / Price Question → set `replied` |

When using n8n instead (or in parallel):

| n8n webhook path | Matches |
|------------------|---------|
| `/webhook/creator-inserted` | On creator status → queued / insert: personalise + Resend + log + set sent |
| `/webhook/email-reply` | Reply webhook → classify → Discord + replied |

Local n8n: `cd n8n && docker compose up -d` → http://localhost:5678
