# Deployment

## Infrastructure

Phoenix Workforce is deployed on **Railway** with a Supabase PostgreSQL backend. Hosting moved
here from GCP Cloud Run on **2026-08-01**, when the GCP billing account was closed. Vercel is
legacy/decommissioned and predates both (see `docs/disaster-recovery-runbook.md` § Vercel
retirement).

| Component | Service | Notes |
|---|---|---|
| Application hosting (production) | **Railway** | Project `Phoenix-HR-Workforce`, service `phoenix-people-workforce`, region `europe-west4-drams3a` (Amsterdam, EU West) — colocated with the Frankfurt Supabase project on purpose; **must stay in Europe** if re-platformed |
| Application hosting (staging) | **Railway** | Same project and service, environment `staging` — `https://phoenix-people-workforce-staging.up.railway.app`, also `europe-west4-drams3a`. Tracks `main` and uses the staging Supabase project; see "Staging Environment" below |
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
2. `.github/workflows/ci.yml` runs on the PR — exactly three jobs: `validate`
   (routes/migrations/sql-backups/deductions/stale-domain checks, test, build, and a Playwright
   login smoke test run against the built app **inside the CI runner**, pointed at the staging
   Supabase project — it does not deploy or hit any live preview URL), `lint`, and `typecheck`.
   The smoke test used to be a fourth `preview-smoke` job; it now runs as a step inside `validate`,
   so there is no separate job to wait on.
3. Do **not** run a local full validation before pushing — those PR checks are the gate, and they
   are the same steps. See AGENTS.md § 7.
4. **Apply any database migration by hand BEFORE the merge.** The Railway deploy applies none. See
   "Database Deployment" below.
5. Merge to `main`. **The merge is the deploy.** Railway builds and ships the new commit to
   production at **full traffic**, within minutes. There is no staged rollout, no no-traffic
   revision, no post-deploy smoke test, and no cron wait — nothing stands between the merge and
   employees using it.

> ⚠️ Branch protection does gate the merge itself: 4 required status checks (`validate`, `lint`,
> `typecheck`, `secret-scan`) must be green on the PR head commit, with
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

The staging environment has its own deployment and its own `/api/healthz`
(`https://phoenix-people-workforce-staging.up.railway.app/api/healthz`). Because it also tracks
`main`, its `revision` normally matches production's — seeing the same SHA on both is expected,
not evidence that you checked production. Read the production domain when you mean production.

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

**Full job inventory. Re-read live 2026-08-29 — 20 jobs, 15 enabled;** the table below lists the
long-standing ones and not every job in the account. This is a
snapshot of a place nobody can see from git, so re-read it rather than trusting the age of this
table. Times are Cairo, as the account is set to `Africa/Cairo` throughout.

| Job | Schedule (Cairo) | Endpoint | Purpose |
|---|---|---|---|
| `phoenix-notify-daily` | 6:36 AM daily | `/api/notifications/daily` | Birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment, resignation SLA, weekly-plan drift, Telegram HR digest |
| `phoenix-marketing-field-capture-nudge` | 6:50 AM daily | `/api/cron/marketing-field-capture-nudge` | Tells each rep which of their marketing customers still show a validated status with no field capture behind them (**new 2026-08-29** — split off `phoenix-notify-daily`, which it had pushed past the 30 s cap) |
| `phoenix-marketing-invoice-overdue-nudge` | 7:05 AM daily | `/api/cron/marketing-invoice-overdue-nudge` | Tells the requester, and finance, that an approved marketing request's invoice has passed its deadline (**new 2026-08-29**, owner: "the requester and finance"). In-app/Telegram/push only, never email. cron-job.org job `8350529`, created 2026-08-29 |
| `phoenix-process-notifications` | every 5 min | `/api/notifications/process?limit=50` | Drains the notification outbox, probation reminders, deferred/Telegram retries |
| `phoenix-inbound-intake` | every 2 min | `/api/cron/inbound-intake` | Inbound mail/message intake |
| `phoenix-recruitment-email-intake` | every 10 min, at :04 | `/api/cron/recruitment-email-intake` | Pulls CVs out of the recruitment mailbox |
| `phoenix-synthetic-journeys` | hourly, on the hour | `/api/cron/run-synthetic-journeys` | Asks GitHub to run `synthetic-journeys.yml` (the route does not do the work itself) |
| `phoenix-db-health-snapshot` | 0:17 / 6:17 / 12:17 / 18:17 daily | `/api/cron/db-health-snapshot` | Database health snapshot — watched by the `phoenix-db-health-snapshot` check since 2026-08-24; it deliberately opted out of the dead-man's-switch before that |
| `phoenix-background-jobs` | Fridays 3:00 AM | `/api/cron/background-jobs?limit=10` | Drains queued admin-requested exports, Super-Admin Telegram recap |
| `phoenix-direct-orders-rotate-sheet-token` | Fridays 3:23 AM | `/api/cron/direct-orders-rotate-sheet-token` | Rotates the Direct Orders live-sheet feed token (**new 2026-08-23** — nothing called this route before) |
| `phoenix-marketing-requests-rotate-sheet-token` | Fridays 3:43 AM | `/api/cron/marketing-requests-rotate-sheet-token` | Rotates the Marketing Requests live-sheet feed token (**new 2026-08-23**, same story) |
| `phoenix-brevo-keepalive` | 4:09 AM on the 1st | `/api/cron/brevo-keepalive` | Resets Brevo's 90-day inactivity expiry on the email **failover** key, and health-checks it (**new 2026-08-23** — nothing called this route before either) |
| `phoenix-direct-orders-expire-held` | 2:17 AM daily | `/api/cron/direct-orders-expire-held` | Direct Orders hold-expiry sweep (**new 2026-08-23**, replaces the GitHub Actions schedule that 401'd nightly from 2026-08-14) |
| `phoenix-direct-orders-probation` | 2:27 AM daily | `/api/cron/direct-orders-probation` | Direct Orders probation sweep (same replacement) |

**Five jobs are DISABLED, and four of them are disabled on purpose** — do not "fix" them by
switching them back on:

| Disabled job | Schedule it had | Why it is off |
|---|---|---|
| `phoenix-ireports360-sync` | 9:07 / 12:07 / 19:07 daily | Superseded by the in-process poller, which runs the same rolling 10-day sync itself and pings the same `phoenix-ireports360-sync` check |
| `phoenix-ireports360-reconcile` | Sundays 7:25 AM | Superseded the same way by the poller's weekly wide reconcile |
| `phoenix-reconcile-visits` | Sundays 4:24 AM | Older duplicate of the same reconcile endpoint, off long before the poller |
| `phoenix-ireports360-live-sync` | :01/:16/:31/:46, 8 AM–12 PM | Superseded by the poller's 20–30 s ticks. ⚠️ Its route is still wired to the `phoenix-ireports360-live-sync` dead-man's-switch and **nothing else pings that slug**, so that check has been red since 2026-08-16 for no real reason — delete the check (see [observability.md](observability.md)) |
| `phoenix-inbound-intake (Copy)` | every 2 min | An accidental duplicate of the live intake job. Harmless while off; **never enable it** — it would double every intake run |

All four iReports360 jobs being off is expected and is **not** an outage: PR #1631 moved that work
into a continuous in-process poller (`src/lib/crm/live-poller.ts`, started from `instrumentation.ts`,
gated on `PHOENIX_LIVE_CRM_POLL=true`, which is set on the service). It probes a 2-day window every
20 s in the 08:00–12:30 Cairo compliance window, 30 s daytime and 120 s overnight, and runs the
rolling 10-day sync (every 3 h from 06:00) and the weekly wide reconcile (Sundays from 04:00) from
the same loop. Their last external firings were all 2026-08-16; CRM freshness has not depended on
cron since.

🔴 **cron-job.org caps request timeout at 30 s and refuses a higher value.** A route that runs
longer is logged `Failed (timeout)` even though the request *was* delivered and the server finishes
the work (routes carry `maxDuration = 300`, and `withDeadMansSwitch` pings at the end, so
Healthchecks.io still sees success). `phoenix-notify-daily` logs a 30 s timeout every morning and is
**not** failing. Never diagnose a cron from the cron-job.org status alone — check
`ireports360_visits_sync_runs` or the outbox instead.

**Why `phoenix-notify-daily` crossed that cap, and what was done about it (2026-08-29).** It had
been a 5-9 second job all month. The marketing field-capture nudge joined the bundle in #2360 at
24 Aug 00:23 Cairo; the 06:36 run that same morning took 28.8 s, and by 29 Aug it was 34.1 s —
two consecutive red mornings. Those failures were false: Healthchecks recorded `success` on all
36 pings from 26 July to 29 August, and the daily route pings **last**, after every sub-job
resolves. The cost was never a missed notification; it was the alarm, because a permanently red
job is one nobody reads — which is exactly how the outbox drain hid for 13 days behind a green
HTTP 200. The nudge now has its own route and its own clock
(`/api/cron/marketing-field-capture-nudge`), putting the daily run back under the cap. **Prefer
this to tolerating the red:** "the status lies" is true, and still a worse place to be than a job
whose red means something.

## Environment Variables

Production environment variables live on the Railway service `phoenix-people-workforce` (use the
Railway CLI, not the web UI). See docs/environment.md for the full list and
`.env.github-secrets.example` for variables needed in GitHub Actions.

## Staging Environment

There **is** a staging application, and it is running. It is a second Railway environment in the
same project, not a separate service — verified live 2026-08-23:

| Property | Value |
|---|---|
| Railway project | `Phoenix-HR-Workforce` (`dc218ad3-99b7-4aff-be38-953a57524a71`) |
| Environment | `staging` (`c766d42b-9e0b-4027-b00f-b13a1651b214`) |
| Service | `phoenix-people-workforce` — the **same** service as production, a different environment of it |
| URL | `https://phoenix-people-workforce-staging.up.railway.app` |
| Region / replicas | `europe-west4-drams3a`, 1 replica — same as production |
| Build | `DOCKERFILE` (`/Dockerfile`), so `NODE_ENV=production` — same as production |
| Source branch | **`main`** |
| Database | staging Supabase `cifwmndunmlxjhyjugxa` (`Phoenix-HR-Staging`) — **not** production |

Every Supabase credential in the environment resolves to the staging project, not just the URL:
`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_PROJECT_ID`, and the `ref` claim inside
both the anon and the service-role JWTs all read `cifwmndunmlxjhyjugxa`. Writes made through the app
on staging land in the staging database.

```bash
railway status --environment staging --json
```

🔴 **Staging tracks `main`, exactly like production — so by default it is not a preview of your
branch.** Both environments deploy the same commit; at the time of writing `/api/healthz` returned
revision `4ebbf45c` on *both* the production domain and the staging domain. What staging gives you
by default is the shipped code running against a throwaway database, not your unmerged work.

### What staging can verify

- **That the code runs.** Same Dockerfile, same region, same `NODE_ENV=production` build, so a page
  that renders here renders in production.
- **A migration, before it touches payroll data.** Apply it to `cifwmndunmlxjhyjugxa` first and load
  the pages that read the changed columns — this is the one rehearsal that catches "the deploy
  applies no migrations" (§ Database Deployment) before real employees see a 500.
- **Role gates — but only through real logins.** Sign in as a staging user with the role you want to
  test. The dev-auth header shortcut is **not** available here (see the next list).
- **A risky change, before the merge that ships it** — but only if you deliberately point the
  environment's source at your branch first, and put it back on `main` afterwards.

### What staging cannot verify

- **Your branch, without a deliberate repoint.** Its source is `main`. Pushing a branch does nothing
  here; there is still no per-branch preview deployment anywhere.
- **Anything that depends on production's data shape.** Staging's rows are not production's rows, so
  the specific broken data that motivated a fix generally is not there. Bulk or corrective work whose
  whole risk lives in the real data cannot be rehearsed here — only its SQL can.
- **Scheduled jobs.** cron-job.org points at the production domain (§ Cron Jobs). Nothing fires
  against staging on a schedule; a cron route has to be invoked by hand there.
- 🔴 **A dev-auth role sweep — despite `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` being set there.**
  That variable is necessary but nowhere near sufficient. Both the `x-phoenix-role` header path
  (`isLocalDevHeaderRequest` in `src/lib/auth/server.ts`) and the `/api/dev-auth` route
  (`isLocalDevelopmentRequest` in `src/lib/auth/dev-preview.ts`) additionally require
  `NODE_ENV === "development"` **and** a loopback hostname — and staging is a Dockerfile build on a
  public domain, so it fails both. Verified 2026-08-23:
  `GET https://phoenix-people-workforce-staging.up.railway.app/api/dev-auth?role=Super%20Admin`
  returns **404**. Reading the variable and concluding the sweep works is the trap; role sweeps stay
  a localhost-only technique.
- **Email deliverability.** `PHOENIX_EMAIL_DELIVERY_MODE=log`, `PHOENIX_EMAIL_FORCE_TESTING=true`,
  and `NOTIFICATION_TEST_MODE=true`, so mail is logged rather than sent. That is the safe default and
  it should stay that way — but note a live `RESEND_API_KEY` **is** present in the environment, so
  flipping the delivery mode would send real mail from staging.

The staging **database** is its own isolated Supabase project (`cifwmndunmlxjhyjugxa`,
`Phoenix-HR-Staging`), with no shared third-party secrets with production. The login smoke test
step inside CI's `validate` job points at it, so its expected session-rejection noise lands there
instead of in production `audit_logs`; `migration-drift-check.yml`'s staging legs point at it too.
CI reaches it with the `STAGING_SUPABASE_SERVICE_ROLE_KEY` Actions secret, independently of the
Railway environment above — the two share the database, nothing else.

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
