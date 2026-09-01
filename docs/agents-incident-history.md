# Incident history behind the AGENTS.md rules

[AGENTS.md](../AGENTS.md) states the rules. This file holds the evidence behind them — dates, PR
numbers, billing figures, measurements, and superseded state.

**Why it is split this way.** AGENTS.md is loaded into context on every single turn of every
session; this file is read on demand. Measured 2026-08-13, the always-loaded set (CLAUDE.md +
AGENTS.md + the memory index) cost ~15,400 tokens *per turn*, and §2 and §3 of AGENTS.md were
~3,100 of those — almost entirely narrative that an agent does not need in order to obey the rule.
The rule and its one-line reason stay there. The story lives here.

Nothing in this file is optional reading when you are actually changing the thing it describes.
If you are about to touch branch protection, CI cost, the deploy path, or the region, read the
relevant section here first.

---

## Branch protection and the required checks

`main` is branch-protected: `enforce_admins: true`, force-pushes and deletions blocked, and **4
required status checks** (`validate`, `lint`, `typecheck`, `secret-scan`) that **DO gate every
merge** — a PR cannot land until all four are green on its head commit.

**`secret-scan` is required and blocking.** It is the gitleaks job in
`.github/workflows/security-scan.yml`, which #1889 deleted on 2026-08-08 believing it was optional
and #1894 restored the same day (`3cb11791`), dropping the original `--exit-code 0` that had made
the job incapable of failing. Semgrep's `sast-scan` was deliberately **not** restored (4m14s per PR
against gitleaks' 13s, and Sonar covers overlapping static-analysis ground) — so SAST does not run
at all, but secret scanning does, and it is this repo's only automated secret detection
(`security_and_analysis: null`; GHAS is not purchasable on a personal account).

Required conversation resolution is **off**. Required approving reviews is **0**, dropped
2026-08-04: a solo owner cannot approve his own PR, so the previous `required_approving_review_count: 1`
deadlocked every self-authored PR; CI is the gate instead.

`allow_auto_merge: false`, so `--auto` is rejected outright anyway.

Full protection payload re-verified live 2026-08-09.

## Why "require branches to be up to date" was turned off

Turned OFF on 2026-08-05 (owner-approved) because it was the dominant Actions cost:

- July billed **5,933 Linux minutes ($17.26 net)**.
- **Aug 1–5 alone billed 11,391 minutes ($50.00 net)** — ~12x the daily burn, tracking to
  $400+/month. It hit the spending cap on 2026-08-05, freezing every merge.

The mechanism: at **278 PRs merged in five days (74 on 2026-08-05 alone)**, every open PR fell
behind `main` within minutes of any unrelated merge, and each `update-branch` moved the head SHA,
so **all 5 checks then running re-ran from scratch and the prior green run was discarded**. Re-runs
scaled as open-PRs × merges-per-day, not additively — measured 3–16 CI runs on a single branch in
one day.

If GitHub ever *does* refuse a merge as *"not up to date"*, the strict setting has been turned back
on — confirm before assuming the rule is wrong:

```bash
gh api repos/Gawish-1997/phoenix-people-workforce/branches/main/protection --jq '.required_status_checks.strict'
```

## `gh pr update-branch` acts on the server

It merges base into head with no rebase, no force-push, and no history rewrite, so it needs none of
the section 6 approvals a rebase would. But it creates that merge commit **on the remote**, so the
local branch silently falls behind and the next `git push` is rejected with *"remote contains work
that you do not have locally"* — which reads like someone else pushed. Hit live 2026-08-04 on #1727.

GitHub may suggest `--auto` and `--admin`; both are wrong here — `--auto` is banned, and
`enforce_admins: true` means `--admin` does not bypass protection anyway.

## The 2026-08-01 Railway cutover

A merge to `main` shipping straight to production **reversed on 2026-08-01**. Railway is
GitHub-connected and deploys on push, at full traffic, with no cron wait, no staged rollout, and no
smoke test. The old Cloud Run pipeline did all four of those things and is gone;
`deploy-cloud-run.yml` and `deploy-cloud-run-staging.yml` are trigger-disabled, so a
`deploy: skipped` there is now expected rather than informative.

Verified live 2026-08-04: `/api/healthz` `revision` returns the running commit SHA, e.g. `6ae2528c`,
not `null`.

## Railway topology and the region move

Railway project `Phoenix-HR-Workforce` (id `dc218ad3-99b7-4aff-be38-953a57524a71`, env `production`
`cd5600e6-99dd-4b1c-80b2-16af8770abef`), service `phoenix-people-workforce`, 1 replica.

It ran in `sfo` (US West) from the 2026-08-01 emergency cutover until 2026-08-09. That cutover had
silently discarded the colocation deliberately set on 2026-07-17 in
`.github/workflows/deploy-cloud-run.yml` (`REGION: europe-west3`, commented "same metro, ~1ms" /
"~57ms from Cairo vs ~146ms from Iowa"), leaving the app on the far side of the planet from both its
database and its users.

Measured on `/api/healthz`, a route that does zero work: **~204ms server-side from `sfo` (n=10)
against ~75ms from `europe-west4` (n=12)**. Moved with:

```bash
railway service scale --service phoenix-people-workforce --environment production europe-west4-drams3a=1 sfo=0
```

Region verified live 2026-08-09 via `railway status` (reports `region: EU West`); rest of the
topology verified 2026-08-04. The earlier project name `creative-serenity` was wrong.

Public URL also reachable at `https://phoenix-people-workforce-production.up.railway.app`.
Cloudflare holds `CNAME phoenix-hr -> xok6ir4p.up.railway.app`, unproxied; the pre-cutover value was
`A 8.232.10.208` (Cloud Run) if a rollback is ever needed.

## How GCP died

Billing account `01BDEA-A20B4C-CC568F` closed 2026-08-01 ~21:00 Cairo over an unpaid balance the
owner has decided not to settle. Every API in project `phoenix-workforce-498619` returns
`BILLING_DISABLED`, and the site served 503 for ~2h15m until the Railway cutover. Expect GCP to
delete the project's resources roughly 30 days after closure. `deploy-cloud-run.yml` /
`deploy-cloud-run-staging.yml` are trigger-disabled but otherwise intact for that reason.

The Cloud Run staging service (`phoenix-hr-staging`, same project) died with it; there is no Railway
replacement. `.github/workflows/deploy-cloud-run-staging.yml` is left in the repo but is dead.

## cron-job.org, the real production scheduler

Verified live 2026-08-02 from Railway HTTP logs — its `/api/cron/*` requests return 200. Daily
notifications, the outbox drain, and iReports sync/reconcile all fire from that account.

The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** (secret mismatch) — a red
herring, not proof anything is down. The Railway `phoenix-cron` service never reached the app and
was disabled.

Caveats: it is free-tier, undocumented, and outside the repo — its schedule lives only in that
account, a single point of failure no runbook mentions — and it caps request timeout at 30s, so a
long route logs a false `Failed (timeout)` while the server still finishes the work. iReports
freshness also has an in-process poller (`PHOENIX_LIVE_CRM_POLL=true`) independent of any cron.
`src/lib/cron-control/*` is a dashboard over the dead GCP Cloud Scheduler and remains inert.

Detail: memory `cron-job-org-is-the-real-production-scheduler`.

## The retired staging Supabase project

Current staging ref `cifwmndunmlxjhyjugxa` (`Phoenix-HR-Staging`, Pro org, eu-central-1) was created
2026-07-11 as a 1:1 clone of production.

The prior free-tier staging project, ref `izhmxvgiktiafqusolot`, is **GONE** — as of 2026-07-27
`list_projects` returns only `cifwmndunmlxjhyjugxa` and `ozucdzovmcqvepbozvqf`, so that old ref
resolves to nothing. Treat any doc, script, or prompt still naming it as stale.
`scripts/staging-safe-rebuild.ts` is the one deliberate exception: its `currentStagingRef` pins the
archived ref on purpose and says so.

## `STAGING_SUPABASE_SERVICE_ROLE_KEY` wiring

Added 2026-07-18. The staging project's service-role key, consumed by **two** workflows.

In `.github/workflows/ci.yml` it is set on the `validate` job's "Run Playwright login smoke test"
step, so the login-smoke test (CI_SMOKE_LOGIN_ID account) writes its expected session-rejection
noise to staging instead of production `audit_logs`; the matching URL/anon key for that step are
hardcoded in `ci.yml` (public/non-secret, RLS-protected).

In `.github/workflows/migration-drift-check.yml` it powers both staging legs
(`check:migrations-applied` and `check:schema-shape`) — the production legs use the separate
`PRODUCTION_SUPABASE_SERVICE_ROLE_KEY`.

**There is no `preview-smoke` job any more**; the smoke test is a step inside `validate` (verified
2026-08-09).

---

# §3 Stable Environment Facts — the accounts

Companion to **[AGENTS.md §3](../AGENTS.md)**, which auto-loads in full on every request and so pays
only for the **hook**. This part holds the **account**: the measurements, dates, PR numbers and the
diagnosis traps that nearly sent each one the wrong way.

**Adding here? Put the hook in AGENTS.md §3 and the account in this file — never the account there.**

## Why production must stay in Europe

The Railway region `europe-west4-drams3a` (Amsterdam) is deliberately colocated with the Frankfurt
Supabase project (`eu-central-1`) and near the Cairo users. Measured: **~204 ms from `sfo` versus
~75 ms from `europe-west4`**. If production is ever re-platformed, it must stay in Europe.

## The Railway source branch that silently stranded five merged PRs

The `production` Railway environment's service now tracks git branch `main` directly, repointed
**2026-08-13** via `railway service source connect --environment production --branch main`.

Before that it was source-configured to track a git branch literally named `staging`, which had gone
stale. Five already-merged, already-CI-green PRs — **#2093, #2095, #2094, #2098, #2097** — sat
unshipped in production for hours while `main` moved on, **with no error or signal anywhere**.
GitHub shows the merge as normal either way, so nothing surfaces the drift.

That is why the rule is to confirm the service source branch rather than assume a merge ships. Note
also that `railway status --environment production --json` returns the **whole project**, so a reader
taking `environments.edges[0]` prints the same environment whatever `-e` says. Select by
`.environments.edges[] | select(.node.name=="production")`, print the name you matched, then read
`.node.serviceInstances.edges[].node.latestDeployment.meta.branch`.

## cron-job.org: the 30 s cap, and the mid-sweep snapshot trap

Both halves were measured **2026-08-28** with a one-shot probe on `/api/cron/crm-contact-lists`. The
API accepted and read back `requestTimeout=300`, and the execution still recorded
`status=5 http=0 ms=30108` — the 30 s cut is a **platform cap** `requestTimeout` cannot raise.

But the server finishes the work anyway. The route's own audit row — written **last** in the handler
— landed at **20:09:43 Cairo** covering **all 82 agents, 9,518 rows, 0 failures**, about **70 s
after** the client was killed. So a long route logs a false `Failed (timeout)` while succeeding.

⚠ **A mid-sweep snapshot reads exactly like a truncated one, and this rule carried the resulting
error for one commit.** A query run at **20:09:02**, while the sweep was still writing, returned
"39 of 68 agents re-stamped" and was reported as proof that the work half-applies. It was just the
run in progress. Never judge completion from row timestamps while the job may still be running —
read the terminal artefact (the audit row, the response body from
`GET /jobs/{id}/history/{identifier}`, the final log line), or re-query only after the route's full
known duration has elapsed.

Slicing a long route into several ticks is still right, for the honest reason: a permanently red job
is one nobody reads, the response body is never seen, and completion otherwise depends on a detached
request surviving a container restart. `/api/cron/crm-contact-lists` is the worked example — one
twelfth of the roster per tick, 12 ticks 5 minutes apart inside one hour, measured at 8–10 s each.

## The outbox drain that ran perfectly and did nothing for 13 days

cron-job.org job **8200914** hits `/api/notifications/process?limit=50` **every 5 minutes**, returns
**HTTP 200** in ~3–5 s, and returned `"outbox":{"attempted":0,…}` on **every single cycle from
2026-08-14 to 2026-08-27**. It was never down, never 401, never unscheduled — so a green cron and a
200 prove nothing here.

The cause was a **head-of-line block** in `loadDueNotificationOutboxRows`
(`src/lib/notifications/email.ts:1998-2007`): `.limit(50)` was applied **in SQL**, then
`attempts < max_attempts` was filtered **in JS afterwards**. Fifty permanently exhausted rows
(`attempts = 5 = max_attempts`, created 2026-08-09 → 08-14, all with `next_attempt_at IS NULL`,
which *matches* the due predicate) filled the entire batch window; the JS filter then emptied it, so
`attempted` was 0 forever and **nothing newer was ever reached.**

The consequence was invisible from the product, because inline sends still work: **every retry was
silently dead.** Any mail whose inline send failed queued behind the blockage and was never retried.

**Cleared 2026-08-27 ~18:15 Cairo** by retiring those 50 rows to `status='skipped'` (reversible,
`last_error` marked); the window then returned **0** rows.

**FIXED 2026-08-27 — the code bug is gone:**

- **#2462** (`9f61f582`) made the loader page past dead rows.
- **#2464** (`2e93c273`) moved `attempts < max_attempts` into the SQL query itself, on **all three**
  drains — telegram and push carried the identical defect, **25 and 16** dead rows against the same
  50-row window — so exhausted rows can no longer consume the window.
- **#2468** (`c943d46f`) added the alarm that would have caught this on the first cycle rather than
  after 13 days: every run asks whether a queue had work due **before the run started** and
  attempted nothing, and on that shape pings the dead-man's switch **fail** with the reason and
  writes a `drain_stranded` ERROR log.
- **#2470** (`4a64464f`) added the third channel, because those two only reach someone already
  watching a dashboard or an inbox: it **pages a human in-app + Telegram** on the existing
  `weekly_system_health_digest` audience (retarget or silence it at
  `/admin/notification-recipients` — no new key, no migration), bucketed per Cairo day **and** per
  exact set of stranded queues, so a strand that persists across ticks alerts once a day while a
  newly stranded queue still gets through.

**Deliberately no email, and do not "fix" that back** — this alert fires precisely when the
notification pipeline is the thing not delivering, so an emailed alert would depend on the channel
it is reporting broken. It is best-effort and never throws: a failed alert must not turn a stranded
drain into a second, self-inflicted incident.

Memory: `outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line`

## The Railway staging environment

Verified **2026-08-13** and the owner confirmed keeping it. Same project, service
`phoenix-people-workforce`, reachable at `https://phoenix-people-workforce-staging.up.railway.app`
(returns 200, `/api/healthz` responds).

Its service source tracks git branch `main` — not the git branch named `staging` — so confusingly,
this Railway *environment* named "staging" was, until the production fix above, actually **fresher
than the Railway environment named "production"**.

`railway variables --environment staging` confirms `NEXT_PUBLIC_SUPABASE_URL` points at the staging
Supabase project (`cifwmndunmlxjhyjugxa`), not production — safe to use as a real verification
target.

## The Supabase ref list, and why neither region nor org is a guard

The four refs in the AGENTS.md §3 table are the complete list `list_projects` returns, verified live
**2026-08-23**. Two belong to this app; the other two do not, and are tabled precisely so an
unfamiliar ref is identifiable instead of alarming.

**Dead refs:** `izhmxvgiktiafqusolot` (the prior free-tier staging) and `oaifhavixhdtwmseshff` (an
older secondary project). Neither is returned by `list_projects` any more. The §3 list named only the
first as dead until 2026-08-23; both were live in older memories, and one of them sat in the
`reference` memory a session consults to answer "which project is which".

Three of the four are `eu-central-1`, and a different organization does not stop anyone passing a
ref — so neither region nor org is a guard. Combined with both named MCP servers seeing all four,
the `project_id` argument remains **the only thing separating staging from production on every
call.**


---

## Relocated from AGENTS.md — 2026-09-01 (batch 2)

Verbatim, unabridged. The cue — and every memory slug — stays in `AGENTS.md`; the account is here.

- **The OUTBOX DRAIN is the one that needs care — it ran perfectly and did nothing for 13 days.** **A green cron and a 200 prove nothing here**, and **`attempted: 0` cannot by itself tell idle from broken — read `drainHealth` in the response body.** The head-of-line block is **FIXED 2026-08-27** on all three drains (outbox, telegram, push), with a dead-man's-switch alarm and an in-app + Telegram page behind it. **That alert is deliberately never email, and do not "fix" that back** — it fires precisely when the notification pipeline is the thing not delivering, so an emailed alert would depend on the channel it reports broken; it is best-effort and never throws. **Never infer a cron's health from database state alone, or from its status code** — read its execution history *and* its response body (on cron-job.org the job-list endpoint returns an empty body; only `GET /jobs/{id}/history/{identifier}` carries it). To check the drain, run its own window query — `status in ('pending','failed')` AND `(next_attempt_at is null or next_attempt_at <= now())` ordered by `created_at` **limit 50** — and count how many of those 50 are already exhausted. `outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line`

- **The production scheduler is the third-party `cron-job.org`, and it is running, not stalled.** Daily notifications and iReports sync/reconcile fire from that account. The 8 GCP Cloud Scheduler jobs still fire but **401 on every route** — a red herring, not proof anything is down. **Never tell the owner notifications/iReports are stalled without checking `cron-job.org` first.** **It cuts every request at 30 s, a PLATFORM cap `requestTimeout` cannot raise — but the server DOES finish the work afterwards**, so a long route logs a false `Failed (timeout)` while succeeding. ⚠ **A MID-SWEEP SNAPSHOT READS EXACTLY LIKE A TRUNCATED ONE.** Never judge completion from row timestamps while the job may still be running — read the terminal artefact (the audit row, the response body of `GET /jobs/{id}/history/{identifier}`, the final log line), or re-query only after the route's full known duration has elapsed. Slicing a long route into several ticks is still right: a permanently red job is one nobody reads. `src/lib/cron-control/*` is a dashboard over the dead GCP scheduler and remains inert.
