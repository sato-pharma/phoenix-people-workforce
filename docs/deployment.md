# Deployment

## Infrastructure

Phoenix Workforce is deployed on **Railway** with a Supabase PostgreSQL backend. Hosting moved
here from GCP Cloud Run on **2026-08-01**, when the GCP billing account was closed. Vercel is
legacy/decommissioned and predates both (see `docs/disaster-recovery-runbook.md` § Vercel
retirement).

| Component | Service | Notes |
|---|---|---|
| Application hosting (production) | **Railway** | Project `Phoenix-HR-Workforce`, service `phoenix-people-workforce`, region `sfo` (US West) |
| Application hosting (staging) | **none** | The staging *app* died with Cloud Run and has no Railway replacement |
| Database + Auth | Supabase | Separate production (`ozucdzovmcqvepbozvqf`) and staging (`cifwmndunmlxjhyjugxa`) projects |
| Scheduled jobs | **cron-job.org** (third-party, outside this repo) | See "Cron Jobs" below |
| Email delivery | Resend | — |
| Error monitoring | Self-hosted (`app_error_events` + Railway logs) | See [observability.md](observability.md) |
| Attendance agent | Local Windows machine | — |

Railway is **GitHub-connected**: it deploys from this repo on push to the default branch. There is
no deploy workflow in `.github/workflows/` that ships production any more.

**GCP is dead, not standby.** Billing account `01BDEA-A20B4C-CC568F` was closed 2026-08-01 over an
unpaid balance; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`.
`deploy-cloud-run.yml` and `deploy-cloud-run-staging.yml` are still in the repo but their schedule
triggers were removed — both are `workflow_dispatch:` only, so they never fire on their own. A
`deploy: skipped` from either is expected, not informative. Do not run `gcloud` to verify anything.

## Branch Model

| Branch | Purpose | Deployment |
|---|---|---|
| `main` | Production only | **Ships to production immediately on merge**, at full traffic |
| feature/task branch | Active development | No live deployment — verified via CI and local testing |

Never push directly to `main`. Work happens on a branch/PR and merges after CI passes.

## Deployment Workflow

1. Develop on a branch/worktree, open a PR to `main`.
2. `.github/workflows/ci.yml` runs on the PR: `validate` (routes/migrations/sql-backups/deductions/
   stale-domain checks, test, build), `lint`, `typecheck`, and `preview-smoke` (a Playwright login
   smoke test run against the built app **inside the CI runner**, pointed at the staging Supabase
   project — despite the job name, this does not deploy or hit any live preview URL).
3. Run `pnpm run check:harden` locally once before you push — see AGENTS.md § 7.
4. **Apply any database migration by hand BEFORE the merge.** The Railway deploy applies none. See
   "Database Deployment" below.
5. Merge to `main`. **The merge is the deploy.** Railway builds and ships the new commit to
   production at **full traffic**, within minutes. There is no staged rollout, no no-traffic
   revision, no post-deploy smoke test, and no cron wait — nothing stands between the merge and
   employees using it.

> ⚠️ Branch protection does gate the merge itself: 5 required status checks (`validate`, `lint`,
> `typecheck`, `secret-scan`, `sast-scan`) must be green on the PR head commit, with
> `enforce_admins: true`. So a merged commit has passed CI. But CI passing is the *only* gate —
> once merged, it serves live traffic. **Never merge anything you are not willing to have serving
> employees within minutes.**

The old Cloud Run pipeline did deploy a no-traffic revision, smoke-test it, and only then promote
it to 100%. That safety net is **gone**. Any doc, comment, or memory describing it is pre-cutover.

## Production Verification

The public production domain is https://phoenix-hr.satopharma.com (also reachable at
`https://phoenix-people-workforce-production.up.railway.app`). Cloudflare holds
`CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied.

**To confirm what is actually live, ask the app — not the workflow list:**

```bash
curl -s https://phoenix-hr.satopharma.com/api/healthz
```

`revision` is the running commit SHA. Verified 2026-08-04: it returned
`cec8abca3547807ee728fd16ed6b380b2372bba5`, matching `origin/main` at the time.

To confirm a deploy happened at all, use the GitHub deployments API or the Railway CLI — rows read
`Phoenix-HR-Workforce / production … "Deployed to Railway"`:

```bash
gh api repos/Gawish-1997/phoenix-people-workforce/deployments
```

There is **no staging app** to check. Only the staging *database* survives.

## Database Deployment

🔴 **The Railway deploy applies no migrations.** Apply them by hand *before* the merge, or the newly
deployed code will select a column that does not exist. This is the single most common way a green
merge produces a broken production page.

See docs/migrations.md for the migration policy — there is no scripted production-migration approval
pipeline (the prior phase28-36 scripts were retired 2026-07-11); applies go through the Supabase
MCP/CLI directly with explicit approval, and a daily CI job
(`.github/workflows/migration-drift-check.yml`) catches anything merged but never actually applied.

## Cron Jobs (cron-job.org)

🔴 **The production scheduler is a free-tier third-party account at cron-job.org, outside this
repo.** Its schedule lives only in that account — no config-as-code, no Railway variable, nothing in
git. Nobody can see or change the schedule from this repository. Treat it as a single point of
failure. (Verified live 2026-08-02 from Railway HTTP logs: its `/api/cron/*` requests return 200.)

Two other schedulers still point at production and neither works:

- **Google Cloud Scheduler** — the 8 jobs still fire but **401 on every route** (secret mismatch).
  A red herring, not evidence of an outage.
- **Railway `phoenix-cron`** — never reached the app; disabled.

`scripts/setup-gcp-cron.sh` is **not** the schedule source of truth any more, and
`src/lib/cron-control/*` (the `/admin/cron-control` dashboard) is a UI over the dead GCP scheduler
and is inert.

Job inventory as of 2026-08-02 — **confirm against the cron-job.org account before relying on it**:

| Job | Schedule (Cairo) | Endpoint | Purpose |
|---|---|---|---|
| `phoenix-notify-daily` | 6:36 AM daily | `/api/notifications/daily` | Birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment, resignation SLA, weekly-plan drift, Telegram HR digest |
| `phoenix-process-notifications` | every 5 min | `/api/notifications/process?limit=50` | Drains the notification outbox, probation reminders, deferred/Telegram retries |
| `phoenix-background-jobs` | Fridays 3:00 AM | `/api/cron/background-jobs?limit=10` | Drains queued admin-requested exports, Super-Admin Telegram recap |
| `phoenix-ireports360-sync` | 9:07 / 12:07 / 19:07 daily | `/api/cron/ireports360-visits-sync` | Rolling 10-day iReports360 CRM visit sync + probation double-visit auto-tick |
| `phoenix-ireports360-reconcile` | Sundays 7:25 AM | `/api/cron/ireports360-visits-reconcile` | Wide reconciliation over a rotating slice of a 120-day window |
| `phoenix-reconcile-visits` | Sundays 4:24 AM | same as above | **Disabled** duplicate at the old GCP time — kept so 4:24 can be restored |

🔴 **cron-job.org caps request timeout at 30 s and refuses a higher value.** A route that runs
longer is logged `Failed (timeout)` even though the request *was* delivered and the server finishes
the work (routes carry `maxDuration = 300`, and `withDeadMansSwitch` pings at the end, so
Healthchecks.io still sees success). `phoenix-notify-daily` logs a 30 s timeout every morning and is
**not** failing. Never diagnose a cron from the cron-job.org status alone — check
`ireports360_visits_sync_runs` or the outbox instead.

iReports360 freshness no longer depends on cron at all: PR #1631 added a continuous in-process
poller (`src/lib/crm/live-poller.ts`, started from `instrumentation.ts`, gated on
`PHOENIX_LIVE_CRM_POLL=true`, which is set on the service). The rolling 3×/day sync and weekly
reconcile are still needed — the poller's horizon is 2 days.

## Environment Variables

Production environment variables live on the Railway service `phoenix-people-workforce` (use the
Railway CLI, not the web UI). See docs/environment.md for the full list and
`.env.github-secrets.example` for variables needed in GitHub Actions.

## Staging Environment

The staging **application** is gone — it died with Cloud Run on 2026-08-01 and has no Railway
replacement. Any rule requiring "verify against staging" currently has nothing to run against; say
so plainly rather than pretending the gate exists.

The staging **database** survives as its own isolated Supabase project (`cifwmndunmlxjhyjugxa`),
with no shared third-party secrets with production. CI's `preview-smoke` job points at it so the
login smoke test writes its expected session-rejection noise there instead of production
`audit_logs`.

`PHOENIX_PREVIEW_READ_ONLY` / the `proxy.ts` preview-read-only guard are legacy from the Vercel
preview model and are inert (nothing sets `APP_ENV=preview`).

## Rollback

There is no traffic-splitting rollback any more. To roll back, **revert the commit on `main`** —
the revert merge is itself a deploy and ships the previous code the same way. Confirm with
`/api/healthz` that `revision` moved to the reverted SHA.

Railway also keeps prior deployments and can redeploy the last-good one from the **dashboard**
(project `Phoenix-HR-Workforce` → service `phoenix-people-workforce` → **Deployments** → **Redeploy**) —
faster than a rebuild when the last good commit is known. The **CLI cannot** redeploy an arbitrary
older deployment (`railway redeploy` only redeploys the *latest*); see
docs/disaster-recovery-runbook.md § 2. If the cutover itself ever needs reversing, the
pre-cutover Cloudflare record was `A 8.232.10.208` (Cloud Run) — but note GCP deletes a closed
project's resources roughly 30 days after closure, so that target may no longer exist.

See docs/disaster-recovery-runbook.md for the full incident-response procedure. For database
rollbacks, see docs/migrations.md.
