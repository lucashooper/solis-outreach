# Webhook setup guide

British English. No secrets are committed — copy `.env.example` → `.env` (or
n8n environment variables) and fill real values locally.

## Checklist (.env)

| Variable | Purpose |
|----------|---------|
| `APP_NAME` | Product name injected into personalisation prompts |
| `APP_VALUE_PROP` | One-line value proposition for prompts / templates |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | n8n only — bypasses RLS |
| `SUPABASE_ANON_KEY` | Optional; not used by n8n service paths |
| `WEBHOOK_SHARED_SECRET` | Shared bearer/header secret for all inbound webhooks |
| `GROQ_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL` | Groq LLM (personalisation + reply classify) |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Resend outbound |
| `INSTANTLY_API_KEY` / `INSTANTLY_CAMPAIGN_ID` | Instantly outbound |
| `SMARTLEAD_API_KEY` / `SMARTLEAD_CAMPAIGN_ID` | Smartlead outbound |
| `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` | Interest notifications |
| `N8N_WEBHOOK_BASE_URL` | Base URL for documenting callback endpoints |

---

## 1. Supabase Database Webhook → n8n (creators INSERT)

1. Deploy the migration in `supabase/migrations/` (`supabase db push` or SQL editor).
2. In n8n, create a **Webhook** node (POST), path e.g. `creator-inserted`.
   Activate the workflow and copy the Production URL:
   `{{N8N_WEBHOOK_BASE_URL}}/creator-inserted`.
3. Supabase Dashboard → **Database** → **Webhooks** → **Create a new hook**:
   - Name: `creators_insert_to_n8n`
   - Table: `public.creators`
   - Events: **Insert**
   - Type: HTTP Request
   - Method: POST
   - URL: the n8n Production URL above
   - HTTP Headers:
     - `Content-Type: application/json`
     - `Authorization: Bearer <WEBHOOK_SHARED_SECRET>`
       (or `x-webhook-secret: <WEBHOOK_SHARED_SECRET>`)
4. In n8n, add Header Auth / IF check that rejects requests without the secret.
5. Test: `INSERT INTO creators (handle, platform, bio, email) VALUES (...)`
   and confirm the n8n execution appears with `record.id`.

RLS stays enabled; the service role key used by n8n bypasses RLS. Do not put
the service role key in the Database Webhook — only the shared secret for n8n
ingress. n8n then calls Supabase with the service role on subsequent nodes.

---

## 2. Outbound cold email provider webhooks (replies)

Point each provider’s **reply / inbound** webhook at n8n:

`POST {{N8N_WEBHOOK_BASE_URL}}/email-reply`

### Resend

1. Resend Dashboard → Webhooks → Add endpoint → URL above.
2. Subscribe to events such as `email.received` (inbound) and optionally
   `email.delivered` / `email.bounced` for logging.
3. Verify signatures per Resend docs (svix) **or** gate on your shared secret
   if you terminate at a thin proxy. Prefer Resend’s signature verification
   in an n8n Code node when using their raw webhook.
4. Map payload → `{ replyText, providerMessageId, toAddress }` then look up
   `creators` / `outreach_logs` by email or `provider_message_id`.

### Instantly

1. Instantly → Settings → Webhooks (or campaign webhook).
2. Event: reply / lead replied.
3. Add header `x-webhook-secret: <WEBHOOK_SHARED_SECRET>`.
4. Normalise Instantly’s reply body field into `replyText`; resolve `creatorId`
   via `custom_variables.creator_id` if you set it on send.

### Smartlead

1. Smartlead → Webhooks → add reply webhook URL.
2. Include shared secret header.
3. Map reply content + lead email / custom field `creator_id` onto the
   classifier input.

---

## 3. Shared secret verification (n8n)

Recommended pattern on **every** public webhook:

1. **Webhook** node receives the request.
2. **IF** node:

   ```
   {{$json.headers.authorization}} === "Bearer " + $env.WEBHOOK_SHARED_SECRET
   ```

   or

   ```
   {{$json.headers["x-webhook-secret"]}} === $env.WEBHOOK_SHARED_SECRET
   ```

3. False branch → Respond 401 and stop.
4. True branch → continue workflow.

Rotate `WEBHOOK_SHARED_SECRET` periodically; update Supabase hook headers and
provider dashboards in the same change window.

---

## 4. Slack / Discord notify

When the reply classifier returns `shouldNotify === true`
(`Interested` or `Price Question`):

### Slack

- Create an Incoming Webhook in your Slack app / workspace.
- n8n **HTTP Request** POST to `SLACK_WEBHOOK_URL`:

  ```json
  {
    "text": "*Creator reply — {{$json.sentiment}}*\nHandle: {{$json.handle}}\n{{$json.replyText}}"
  }
  ```

### Discord

- Channel → Edit channel → Integrations → Webhooks → New Webhook.
- POST to `DISCORD_WEBHOOK_URL`:

  ```json
  {
    "content": "**Creator reply — {{$json.sentiment}}**\nHandle: {{$json.handle}}\n{{$json.replyText}}"
  }
  ```

Keep notify payloads free of PII you would not want in chat history; truncate
long reply bodies if needed.

---

## 5. Status + log updates after classify

1. `PATCH /rest/v1/creators?id=eq.{{creatorId}}`
   Body: `{ "outreach_status": "replied" }`
2. Append classification to `outreach_logs.webhook_events` for the relevant
   `creator_id` (latest log row or matching `provider_message_id`).

Prefer a small Supabase RPC for atomic append if concurrent replies are likely.

---

## 6. Smoke test order

1. `npm test` in this package (parsers).
2. Apply SQL migration; confirm RLS enabled.
3. Activate n8n workflow; configure env vars.
4. Insert a test creator with a real-looking bio + your inbox email.
5. Confirm personalised send (or dry-run HTTP to webhook.site first).
6. Simulate a reply webhook payload with the shared secret; confirm Slack and
   `outreach_status = 'replied'`.

---

## 7. Gmail reply sync (outreach mailbox)

Outbound mail uses `reply_to` `studioowner@gmail.com` (see `RESEND_REPLY_TO`).
The Gmail UI may show `studio.owner@gmail.com`. That is the **same** mailbox:
Gmail ignores dots in the local part. Do not create a second Google account.

The admin can mark a CRM lead replied without Gmail. Automatic matching needs
OAuth on that one mailbox, then a poll:

`POST /api/gmail/sync-replies`

Production: Netlify function `gmail-reply-sync` (the site does not run Express).
Local: the same path on the Express server (`npm run server`). Discovery and
autopilot are unchanged and still need Express.

### Google Cloud steps (a human fills the tokens)

1. Google Cloud Console → create or select a project.
2. Enable the **Gmail API**.
3. OAuth consent screen. Add scope `https://www.googleapis.com/auth/gmail.readonly`.
   If the app stays in testing, add `studioowner@gmail.com` as a test user.
4. Create an OAuth client (Desktop app is the simplest way to mint a refresh token).
5. Sign in as `studioowner@gmail.com` and obtain a refresh token for that scope.
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) works:
   gear icon → *Use your own OAuth credentials* → authorise the readonly scope →
   exchange the code → copy the refresh token.
6. Put the values in root `.env` (local Express) and in the Netlify site
   environment for `solis-outreach` (production function). The admin is
   `https://admin.example.com`. The Express
   service on Railway needs `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` as well,
   because **Connect Gmail** starts OAuth there. Leave them blank in git until
   then — do not commit a made-up token.

   Connect Gmail (Connectors) is the in-product path. Create a **Web application**
   OAuth client and add this authorised redirect URI:

   `https://api.example.com/api/gmail/oauth/callback`

   The callback stores the refresh token in `integration_secrets` (service role
   only). Apply `supabase/migrations/20261005190000_integration_secrets.sql`.
   A `GMAIL_REFRESH_TOKEN` env var still wins if you mint one in the Playground.

| Variable | Purpose |
|----------|---------|
| `GMAIL_CLIENT_ID` | OAuth client id |
| `GMAIL_CLIENT_SECRET` | OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Refresh token for `studioowner@gmail.com` |
| `WEBHOOK_SHARED_SECRET` | Already used for webhooks. Cron calls send it as `x-webhook-secret`. The signed-in admin session also authorises the CRM **Sync replies** button. |

7. Apply `supabase/migrations/20260930120000_gmail_reply_sync.sql` in the SQL
   editor (`blast_sends.replied_at` and `gmail_seen_messages`). Manual mark-as-replied
   does not need this migration. Sync returns a clear error if the table is missing.

### Schedule

There is no automatic schedule until the tokens exist (a failing poll would just
log errors). After the tokens are set, hit the endpoint on a schedule, for example
every 15 minutes:

```bash
curl -X POST https://api.example.com/api/gmail/sync-replies \
  -H "x-webhook-secret: $WEBHOOK_SHARED_SECRET"
```

The handler is idempotent. A message id already stored in `gmail_seen_messages`
is skipped, so a second run does not double-count or flip unrelated leads.
Unknown senders, Google security mail, and our own From address are ignored.
Undo on a lead stays undone until a **new** message arrives from that sender.

If the three `GMAIL_*` variables are empty, the endpoint responds **503** and
logs the missing names. It does not report success.
