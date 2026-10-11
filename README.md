

### Campaign delete semantics

`DELETE /api/campaigns/:id` (service role) removes the campaign row. Postgres FKs:

- `discovery_runs.campaign_id` → **ON DELETE CASCADE** (runs removed)
- `creators.campaign_id` → **ON DELETE SET NULL** (creators kept, unlinked)

Daily Auto-Run maps to `is_autopilot_enabled` + cron `0 10 * * *` (Europe/London). Email body: `data/email-template.md` (or `EMAIL_TEMPLATE` env), editable under **Email Templates**.

## Windows (PowerShell) — go live

```powershell
cd C:\path\to\creator-outreach-engine
npm install
npm run sync:env          # writes APIFY_TOKEN (+ actors) from SETUP-DETAILS.md into .env
npm run dev               # API :3001 + Admin :5173
# Browser: http://localhost:5173 → Campaigns → open campaign → Find & Pitch Creators
# Toggle Daily Auto-Run (10 AM) on the campaign card or detail page
# Discord #alerts gets "Best creators" embeds when emails are found
# Confirm: Invoke-RestMethod http://localhost:3001/api/health | Select apifyConfigured
```

### Pull latest (Windows)

```powershell
cd C:\path\to\creator-outreach-engine
git pull
npm install
npm run sync:env
npm run install:admin
cd admin; npm run build; cd ..
npm run dev
```

TikTok/IG DMs are **not** automated (see `docs/outreach-channels.md`). Email via Resend + Discord is the automated path.

# Solis — Creator Outreach Engine

Set-and-forget creator outreach (**Solis Admin**, Whop-inspired UI):

Drop-in package for an in-house automated creator outreach pipeline:

**Supabase** (creators + logs) → **Express / n8n** → **Groq LLM personalisation** → **cold email** (Resend / Instantly / Smartlead) → **reply classification** → Slack/Discord + status updates.

British English in docs and comments is intentional.

## Self-hosting

Supabase URL, anon key, and service role key stay in the environment. Every other integration can be set later under **Settings → API keys**. Saved keys are stored in `integration_secrets` (service role only). The API reads those first and falls back to environment variables, so an existing env-based deploy keeps working.

### Prerequisites

Node.js 18 or newer, and a Supabase project. Apify, Groq, Resend, and a Google Cloud OAuth client are needed when you actually search and email. Postgres client (`psql`) is needed for `npm run setup:db`.

### 1. Database

Create a Supabase project and copy its database connection string.

```bash
# Paste the URI from Supabase → Project Settings → Database.
export DATABASE_URL='postgresql://db.example.com:5432/postgres'
npm run setup:db
```

The same SQL is in `supabase/migrations`, applied in filename order. `supabase db push` does the same thing if you use the Supabase CLI. On an empty local Postgres (no Supabase roles), add `--with-local-roles`:

```bash
npm run setup:db -- --with-local-roles
```

The migrations create a generic default app. Further apps are added in the admin.

### 2. Environment

```bash
cp .env.example .env
cp admin/.env.example admin/.env
```

Fill `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in `.env`. Fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `admin/.env`. Leave the provider keys blank if you will use Settings.

If the admin starts without those Vite variables it shows a first-run screen instead of login.

### 3. Run locally

```bash
npm install
npm run server          # API http://localhost:3001
npm run dev:admin       # Admin http://localhost:5173
```

`npm run dev` starts both. In Supabase, open Authentication and create an email user, then sign in.

### 4. Keys

Open **Settings → API keys**. Paste each key, Save, then Test. Apify calls `/users/me/limits`, Groq lists models, and Resend lists domains. The page shows `set ••••` plus the last four characters. Replace writes a new value. Clear removes the saved row so the environment variable is used again.

### 5. Gmail

In Google Cloud, create an OAuth client (Web application) with the Gmail readonly scope. Copy the callback URL shown next to the Gmail fields and add it as an authorised redirect URI. Save the client ID and secret, then open **Connectors** and choose Connect Gmail. If the consent screen is in testing, add the mailbox as a test user. Set **Reply-to** and **Gmail mailbox** to that address so replies are recognised as yours.

### 6. Optional deploy

- **Railway** runs the API (`npm start`). Set the three Supabase variables. `PORT` is provided. Set `PUBLIC_API_URL` to the public API origin so the Gmail callback matches.
- **Netlify** builds the admin (`npm run build`, publish `admin/dist`). Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_EXPRESS_API_URL` to the API origin. Functions also need `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ANON_KEY`. Provider keys can live in Settings; the functions read them from there and fall back to their own environment.
- Set `ADMIN_BASE_URL` to the admin origin and add it to `CORS_ORIGINS` if it is not localhost.

### Apify cost

The default search cap is about $1 (`DISCOVERY_RUN_BUDGET_USD`). The TikTok video actor will not start under $0.50. Monthly credit is per Apify account, so a fallback token and extra tokens keep a search going when one account is spent. The admin shows remaining credit. You are billed by Apify for actor runs, and by Resend and Groq for mail and tokens.

## Architecture

```
┌─────────────────┐     DB Webhook      ┌──────────────────────────────┐
│ Supabase        │ ──────────────────► │ n8n / Express                │
│  creators       │                     │  1. Fetch creator            │
│  outreach_logs  │ ◄── service role ── │  2. Build personalisation    │
└─────────────────┘                     │  3. Groq LLM → hook JSON     │
                                        │  4. Merge email template     │
                                        │  5. Send via provider API    │
                                        │  6. Reply webhook → classify │
                                        │     → notify + set replied   │
                                        └──────────────────────────────┘
```

- **`creators`** — TikTok / Instagram profiles, outreach status, AI variables.
- **`outreach_logs`** — sequence steps 1–3, provider IDs, append-only webhook events.
- **TypeScript utilities** — prompt build/parse, template merge, reply labels, provider payloads.
- **n8n Code nodes** — paste-ready CommonJS mirrors of the parsers.


## Live discovery (Apify)

1. From the repo root: `npm run sync:env` — writes `APIFY_TOKEN` (and actors) from `SETUP-DETAILS.md` into root `.env`.
2. Restart the API (`npm run dev` or `npm run server`).
3. `GET /api/health` should show `"apifyConfigured": true`.
4. Admin → Campaign → **Run live discovery** (provider `apify`). Demo discovery is under **Advanced**.
5. New campaigns default to `result_limit: 10` (“find ten creators”).
6. After a run with emails found, Discord receives **🎯 Best creators for {campaign}** plus rich embeds (handle, profile, followers, engagement, top video links/thumbnails).

### Collaboration outreach path

Automated outreach is **email (Resend) + Discord alerts** only.

TikTok and Instagram DMs are **not** automated via any official API in this stack — Meta/TikTok do not offer a sanctioned outreach DM API for this use case. Use Solis email pitches (Groq hook + collab template) and Discord for ops visibility; handle TikTok/IG DMs manually if needed.


## Local run (recommended)

From the repo root (folder may be `creator-outreach-engine` or `marketing-bot`):

```bash
npm install          # also installs admin/ via postinstall
cp .env.example .env # fill keys OR copy from SETUP-DETAILS / .env.local.secrets
npm run sync:env   # writes admin/.env (Supabase + API + Solis branding + Discord)
npm run dev
# API  http://localhost:3001
# Admin http://localhost:5173  — Connected pill green when Vite env set
```

### Windows / PowerShell

```powershell
cd marketing-bot
npm install
cd admin; npm install; cd ..
copy .env.example .env   # fill keys OR use SETUP-DETAILS
npm run sync:env   # required after git pull so admin/.env has VITE_SUPABASE_*
npm run dev
# API http://localhost:3001  Admin http://localhost:5173
# If banner still says Not connected: restart Vite after sync:admin-env
```

If `postinstall` already ran, the separate `admin` install is optional. You can also run API and admin in separate terminals:

```powershell
npm run dev:api      # Express on :3001
npm run dev:admin    # Vite on :5173
```

Or: `npm start` / `npm run server` for the API only.

## Quickstart (full setup)

```bash
# 1. Install & verify
npm install
npm test
npm run test:groq   # live Groq hook (needs GROQ_API_KEY)
npm run typecheck   # optional
npm run build       # emits dist/

# 2. Configure
cp .env.example .env
# fill APP_NAME, APP_VALUE_PROP, Supabase, GROQ_*, RESEND_*, WEBHOOK_SHARED_SECRET

# 3. Migrate Supabase
#    supabase db push
#    — or run supabase/migrations/*.sql in the SQL editor

# 4. Import / rebuild the n8n flow from n8n/workflows/creator-outreach.md
#    Paste n8n/code-nodes/*.js into Code nodes

# 5. Wire webhooks — see docs/webhook-setup.md
```

## Groq LLM setup

Personalisation hooks and reply classification call Groq’s OpenAI-compatible API:

| Variable | Example |
|----------|---------|
| `GROQ_API_KEY` | (from Groq console — never commit) |
| `LLM_MODEL` | `openai/gpt-oss-120b` |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` |

Client: `src/llm/client.ts` → `chatJson({ system?, user, temperature? })`.

Verify without sending email:

```bash
npm run test:groq
# prints a non-empty personalised hook (not the API key)
```

If `GROQ_API_KEY` is missing, outreach falls back to a bio first-line template hook; the health endpoint reports `groqConfigured: false`.

## Resend (from address)

Use the verified Solis Labs domain:

| Variable | Value |
|----------|--------|
| `RESEND_FROM_EMAIL` | `outreach@example.com` |
| `RESEND_API_KEY` | (from Resend dashboard) |
| `RESEND_REPLY_TO` | `studioowner@gmail.com` |

Blasts send as `Alex from Example <outreach@example.com>` with that reply-to. Gmail ignores dots, so `studio.owner@gmail.com` is the same mailbox.

## Reply sync

CRM leads can be marked **Replied** by hand (stored on `creators.outreach_status`). That updates the dashboard REPLIED count and reply rate immediately.

Automatic matching is `POST /api/gmail/sync-replies` (Netlify function in production, Express locally). It reads the outreach mailbox and marks an existing creator or blast recipient only when the sender email matches. It returns an error when `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, or `GMAIL_REFRESH_TOKEN` is missing. See `docs/webhook-setup.md` for the Google Cloud steps. Discovery and autopilot still need the local Express server.

## Package layout

| Path | Role |
|------|------|
| `supabase/migrations/` | `creators` + `outreach_logs`, RLS, `updated_at` trigger |
| `src/llm/client.ts` | Groq / OpenAI-compatible `chatJson` |
| `src/personalization.ts` | `buildPersonalizationPrompt`, `parsePersonalizationResponse`, `mergeHookIntoTemplate` |
| `src/reply-classifier.ts` | `buildReplyClassificationPrompt`, `parseReplyClassification` |
| `src/cold-email.ts` | `buildColdEmailPayload` for resend / instantly / smartlead |
| `src/types.ts` | Shared types |
| `src/index.ts` | Re-exports |
| `n8n/code-nodes/` | Paste-ready Code node scripts |
| `n8n/workflows/creator-outreach.md` | Numbered wiring + JSON skeleton |
| `docs/webhook-setup.md` | Supabase + provider + Slack/Discord checklist |
| `admin/` | Vite React admin UI (dashboard, campaigns, creators, settings) |
| `src/discovery/` | Demo + Apify providers, email extract, `runDiscovery` |
| `src/pipeline/` | `runCampaign` orchestration + Resend / Discord helpers |
| `server/` | Express API + `autopilot.ts` (node-cron, Europe/London) |
| `scripts/sync-admin-env.mjs` | Copies Supabase URL/anon into `admin/.env` |
| `scripts/e2e-demo-campaign.ts` | Creates campaign + demo discovery against Supabase |
| `scripts/test-groq-hook.ts` | Live Groq personalisation smoke test |
| `n8n/docker-compose.yml` | Local n8n on port 5678 |
| `SETUP-DETAILS.md` | Credentials / URLs checklist (private — contains secrets) |

## Key TypeScript API

```ts
buildPersonalizationPrompt(bio, appName, valueProp): string
parsePersonalizationResponse(raw): { hook: string }
mergeHookIntoTemplate(template, hook, vars?): string

chatJson({ system?, user, temperature? }): Promise<{ content, model }>

buildReplyClassificationPrompt(replyText): string
parseReplyClassification(raw): 'Interested' | 'Not Interested' | 'Price Question' | 'Unsubscribe'

buildColdEmailPayload({
  provider: 'resend' | 'instantly' | 'smartlead',
  to, from?, subject, htmlOrText,
  sequenceTags?, creatorId, sequenceStep: 1 | 2 | 3,
}): Record<string, unknown>
```

`APP_NAME` and `APP_VALUE_PROP` are read from the environment and passed into the TS helpers.

## Security notes

- RLS is enabled on creators / outreach_logs / campaigns / discovery_runs.
- After login the browser sends an **authenticated** JWT. Apply
  `supabase/migrations/20260919213000_authenticated_rls_and_dev.sql` so
  `authenticated` has the same SELECT/INSERT/UPDATE access as `anon`
  (otherwise list/insert returns 403). Optional commented `DISABLE RLS` is
  for local-only debugging — do not run in production.
- **Preferred create path:** Admin → `POST /api/campaigns` on Express uses
  `SUPABASE_SERVICE_ROLE_KEY` and bypasses RLS. List/fetch can stay on the
  Supabase anon client once authenticated policies are applied.
- **Secrets**: never commit `.env`, `admin/.env` or any `*.secrets` file. They are gitignored; use `.env.example` as the template and add API keys in Settings.
- Still prefer `.env.example` placeholders in public forks.
- Do not print secrets in logs (`GROQ_API_KEY`, Resend, Supabase, etc.).
- Verify `WEBHOOK_SHARED_SECRET` on every public webhook.

## Scripts

| Script | Command |
|--------|---------|
| Dev (API + admin) | `npm run dev` |
| API only | `npm run server` / `npm start` / `npm run dev:api` |
| Admin only | `npm run dev:admin` |
| Test | `npm test` |
| Groq live hook | `npm run test:groq` |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| E2E demo campaign | `npm run e2e:demo` |
| Sync admin/.env | `npm run sync:env` |

## Campaign pipeline

Preferred **v1** path: the Express API discovers creators and sends outreach with the existing TypeScript helpers. n8n remains an optional secondary orchestrator.

```
Admin UI (Campaigns → New)
        │  POST /api/campaigns  (service role; bypasses RLS after login JWT)
        ▼
campaigns row (draft)
        │
        ▼
POST /api/campaigns/:id/run  { provider: "apify" | "demo" (default apify) }
        │
        ├─ runDiscovery → CreatorCandidate[]
        ├─ upsert creators (campaign_id, niches in ai_variables, email from bio)
        ├─ log discovery_runs
        ├─ if auto_outreach + email → queue → personalise (Groq or bio template) → Resend
        ├─ if auto_outreach off → outreach_status = pending_review (CRM approval queue)
        └─ Discord: "🎯 Found {n} creators for campaign {name}. {x} ready for auto-outreach / pending review."
```

### Providers

| Provider | Behaviour |
|----------|-----------|
| `demo` | Deterministic fake creators matching niche / platform / follower filters (offline E2E) |
| `apify` | Runs `APIFY_TIKTOK_ACTOR` / `APIFY_INSTAGRAM_ACTOR` when `APIFY_TOKEN` is set |

### How to run

```bash
# Apply migrations in the Supabase SQL editor (in order):
#   20260919183100_create_creators_and_outreach_logs.sql
#   20260919184000_admin_anon_policies.sql
#   20260919191000_campaigns_and_discovery.sql
#   20260919193000_creator_crm_apify_fields.sql
#   20260919210000_campaign_autopilot.sql
#   20260919213000_authenticated_rls_and_dev.sql  # authenticated = anon (fixes 403 after login)

npm run sync:env
npm run dev
# or split:
#   npm run server
#   cd admin && npm run dev

# Headless E2E (creates campaign + demo discovery, auto_outreach off — no email blast)
npm run e2e:demo
```

Admin → **Campaigns** → open a campaign → **Run live discovery** (demo under Advanced).

Creators land in **Influencer CRM** (`/creators`) as a card grid: approve & pitch, edit AI hook, archive, top-videos drawer.

### Optional n8n

```bash
cd n8n && docker compose up -d   # http://localhost:5678
```

Webhook paths (see `n8n/workflows/creator-outreach.md`):

- `POST /webhook/creator-inserted` — personalise + Resend + log + set sent
- `POST /webhook/email-reply` — classify → Discord + replied

Express mirrors the reply path at `POST /api/webhooks/email-reply` (Groq classification + heuristic fallback).

## Express campaign create API

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/api/campaigns` | Body matches admin `CampaignFormData`. Service role insert. Auto-fills `app_name` / `value_prop` from `APP_NAME` / `APP_VALUE_PROP` (Solis defaults if omitted). Returns created campaign JSON (`201`) or `{ "error": "…" }`. |
| `PATCH` | `/api/campaigns/:id` | Autopilot / status fields |
| `POST` | `/api/campaigns/:id/run` | Discovery (`demo` \| `apify`) |
| `POST` | `/api/campaigns/:id/autopilot/run` | Manual autopilot tick |

New Campaign UI fields: **Name**, **Niches**, **Platform** (TikTok/IG), **Follower min/max**, **Daily Autopilot**. Branding (`VITE_APP_NAME` / `VITE_APP_VALUE_PROP`) and `result_limit: 10` are attached silently on submit.

## Autopilot (set-and-forget)

1. Apply `supabase/migrations/20260919210000_campaign_autopilot.sql`.
2. Toggle **Daily Autopilot (10 AM)** on a campaign card (or on New campaign).
3. Server ticks every minute (`Europe/London`); when `schedule_cron` matches (default `0 10 * * *`), runs Apify (demo fallback), filters email + engagement min, forces Groq hooks + Resend, Discord `🚀 [Autopilot Executed]…`.
4. Manual: `POST /api/campaigns/:id/autopilot/run`. Patch: `PATCH /api/campaigns/:id` `{ "is_autopilot_enabled": true }`.

After clone / pull: `npm run sync:env` then restart `npm run dev` so the Connect banner stays hidden and the pill shows **Connected**. Sign in at `http://localhost:5173/login` (Supabase Auth — see SETUP-DETAILS).

## Visual Influencer CRM

- Card grid with avatar, handle, platform badge, followers, engagement %
- **Approve & pitch now** → `POST /api/creators/:id/approve`
- **Edit AI hook** → `PATCH /api/creators/:id` `{ "hook": "…" }`
- **Skip / archive** → status `archived`
- Filter tabs: All | Pending review | Queued | Sent | Replied | Archived

## Admin UI (Solis / Whop aesthetic)

```bash
npm run sync:env   # from repo root — preferred
cd admin && npm run dev  # http://localhost:5173
```

Branding: **Solis Admin**. Design tokens: bg `#0B0E14`, cards `#12161F`, flat near-black surfaces, soft borders, muted accent (Whop-like). 1-click presets + Daily Autopilot toggles on Campaigns. Vite `VITE_SUPABASE_*` always wins over localStorage — banner hidden when env is set. See `admin/README.md` and `SETUP-DETAILS.md`.


## Custom Audiences & Direct Blast

1. Apply migration `supabase/migrations/20260929140000_audience_groups_and_direct_blast.sql` in the Supabase SQL editor.
2. Admin → **Audiences** — create e.g. “Current Astra Users”, paste emails or upload CSV (`email,display_name`).
3. **Campaigns → New** → type **Direct Blast** — pick audience, subject, body. Tokens: `{{display_name}}` (→ `there` if missing), `{{app_name}}`, `{{hook}}` optional blank.
4. On the campaign page: **Send Test Email** / **Launch Blast** (500ms delay between Resend sends; tracked in `blast_sends`).

| Method | Path | Notes |
|--------|------|-------|
| CRUD | `/api/audiences`, `/api/audiences/:id/members` | Service role |
| `POST` | `/api/campaigns` | `campaign_type: "direct_blast"` + `audience_group_id` + `email_subject` + `email_body` |
| `POST` | `/api/blasts/:campaignId/test` | `{ "to": "email" }` |
| `POST` | `/api/blasts/:campaignId/send` | Queue all members |
| `GET` | `/api/analytics` | Includes `blastSent` / `blastFailed` / `blastOpened` |

## Netlify (admin SPA)

`npm run build` compiles TypeScript and builds the Vite admin into `admin/dist`.

- `netlify.toml` publishes `admin/dist` with SPA redirects.
- Express API is **not** on Netlify — set `VITE_API_BASE_URL` (or `VITE_EXPRESS_API_URL`) at build time to your hosted API.
- Deploy: set `NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID` (see `.env.example`), then `npm run deploy:netlify` (`netlify-cli deploy --prod`).
- Do **not** invent Netlify credentials — use `netlify login` / dashboard tokens from the parent.

## Railway (Express API)

Railway must not run the Netlify build. `npm run build` typechecks the Vite admin, and the API image does not install `admin/node_modules`.

Service settings (these match `railway.json`):

- Build command: `npm run build:api` (root `tsc` only)
- Start command: `npm run start` (`tsx server/index.ts`)
- Healthcheck path: `/health`

The process listens on `0.0.0.0` and `PORT`. Leave the full `npm run build` for Netlify.

