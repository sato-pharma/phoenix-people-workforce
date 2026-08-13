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
