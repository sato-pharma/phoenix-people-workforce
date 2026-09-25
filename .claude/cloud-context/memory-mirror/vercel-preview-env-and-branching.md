---
name: vercel-preview-env-and-branching
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — Preview deploys now HAVE Supabase env (fixed as of 2026-07-04, was previously missing); use the deployment URL not the branch alias to avoid CSRF block."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 523c8a19-3fef-4693-a603-09464f57f357
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

Vercel deployment facts for the phoenix-workforce project (team `phoenix-hr-workspace-s-projects`):

- **UPDATE 2026-07-04: Preview deployments now DO have the core runtime env** — confirmed via `vercel env ls`: `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` all show scoped to Preview (broadly, not one branch). This was previously missing (see below, now stale) — someone fixed it since. A PR's preview deployment should be usable for real login/testing now; verify live if login still fails, don't assume the old gap still applies.
- (Historical, now fixed) Previously: Preview deployments lacked the runtime env vars entirely, so `POST /api/auth/login` returned 500 and login was impossible on a branch preview URL.
- The Vercel MCP tools available can read projects/deployments/logs and trigger deploys, but **cannot set environment variables** — that needs the Vercel dashboard.
- **Branching reality (supersedes CLAUDE.md):** `codex/work-from-production` has been **merged and deleted**. There is no standing "working preview" branch. Work now flows **directly to `main` via PRs** (e.g. PR #16/#18 merged to main). Don't assume the codex branch exists.
- A local dev preview can be made to log in by putting just `PHOENIX_AUTH_SECRET` in a gitignored `.env.local` and using `GET /api/dev-auth?role=...` — but Supabase data stays empty without those keys, so KPIs/feeds show zeros.
- **CSRF-origin gotcha (2026-06-16):** signing in on a Vercel **branch-alias** preview URL (e.g. `phoenix-workforce-git-co-XXXX-...vercel.app`) is rejected with **"Cross-site mutation request blocked." (403, `csrf_blocked`)** from `proxy.ts`. The app's same-origin CSRF check (`src/lib/security/csrf.ts` + `origins.ts` `allowedPhoenixOrigins()`) only trusts: productionUrl, a few hardcoded aliases, `process.env.VERCEL_URL` (= the **deployment-specific** URL like `phoenix-workforce-<hash>-...vercel.app`, NOT the branch alias), and `PHOENIX_ALLOWED_ORIGINS`. So to log in on a preview, browse the **deployment URL** (the `url` field from the Vercel deployment, which equals VERCEL_URL), not the branch alias — or just test on production. This is independent of the read-only-GET vs mutation distinction; only POST/PUT/PATCH/DELETE hit the guard. NOTE: current project id is `prj_e1kBhJwJ3OVFkNC5w4muy7WVK6ft` / team `team_MF9h6hXmL5sA5i1m1iAs8ueb` (the id at the top of this file is stale).
