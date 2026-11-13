# Phoenix Workforce — Disaster Recovery & Operations Runbook

> ## Production runs on Railway — the 2026-08-01 GCP → Railway cutover
>
> On 2026-08-01 the GCP billing account (`01BDEA-A20B4C-CC568F`, project `phoenix-workforce-498619`)
> was closed over an unpaid balance the owner chose not to settle. Every `gcloud` command against
> that project now fails `BILLING_DISABLED`, permanently — GCP is dead, not standby, and Google is
> expected to delete the project's resources roughly 30 days after closure. Production moved to
> **Railway** the same day. **Every procedure in this runbook is the current Railway procedure** —
> nothing below needs a `gcloud` command. Historical Cloud Run detail is kept only where it is
> genuinely useful context, and is always labeled historical.
>
> | Fact | Now |
> |---|---|
> | Host | Railway — project `Phoenix-HR-Workforce`, env `production`, service `phoenix-people-workforce` (region `europe-west4-drams3a`, Amsterdam/EU West since 2026-08-09 — colocated with the Frankfurt Supabase project on purpose; a rebuild must stay in Europe) |
> | Deploy trigger | push/merge to `main` (GitHub-connected auto-deploy), **gated on that commit's Actions check suites** (Railway Wait for CI) — the merge plus a green CI is the deploy: then full traffic, within minutes, no staged rollout, no smoke test. 🔴 **The gate fails by NOT shipping, silently** — red/cancelled/queued withholds the deploy and a 2-hour timeout abandons it with nothing red. Never read the merge; read `revision` below. See [deployment.md](deployment.md), "The deploy gate" |
> | Confirm what's live | `curl https://phoenix-hr.satopharma.com/api/healthz` → read `revision` |
> | Migrations | applied by hand, **before** the merge — the Railway build runs none |
> | Scheduler | third-party **cron-job.org**, outside this repo (§7) — not GCP Cloud Scheduler (still fires, always 401s, ignore it) and not Railway's own `phoenix-cron` (disabled, never worked) |
> | Alerting | 🔴 **nothing pages the owner.** Healthchecks.io (cron liveness only) is the one survivor — see §1 |
> | Staging | Railway env `staging` of the same service — `https://phoenix-people-workforce-staging.up.railway.app`, on the staging Supabase project `cifwmndunmlxjhyjugxa`. Tracks `main`, so it is **not** a preview of an unmerged branch and is **not** a second copy of production data (see deployment.md § Staging Environment) |
>
> **Railway identifiers** (verified live 2026-08-04 via `railway status`; scripted CLI calls below
> use IDs, not names — that's the proven-reliable pattern here):
>
> | Object | Name | ID |
> |---|---|---|
> | Project | `Phoenix-HR-Workforce` | `dc218ad3-99b7-4aff-be38-953a57524a71` |
> | Environment | `production` | `cd5600e6-99dd-4b1c-80b2-16af8770abef` |
> | Service (app) | `phoenix-people-workforce` | `30356676-116b-4886-ac6e-89041d80185e` |
> | Service (cron — disabled, ignore) | `phoenix-cron` | `179e6a73-d891-4fbc-a89e-ac53ef461821` |
>
> Re-confirm the topology yourself before trusting the table above — it has drifted once already:
> ```bash
> railway status -p dc218ad3-99b7-4aff-be38-953a57524a71 -e cd5600e6-99dd-4b1c-80b2-16af8770abef --json
> ```

_Historical context (pre-2026-08-01): production ran on **GCP Cloud Run** (project
`phoenix-workforce-498619`, region `europe-west3`, service `phoenix-hr`) at the same domain,
backed by Supabase, Resend, and Google Cloud Scheduler. The domain and Supabase project are
unchanged across the cutover. No secret values appear in this document._

## 1. Incident response — first 5 minutes

1. **Confirm scope:** `https://phoenix-hr.satopharma.com/api/healthz` (liveness — 200 plus
   `revision`, the running commit SHA) and `/api/readyz` (readiness — `{database:true, env:true}`
   plus a `warnings: []` array for non-fatal notification-config drift; HTTP 503 when a required
   dependency isn't ready). For email specifically: `/api/health/email` → 200 `healthy` (anonymously only
   `{status, timestamp}`; the full report needs the `CRON_SECRET` bearer or a Super Admin session).
2. **Check alerts:** 🔴 **there is no alerting layer any more.** All five GCP Cloud Monitoring
   policies (5xx rate, p95 latency, uptime, scheduler failure, auth-failure spike, config drift) died
   with the GCP shutdown and nothing has replaced them; Sentry was separately retired 2026-07-31.
   The only thing that still pages anyone is the **Healthchecks.io** dead-man's-switch, and it only
   answers one question — did a cron job run at all. Check its dashboard for any check showing
   `DOWN`, check `/admin/system-audit` → **Incidents** tab (app-level `app_error_events`; it replaced
   System Issues on 2026-10-23 and never showed infra-level failures — use `railway logs` for those),
   and check the Railway dashboard's service
   metrics (CPU / memory / restarts). None of these push a notification — you have to go look.
3. **Check logs:**
   ```bash
   railway logs -s phoenix-people-workforce -e production -p Phoenix-HR-Workforce
   ```
   Structured single-line JSON; `event` is a top-level key (`cron_unauthorized`,
   `webhook_signature_invalid` / `webhook_misconfigured`, `cron_failed` / `background_job_failed`,
   `config_drift`). Add `--http --json` for the HTTP access log (`clientUa`, `httpStatus`, `@path` —
   this is how a genuine cron-job.org call is told apart from the noisy, harmless 401s still coming
   from GCP Cloud Scheduler, see §7). Useful filters: `--filter "@level:error"`,
   `--http --status ">=400"`, `--since 1h`.
4. **Classify:** application error (deploy a fix or roll back — §2/§3) vs. data issue (§4) vs.
   dependency outage (Supabase/Resend status pages) vs. scheduler outage (cron-job.org dashboard,
   §7 — check this before telling anyone notifications/outbox/iReports sync are stalled; it has kept
   running silently through outages that looked total from inside this repo before).

## 2. Rollback (fastest recovery for a bad deploy)

Railway has no traffic-splitting — a deploy is either live at 100% or it isn't. There are two ways
back; use **A** unless you have a specific reason to reach for **B**.

### A. Revert the commit (reliable — matches git history, always available)

```bash
git checkout -b codex/revert-<short-reason> origin/main
git revert <bad-sha>
git push -u origin codex/revert-<short-reason>
gh pr create --title "revert: <reason>" --body "Reverts <bad-sha> — <why>"
```

Wait for every required check to go green — two of them, `validate` and `checks`
(`gh pr checks <PR-number> --required`; don't foreground-watch, check back). Read that list live from
`branches/main/protection/required_status_checks` rather than from this line: it has rotted five
times. `mobile` and `secret-scan` were demoted 2026-09-29 and taken off `pull_request` in the same
change: they block nothing and will not appear on the PR at all, so in an incident do not wait for
them — they run on `main`, a schedule or a dispatch. Get
explicit owner approval — merging to `main` always needs it, incident or not (AGENTS.md §6) — then:

```bash
gh pr merge <PR-number>
```

Never `gh pr merge --auto` — `allow_auto_merge` is `false` on this repo and it would be rejected
anyway, but the habit is worth not forming. Once merged, Railway ships it at full traffic within
minutes — there's no staged rollout or smoke test standing between the merge and the fix reaching
employees, which is what makes this a real rollback path and not just "eventually." Confirm:

```bash
curl -s https://phoenix-hr.satopharma.com/api/healthz
```

`revision` should move off the bad SHA. To independently confirm a deploy actually fired (separate
from what's serving traffic): `gh api repos/sato-pharma/phoenix-people-workforce/deployments` —
rows read `Phoenix-HR-Workforce / production … "Deployed to Railway"`.

🔴 **This applies no migrations.** If the bad deploy shipped a schema change, the revert only undoes
the code — undo the schema separately (§4, docs/migrations.md) or the reverted code may now be
missing a column/function the still-forward schema expects.

### B. Redeploy an older build from the Railway dashboard (faster, code-only issues)

```bash
railway deployment list -s phoenix-people-workforce -e production -p Phoenix-HR-Workforce
```

lists recent deployments with IDs, statuses, and timestamps. 🔴 **The CLI cannot redeploy an
arbitrary older one** — `railway redeploy` / `railway deployment redeploy` only redeploy the
*latest* deployment of a service; neither takes a deployment-ID argument. To restore a specific
older build: Railway dashboard → project `Phoenix-HR-Workforce` → service `phoenix-people-workforce`
→ **Deployments** → find the last-good one → **Redeploy**.

This does not touch git — `main` still points at the bad commit, so the next merge (or the next
`railway redeploy`, see the warning in §5) ships the bad commit again. Follow up with option A once
the immediate fire is out, so code and deployment don't quietly diverge.

Confirm the same way: `curl -s https://phoenix-hr.satopharma.com/api/healthz`.

## 3. Redeploy / forward-fix

Same pipeline as §2A: branch → PR → every required check → explicit owner approval → `gh pr merge`.
There is no separate "Deploy to Railway" workflow to dispatch — the merge **is** the deploy, and it
ships within minutes at full traffic. See §2A for the exact commands and the deployments-API check.

🔴 **Apply any required database migration before merging, not after** (§4) — the Railway build has
no migration step (`package.json` has no `db push`/`migrate` script; `build` is plain `next build`,
`start` is plain `next start`). Code that selects a new column or calls a new function goes live
before the schema does unless you apply the migration first; the failure is silent until a user
opens the affected page.

Confirm: `curl -s https://phoenix-hr.satopharma.com/api/healthz` → `revision` matches the new
commit.

## 4. Database recovery (Supabase)

- **A full restore is the most destructive action in this runbook.** Supabase writes are
  pre-authorized end to end for routine work (AGENTS.md §8 — no permission prompt blocks a migration
  or a query), but a point-in-time or project restore is irreversible and can lose every write since
  the restore point, across payroll, attendance, and sales data. Treat it as AGENTS.md §6's
  "irreversible operation," not as pre-authorized: show the target, the restore point, the expected
  data-loss window, and **wait for the owner to say go, live, in the conversation**, before running
  it.
- **Point-in-time recovery / backups:** Supabase dashboard → Database → Backups, or the Supabase
  MCP's restore capability — same blast radius either way. Confirm PITR and retention meet policy
  before you need them, not during the incident (§8 below).
- **The company's own copy (since 13 Nov 2026).** Every night the Railway service `phoenix-code-backup`
  writes the whole database, encrypted, to Drive: `phoenix-db-backup/daily/db-backup-YYYY-MM-DD.tar.age`,
  7 daily and 4 weekly. Only the owner's private age key opens it. It is the copy to reach for when the
  provider's own backups are gone, too old, or the thing that failed. It restores into a NEW project or a
  scratch schema, never over the live one, and the same rule applies: the owner says go first. How to
  decrypt, drill and restore: `infra/code-backup/README.md`, "Nightly database backup". It does not hold
  the files in Storage or any secret.
- **A backup nobody has restored is a hope.** `infra/code-backup/restore-drill.sh` restores a night's
  file into a throwaway server and compares every table's row count with the count taken when the
  backup was made. Run it after any change to the backup, and write the date and the time it took in
  `docs/audits/phoenix-crm-integration-audit/16_IMPLEMENTATION_PLAN.md`.
- All schema changes are migration-based (`supabase/migrations/`). To recover schema, re-apply
  migrations to a fresh project in order — see docs/migrations.md. History before 2026-07-11 was
  collapsed into one baseline-snapshot migration
  (`20260711135352_phoenix_production_schema_baseline.sql`); the pre-baseline files are archived
  under `supabase/_migrations_archive/` for reference only and must never be re-applied or
  re-timestamped.
- The durable job queue (`background_jobs`) and `app_error_events` are non-critical/transient; safe
  to truncate if corrupted (they hold no business records).
- Prove any recovery against `pg_class` / `pg_proc` / a row count — never against `list_migrations`,
  it reports the migration ledger, not what's actually live on the server.

## 5. Secret rotation

Secrets live in Railway service environment variables (owner-managed; a production env-var change
needs its own explicit approval per AGENTS.md §6, same as any other production deploy). To rotate
one:

```bash
printf '%s' "$NEW_VALUE" | railway variables set <NAME> --stdin \
  -p dc218ad3-99b7-4aff-be38-953a57524a71 \
  -e cd5600e6-99dd-4b1c-80b2-16af8770abef \
  -s 30356676-116b-4886-ac6e-89041d80185e \
  --skip-deploys

railway redeploy -y \
  -p dc218ad3-99b7-4aff-be38-953a57524a71 \
  -e cd5600e6-99dd-4b1c-80b2-16af8770abef \
  -s 30356676-116b-4886-ac6e-89041d80185e
```

- Use `printf`, never `echo` — a trailing `\n` silently breaks a byte-exact secret comparison
  downstream. A related CRLF-corrupted `CRON_SECRET` write (Git Bash piping into secret storage,
  Cloud-Run era) 401'd every cron for ~14 minutes — same failure shape, don't relearn it.
- Pipe the value over stdin; never type it into the command line or the Railway web UI's variable
  editor — Railway renders *staged* (unsaved) variable values unmasked, so an open changes panel can
  leak a secret into a screen share or a transcript.
- 🔴 **`railway redeploy` is a full rebuild from `main` HEAD, not a config-only bounce** — verified
  2026-08-02: redeploying only to pick up one new environment variable rebuilt from `main` and
  shipped two unrelated commits that had not gone live yet. Record `/api/healthz` `revision`
  immediately before and after any `railway redeploy`, so an unintended ship is visible immediately.

`CRON_SECRET` rotation must also update the `Authorization` header on **every** job in the
cron-job.org dashboard in the same window, or every cron 401s (§7). `RESEND_WEBHOOK_SECRET`
rotation must also be updated in the Resend dashboard (§8).

> **TODO(verify):** the current cron-job.org job list/IDs — that account is outside this repo and
> its schedule has already drifted from the paper record in docs/deployment.md § Cron Jobs at least
> once. Confirm the live list in the dashboard before rotating, rather than trusting any doc.

## 6. Pause switches (containment)

- **Email:** same mechanism as §5 —
  ```bash
  printf 'false' | railway variables set EMAIL_NOTIFICATIONS_ENABLED --stdin \
    -p dc218ad3-99b7-4aff-be38-953a57524a71 -e cd5600e6-99dd-4b1c-80b2-16af8770abef \
    -s 30356676-116b-4886-ac6e-89041d80185e --skip-deploys
  ```
  (all sends skip), or set `PHOENIX_EMAIL_DELIVERY_MODE=testing` the same way to redirect every send
  to the internal test inboxes instead of stopping it outright. Either way, follow with
  `railway redeploy` and read the §5 warning first — it is a full deploy, not a flag flip.
- **Crons:** cron-job.org dashboard → find the job → disable it. There is no CLI/API path documented
  in this repo — it's a third-party account outside version control (§7).
  > **TODO(verify):** who holds login access to the cron-job.org account, and whether it has an API
  > key that would let this be scripted instead of done by hand in the dashboard mid-incident.
- **Read-only / maintenance mode: there isn't one.** `PHOENIX_PREVIEW_READ_ONLY` /
  `APP_ENV=preview` is a leftover Vercel-preview guard confirmed inert today — nothing in this
  Railway topology ever sets `APP_ENV=preview`, so setting the flag alone does nothing. Do not reach
  for it as a containment lever during an incident; it will not do what the name suggests. There is
  no maintenance-mode or read-only kill switch anywhere in the codebase today (verified: no
  `MAINTENANCE_MODE` / `READ_ONLY_MODE` / `KILL_SWITCH`-style flag exists in `src/`). Full
  containment currently means pausing crons (above) plus the email switch — there is no faster
  single lever.

## 7. External callback / integration inventory

| Integration | Direction | Auth | Endpoint / config location | Idempotent |
|---|---|---|---|---|
| Resend (email) | outbound | `RESEND_API_KEY` | `api.resend.com/emails` | Idempotency-Key header |
| Resend webhook | inbound | Svix signature (`RESEND_WEBHOOK_SECRET`) | `…/api/webhooks/resend` (owner sets in Resend dashboard) | `provider_event_id` upsert |
| Supabase (DB/Storage/GoTrue bridge) | both | anon + service-role keys | `NEXT_PUBLIC_SUPABASE_URL` | — |
| Telegram | both | bot token + `NOTIFICATION_WEBHOOK_SECRET` | `api.telegram.org`; inbound `…/api/integrations/telegram/webhook` | secret-token header |
| iReports360 CRM | — | **retired 6 November 2026** — nothing calls it, and its `IREPORTS360_*` secrets are no longer required | — | — |
| Google Maps / Calendar | outbound | server + browser keys | Google APIs | — |
| OpenAI (+ fallbacks) | outbound | `OPENAI_API_KEY` | api.openai.com | — |
| On-prem attendance agent | inbound | `ATTENDANCE_AGENT_TOKEN` bearer | `…/api/attendance/raw-punches` | `ON CONFLICT DO NOTHING` |
| **cron-job.org → crons** | inbound | `CRON_SECRET` bearer | `/api/notifications/*`, `/api/cron/*` | per-job |
| GitHub → Railway | deploy | Railway's own GitHub App connection (no repo secret) | configured in the Railway dashboard, not this repo | — |

🔴 Two other callers still hit the cron routes and both are noise, not signal: **GCP Cloud
Scheduler**'s 8 jobs still fire but 401 on every route (secret mismatch against a dead project —
don't chase it), and Railway's own `phoenix-cron` service is disabled and never reached the app
while it ran. Tell them apart in `railway logs --http --json` by `clientUa`: a `cron-job.org` UA
from a Hetzner IP is real; `Google-Cloud-Scheduler` is not.

## 8. Owner-gated verifications (external consoles)

| Check | Where | Expected |
|---|---|---|
| Resend webhook endpoint | Resend → Webhooks | `https://phoenix-hr.satopharma.com/api/webhooks/resend`; signing secret == `RESEND_WEBHOOK_SECRET` |
| Supabase Auth Site URL | Supabase → Auth → URL Config | Site URL + redirects = canonical domain (low impact: app uses app-managed auth, bridge uses admin API) |
| Supabase backups / PITR | Supabase → Database → Backups | PITR enabled + retention that meets policy |
| Healthchecks.io notification channel | healthchecks.io → project → Integrations | at least one channel (email/Slack/Telegram/…) configured and receiving — this is the **only** alert left that pages anyone (§1) |
| cron-job.org account access | cron-job.org dashboard (third-party, outside this repo) | someone on the team can list/edit jobs; job list matches docs/deployment.md § Cron Jobs |

## 9. Vercel — fully decommissioned, not a rollback target

Vercel predates Cloud Run and is now doubly legacy. There is **no runtime dependency on it**
(enforced by the `check:no-stale-domains` CI gate — no `vercel.app` / `process.env.VERCEL` allowed
in shipped source), and AGENTS.md §3 records it as fully decommissioned: never deploy to it or
verify against it, and it is not a rollback target — use §2 instead. DNS for the production domain
points at Railway (Cloudflare `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied), not at any
Vercel or Cloud Run mapping.
