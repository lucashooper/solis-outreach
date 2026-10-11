# Solis Admin

Whop-inspired dark UI for Solis creator outreach (dashboard, campaigns + autopilot, influencer CRM, settings).

Vite + React + TypeScript + Tailwind. Talks to Supabase with the **anon** key from **Vite env first** (preferred) or Settings → localStorage.

## Quick start

From the **repo root** (recommended):

```bash
npm run sync:admin-env   # copies Project URL + Anon key from SETUP-DETAILS.md → admin/.env
npm run dev              # API :3001 + Admin :5173
```

Or admin only:

```bash
cd admin
npm install
npm run dev
```

Open http://localhost:5173 — status pill should show **Connected** and the Connect banner should be **hidden** when `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are in `.env`.

Production build:

```bash
npm run build
npm run preview
```

## Configuration

**Preferred:** root `npm run sync:admin-env`, or copy `.env.example` → `.env`:

```
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_EXPRESS_API_URL=http://localhost:3001
VITE_API_BASE_URL=http://localhost:3001
VITE_APP_NAME=Solis
VITE_APP_VALUE_PROP=helps creators and brands work together through Solis Labs
VITE_DISCORD_WEBHOOK_URL=
```

`loadSettings()` **always prefers Vite env** for Supabase, API base, branding, and Discord over localStorage. Settings fields from env are read-only.

## Login

Routes (except `/login`) require a Supabase Auth session (`signInWithPassword`). Create the user in Supabase Auth (email confirmed). Login: http://localhost:5173/login — header shows email + Sign out.

Branding default: **Solis**.

## Autopilot

Campaign cards expose **Daily Autopilot (10 AM)**. Requires migration `20260919210000_campaign_autopilot.sql` and the Express server running (master cron in `server/autopilot.ts`).

## Screens

| Route | Purpose |
|-------|---------|
| `/login` | Supabase Auth sign-in |
| `/` | Dashboard counts |
| `/campaigns` | List + 1-click presets + autopilot toggles |
| `/campaigns/new` | Niche/platform pills, follower/engagement sliders, autopilot |
| `/creators` | Visual CRM card grid |
| `/settings` | Supabase, Discord, branding |

## Security note

Do not expose the **service role** key in this frontend.
