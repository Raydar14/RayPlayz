# rayplayz-dashboard (Cloudflare Worker)

Serves the RayPlayz public site (`/`) and the owner-only private dashboard (`/dashboard`).

## Layout

```
worker/
  public/                    static assets, served as-is
    index.html               public marketing site (mirror of ../rayplayz-site/index.html)
    rayplayz-favicon.png
    dashboard/
      index.html             login + authed shell (single file, vanilla JS)
  src/
    worker.js                request entrypoint & routing
    auth.js                  HMAC-signed session cookie, constant-time password check
    api.js                   /api/* handlers (login, logout, me — data endpoints land in Phase 2)
  wrangler.jsonc             Cloudflare config
  package.json               scripts + wrangler dep
```

## Secrets (set in Cloudflare dashboard, never in git)

| Name                 | What it is                                            |
|----------------------|-------------------------------------------------------|
| `DASHBOARD_PASSWORD` | Ray's single login password. Long. Strong.            |
| `SESSION_SECRET`     | Random string used to sign session cookies. 40+ chars.|
| `ANTHROPIC_API_KEY`  | For AI reply drafting in Phase 4. Set now, use later. |

## Local dev (optional, for future contributors)

```
cd worker
npm install
cp .dev.vars.example .dev.vars   # create this file, add the three secrets
npm run dev
```

## Deploy

Two paths — choose one, don't mix them.

**A. Cloudflare's Git integration (recommended)** — see `../DEPLOY.md` at the repo root. Cloudflare watches the branch and auto-deploys on push.

**B. Manual (CLI)** — from `worker/`:
```
npm install
npx wrangler login
npx wrangler deploy
```

## What's here now vs. what's coming

- **Phase 1 (done):** public site preserved, `/dashboard` gated by password, session cookies, deploy pipeline.
- **Phase 2:** D1 schema, contact/thread/message endpoints, manual-entry inbox UI.
- **Phase 3:** MV3 browser extension (IG → Fetlife → X → TikTok → Bumble → Tinder).
- **Phase 4:** Reply drafting (Anthropic API), scoring rubric, red-flag detection, hard-rule gate.
- **Phase 5:** Screenshot vault (R2), digest, response-time analytics, PDF export.
