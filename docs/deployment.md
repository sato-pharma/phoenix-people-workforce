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
| Rep-tablet management + remote screen | **Railway** (the same project) | Services `phoenix-headwind` (custom domain `mdm.satopharma.com`) and `headwind-db` (Postgres), region inherited `europe-west4`. 🔴 **This replaced a rented VPS on 2026-09-25 at the owner's instruction — no box is rented, and one should not be sought.** Its image is **built, not pulled**: Root Directory [`infra/headwind-phoenix-actions/`](../infra/headwind-phoenix-actions/) (see its `railway.toml`) extends the pinned image with the add-on carrying lock, lost mode, factory reset and screen-lock reset; on the stock image those four refuse. 🔴 **Watch Paths must stay `infra/headwind-phoenix-actions/**`** — without it every merge to `main` rebuilds the MDM server and a hundred tablets lose their check-in channel. The remote screen uses RustDesk's **own free EU relay** — no server at all. Nothing in CI builds or starts it; Railway deploys it on a push that touches those paths, and Phoenix otherwise only talks to it over HTTPS. [`docker-compose.headwind.yml`](../docker-compose.headwind.yml) is kept deliberately as the self-hosted path for the day the company wants to own the relay — Railway allows one TCP proxy port per service and no UDP, while RustDesk's ID server needs 21115–21119 TCP plus 21116 UDP. Ships dark — with `HEADWIND_MDM_*` unset, Rep Tablets is unchanged. See [devices/headwind-rustdesk.md](devices/headwind-rustdesk.md) |

Railway is **GitHub-connected**: it deploys from this repo on push to the default branch, **gated on
that commit's CI** (see "The deploy gate" below). There is no deploy workflow in
`.github/workflows/` that ships production any more.

## The deploy gate

🔴 **PRODUCTION IS GATED AND PROVEN. STAGING'S TOGGLE IS ON BUT IS NOT ENFORCING — do not read
them as one setting.** Railway's **Wait for CI** is switched on for the `phoenix-people-workforce`
service in **both** environments (owner's instruction, 2026-09-27: *"no i want 2 stop bad deploy"*;
both verified in the dashboard, `aria-checked="true"`, still true after a full reload). On production
it holds. On staging the behaviour does not match the switch:

| on `ddda75259` | |
| --- | --- |
| CI | created 18:27:12 → finished **18:31:49** |
| **staging** | `in_progress` 18:27:14 → **`success` 18:29:28** — live **2m 21s BEFORE CI concluded** |
| production | `in_progress` 18:27:14 → still holding |

The staging record was CREATED after the toggle was flipped, so this is not a leftover in-flight
deploy. Three hypotheses were open on that reading alone: propagation lag (it was flipped minutes
earlier); the setting being honoured only for the service's production environment while the
per-environment UI value is displayed but not enforced; or a superseded queued deploy not being
re-gated (staging jumped `c2b9ac558` → `ddda75259`, skipping `c93a6269f`).

🔴 **ONE COMMIT SETTLES IT, and excludes all three at once**, because both environments deployed from
the same push and read the same verdict. `3754f77cc`: CI run `36341414366` was created **18:38:49Z**
and concluded **SUCCESS at 18:44:11Z**.

| on `3754f77cc` — one push, one CI run | `success` at | against the verdict |
| --- | --- | --- |
| **staging** (deployment `6696241112`) | **18:41:08Z** | **3m 03s BEFORE it existed** |
| production (deployment `6696241078`) | 18:46:24Z | 2m 13s after it |

Same commit, same run, opposite behaviours — so propagation lag, toggle timing and "CI was already
green" are all excluded in a single reading, which two separate anecdotes could not do. **Railway's
Wait for CI is honoured on the production environment and NOT on staging, whatever the staging toggle
reads in the dashboard.** The intended remedy was to give staging a branch of its own that only ever
carries CI-green commits (`staging-branch-sync.yml`, #4552) — **that branch exists and works, and
Railway did not follow it either: see the next subsection before describing staging as gated by
anything.** Measured by one session and re-verified independently against the deployment `statuses`
endpoint by another before being written here — states, never timestamps alone (§2.3).

### The repoint was made, and Railway did not apply it — 2026-09-27, 19:21Z

🔴 **STAGING WAS REPOINTED AT THE `staging` BRANCH IN THE DASHBOARD, THE PAGE SHOWS IT, AND THE SERVICE
KEPT DEPLOYING FROM `main`.** The setting persists across full reloads and
`railway status --json -e staging` reports `activeDeployments[].meta.branch = "main"` at the same time.
So do not describe staging as gated on any basis — not the toggle, not the branch, not both.

| | deploys from | gated by |
| --- | --- | --- |
| **production** | `main` | Railway **Wait for CI** — enforced and measured, twice |
| **staging** | `main`, still | **nothing.** Both of its environment settings — Wait for CI, and the source branch — display correctly in the dashboard and **neither is applied** |

**It is ONE question, not two.** Two settings on the same service instance display and do not apply,
which points at that instance's configuration not propagating rather than at two unrelated Railway
bugs. Railway support has it as of 2026-09-27 (the owner posted it).

**The proof is in the API alone, and it does not need the dashboard.** Both commits below deployed to
staging **before their own CI concluded**, and the second is decisive about the branch as well: a
staging deployment record existed for a commit that `refs/heads/staging` could not yet contain, because
the sync only publishes after CI concludes.

| commit | CI concluded | staging `success` | production `success` |
| --- | --- | --- | --- |
| `7e6411d88` | 19:37:23Z | **19:32:50Z** — 4m 33s BEFORE, and 35s after the record was created | 19:38:06Z — 43s after |
| `bc049b3e4` | 19:42:51Z | **19:40:18Z** — 2m 33s BEFORE | 19:45:32Z — 2m 41s after |

🔴 **CONVERGENCE HIDES ALL OF THIS, SO MEASURE AT A MERGE, NEVER AT REST.** Minutes later `main`, the
`staging` branch and both serving revisions were one commit (`bc049b3e4`), and every reading then looks
consistent with staging following the branch. The only readings that distinguish the two are taken
while a commit's CI is still in flight. **A converged snapshot is not evidence either way.**

**The branch itself is healthy and is not the problem.** `staging-branch-sync.yml` has run five times,
all `success`, and correctly withheld an unverified commit while staging served it from `main` anyway.
Two SHAs produced two runs each — a CI rerun on one commit fires a second `workflow_run` — and the
duplicates were harmless no-ops, which exercises the `[ "$CUR_SHA" = "$NEW_SHA" ]` short-circuit in the
wild rather than only in its test. **The branch is ready for the moment Railway obeys it.**

🔴 **`STAGING_TRACKS_BRANCH` IS REMOVED AGAIN, DELIBERATELY** (confirmed: the variable API answers 404).
Its documented precondition is to set it in the same change that repoints Railway *and not before*, and
the repoint did not take. Left armed, `deploy-drift-check.yml`'s staging arm would have alarmed within
30 minutes blaming "a sync that stopped firing" and an "ever-older commit" — the exact inverse of
reality, since staging was serving a **newer** commit than its own branch. Set it only once staging is
observed serving the branch.

🔴 **AND WHEN THE REPOINT IS RETRIED, THE SELECTOR HAS A SILENT WRONG-BRANCH TRAP.** Never
`railway service source connect` (§2.3: not environment-scoped — it once repointed PRODUCTION while
being run with `--environment staging`). In the dashboard the branch selector is a combobox whose filter
on "staging" matched **both** `staging` and a `codex/staging-…` feature branch, with the feature branch
focused FIRST — so pressing Enter on the filtered list points staging at a feature branch, with nothing
afterwards to notice. Read the highlighted row before committing, and **re-check production's own
connected branch immediately afterwards**: that is the 2026-08-13 failure mode, and the click is made
next to a Disconnect control.

**Nothing is half-changed in the meantime:** production is gated and proven, staging is exactly as it
was that morning, no false alarm is armed, and the branch is maintained and waiting.

On production, a merge is no longer the deploy; a merge **plus a green check suite on that commit** is.

🔴 **SO DO NOT POINT `CI_RUNNER` AT `self-hosted` WHILE ZERO RUNNERS ARE REGISTERED.** `ci.yml` resolves
every job's `runs-on` through `${{ vars.CI_RUNNER || 'ubuntu-latest' }}` (four jobs), and a label with
no online runner does **not** fall back to GitHub's — the job QUEUES. On `main` that means CI never
concludes, and under the production gate above **a deploy that never concludes never happens**: no red
check, no alarm, nothing to read, until Railway abandons it at the two-hour timeout. Measured
2026-09-27: `actions/runners` returns `total_count: 0` — there is no self-hosted runner on this
repository at all. The variable is currently **set** to `ubuntu-latest`, so the rollback is
`gh variable set CI_RUNNER --body ubuntu-latest`; `gh variable delete CI_RUNNER` also works, because
the `||` above falls back to the same value, but it leaves the variable absent rather than explicit.

**The withholding is measured, not inferred** — from GitHub's own deployment status records:

| | commit | CI | deployment | push-to-live |
| --- | --- | --- | --- | --- |
| **before the gate** | `65b8e35b9` | still running | `in_progress` 17:51:51 → `success` 17:52:32 | **41 seconds**, CI unfinished |
| **after the gate** | `198f4e216` | 18:08:36 → 18:14:14 | `in_progress` 18:08:39 → `success` 18:16:50 | **8m 11s** |

The load-bearing number is the last one: production advanced **2m 36s after CI went green**, not 41
seconds after the push. That is the dependency doing its job.

🔴 **WHAT IS STILL NOT PROVEN: a RED commit being refused.** Nobody has watched that happen — it is
Railway's documented behaviour plus the dependency demonstrated above, and no one manufactured a red
merge to `main` to test it. Say "withholding is demonstrated, refusal is not yet observed" rather
than claiming the whole guarantee.

**Why staging being gated matters as much as production.** Staging tracks `main` too, and it holds a
real production clone — real auth accounts and real payroll data, not mock data. (The owner's memory
slug `staging-is-now-mock-data-not-a-production-mirror` says the OPPOSITE of its own content; trust
the content.) Before the flip, every merge reached that data ungated in about 40 seconds; after it, still ungated,
just slower. The setting is **per environment**, so gating one never gates the other — and as the
measurement above shows, a per-environment toggle reading ON is not evidence that it ENFORCES. Check
the deploy-success time against the CI finish time, never the switch.

🔴 **THE FAILURE MODE THE GATE CREATES, and it is silent.** It fails by NOT shipping: if the check
suites do not all finish within **two hours**, Railway abandons the deployment and **nothing turns
red anywhere**. Two ways to walk into that:

- **A run that never STARTS.** A workflow file GitHub cannot compile, or a repo-wide `startup_failure`
  like the 2026-09-27 entitlement lapse, produces no verdict for the gate to wait on — so nothing
  deploys, silently. `tests/github-workflow-validity.test.ts` exists to catch the first cause on the PR.
- **`CI_RUNNER` pointed at a runner that is not there.** Since the `OMAR-GAWISH` runner was
  deregistered on 2026-09-27 there are **zero** self-hosted runners, and jobs do **not** fall back to
  GitHub's: setting `CI_RUNNER=self-hosted` makes every `main` run **queue for ever** rather than
  fail. Under the gate that is a production deploy that never happens, with no red check to notice.
  **Do not set that variable until a Linux runner is actually online.**

A **cancelled** `main` run withholds the deploy the same way, which is why §2.3's rule is never to
leave a `main` commit whose only CI run is cancelled.

**The stray second deployment target is gone.** `superb-smile / production` was deleted on
2026-09-27; the merge commit `198f4e216` produced two deployment records rather than three, which is
the proof. It mattered here because Wait-for-CI is per service and could never have gated a different
project. Account: [agents-production-hooks.md](agents-production-hooks.md).

**This restores a guarantee the platform move silently dropped.** Under Cloud Run, production
deployed from `main` *after CI passed*. Railway's GitHub auto-deploy has no such gate, so from the
2026-08-01 cutover until 2026-09-27 **every merge shipped to full traffic without anyone asking
whether it was sound** — and nothing recorded that the protection had been lost.

**Why `main`'s own run is irreplaceable.** Two facts:

- Branch protection runs **`strict: false`** — PRs need not be up to date — so a PR's green was
  measured against a merge base that may no longer exist. `main`'s run is the **only** verification
  the tree that actually serves employees ever gets. Two PRs can each pass alone and break `main`
  together.
- `next.config.ts` sets **`typescript: { ignoreBuildErrors: true }`**, so a red `main` builds,
  deploys and serves perfectly. Without this run, nothing detects it at all.

Measured 2026-09-27 across every run of the month: `push` to `main` is **39.5% of `ci.yml`'s
billable minutes** (~$197 of a ~$559 month). That is the price of the gate, not waste to reclaim — see
[ci-self-hosted-runner.md](ci-self-hosted-runner.md) for the full split and for the lever that makes
those minutes cost nothing.

### 🔴 The four failure modes

1. **The two-hour timeout SKIPS the deploy, with nothing turning red.** If the check suites have not
   all finished within two hours, Railway abandons the deployment. A run stuck `queued` therefore
   means production never receives the commit and **no check is red anywhere** — observed live
   2026-09-27, when `88f86ee57`'s `main` run sat `queued` for over an hour. `deploy-drift-check.yml`
   (every 30 min, Telegram) is the alarm, and its message now names this cause first.
2. **Any workflow on the commit can hold the deploy, not just `ci.yml`.** Railway waits on every
   check suite on that commit. A main push may also trigger `staging-migrate.yml`,
   `apps-script-push.yml`, `mobile-ota.yml` and `sync-railway-production-secrets.yml` — all
   path-filtered, so most commits trigger only `ci.yml`. But **a failed staging migration now
   withholds a production deploy**, and so would expired Google credentials in the Apps Script push.
   `mobile-ota.yml` is safe by construction: without `EXPO_TOKEN` its steps are *skipped*, not
   failed, and Railway ignores a skipped run.
3. **A CANCELLED run blocks the deploy** unless another run on the same commit succeeded. This is
   why `ci.yml` groups `main` by **commit** and never cancels — a setting that now has three
   independent reasons to stay.
   🔴 **NEVER LEAVE A `main` COMMIT WHOSE ONLY CI RUN IS CANCELLED — and that means the usual
   recovery for a stuck run is the exact wrong move here.** Measured on `88f86ee57` (the #4527
   merge) on 2026-09-27: its `push` run was created 14:15:16, sat **queued for 21m41s** because
   `CI_RUNNER` pointed at a runner that could not serve it, and was **cancelled** at 14:36:57; a
   `workflow_dispatch` was fired 5 seconds later at 14:37:02 and succeeded. Under the gate that
   commit deploys **only because** that dispatch followed. Cancel the stuck run and walk away and
   the commit's only run is `cancelled`, so Railway withholds the deploy and abandons it at the
   two-hour timeout **with nothing red anywhere**.
   So: prefer fixing the cause and `gh run rerun <id>` on the push run itself, which keeps
   `event=push`. If you do cancel, you **must** then produce a succeeding run on that same SHA — on
   `main` a dispatch is a legitimate way to do it, because `main` is not gated by a PR and the
   `statusCheckRollup` caveat does not apply there. What you must never do is dispatch onto a **PR**
   branch, where the run cannot reach the rollup at all.
4. **`railway variables --set` bypasses the gate entirely**
   ([railwayapp/cli#640](https://github.com/railwayapp/cli/issues/640)) — setting a variable
   redeploys *ungated*. Treat a variable change as an unverified deploy.

### Reading it

`/api/healthz` `revision` is the only answer to "did it ship?". A merged PR and a green check are now
**necessary but not sufficient**, so reading the merge is worse than useless here.
`gh run list --workflow=ci.yml --branch main --limit 3` shows whether the gate is holding.

### Turning it off

The toggle is in the Railway dashboard — service settings, per environment. **It is not exposed by
the CLI** (`railway service` offers only
`list/delete/link/source/status/logs/redeploy/restart/scale/files`) or by any documented public API,
so it cannot be scripted and it will never appear in a diff here.

**GCP is dead, not standby.** Billing account `01BDEA-A20B4C-CC568F` was closed 2026-08-01 over an
unpaid balance; every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`.
**The Cloud Run deploy path was DELETED on 2026-09-08** at the owner's instruction, having been
trigger-disabled since 2026-08-01 and unable to run at all since billing closed. Five files went
together, because they were one cluster and nothing outside it used any of them:
`.github/workflows/deploy-cloud-run.yml`, `.github/workflows/deploy-cloud-run-staging.yml`,
`cloudbuild.yaml`, `scripts/cleanup-stale-cloud-run-tags.py` and `scripts/retry-transient.sh`.

🔴 **TO RESTORE IT, IF BILLING EVER REOPENS — the rollback the deleted headers carried, kept here
because they are no longer around to carry it.** Every file is intact in git history at `86d6220aa`,
the last commit holding them: `git show 86d6220aa:.github/workflows/deploy-cloud-run.yml`, and the
same for the other four. Their triggers were the whole rollback — re-add `schedule: - cron:
"0 */2 * * *"` to production and `"40 3 * * *"` to staging. **But restoring the workflows alone
would not be enough:** GCP deletes a disabled project's resources roughly 30 days after closure and
closure was 2026-08-01, so the Cloud Run service, its secrets and the scheduler jobs would have to
be recreated first.

`scripts/setup-gcp-cron.sh` was deliberately KEPT. It stopped being the schedule source of truth
when GCP died, but five live files still cite it for where a scheduling window originally came from
— including `src/lib/crm/dates.ts` and `tests/crm-live-sync-window.test.ts`, where the in-code gate
is what actually decides a firing. Deleting it would strand those citations.

Do not run `gcloud` to verify anything.

## Branch Model

| Branch | Purpose | Deployment |
|---|---|---|
| `main` | Production only | **Ships to production immediately on merge**, at full traffic |
| feature/task branch | Active development | No live deployment — verified via CI and local testing |

Never push directly to `main`. Work happens on a branch/PR and merges after CI passes.

## Deployment Workflow

1. Develop on a branch/worktree, open a PR to `main`.
2. `.github/workflows/ci.yml` runs on the PR — five jobs: `validate`
   (routes/migrations/sql-backups/deductions/stale-domain checks, build, and a Playwright
   login smoke test run against the built app **inside the CI runner**, pointed at the staging
   Supabase project — it does not deploy or hit any live preview URL), `lint`, `typecheck`,
   `test` (the unit suite, split out of `validate` on 2026-09-17) and `mobile` (`npm ci` plus a
   typecheck inside `mobile/`, added 2026-09-18 and seconds long on a PR that leaves that folder
   alone). The smoke test used to be a separate `preview-smoke` job; it now runs as a step inside
   `validate`, so there is no separate job to wait on.
3. Do **not** run a local full validation before pushing — those PR checks are the gate, and they
   are the same steps. See AGENTS.md § 7.
4. **Apply any database migration by hand BEFORE the merge.** The Railway deploy applies none. See
   "Database Deployment" below.
5. Merge to `main`. **The merge is the deploy.** Railway builds and ships the new commit to
   production at **full traffic**, within minutes. There is no staged rollout, no no-traffic
   revision, no post-deploy smoke test, and no cron wait — nothing stands between the merge and
   employees using it.

> ⚠️ Branch protection does gate the merge itself: 4 required status checks (`validate`, `checks`,
> `mobile`, `secret-scan`) must be green on the PR head commit, with
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

**One command reads all of it** — the PR's state and merge sha, the production deployment rows with
their real states, the live revision and whether it contains that merge, and `main`'s own CI verdict
for it:

```bash
node .claude/skills/ship/verify-shipped.mjs <pr>
```

That is the proof half of the `ship` skill (`.claude/skills/ship/SKILL.md`), which carries the whole
merge sequence and the traps inside it; `--selftest` checks its verdict table.

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

**Full job inventory. Re-read live 2026-08-29 — 23 jobs, 18 enabled;** the table below lists the
long-standing ones and not every job in the account. This is a
snapshot of a place nobody can see from git, so re-read it rather than trusting the age of this
table. Times are Cairo, as the account is set to `Africa/Cairo` throughout.

| Job | Schedule (Cairo) | Endpoint | Purpose |
|---|---|---|---|
| `phoenix-notify-daily` | 6:36 AM daily | `/api/notifications/daily` | Birthdays, contract renewals, vacation/marketing/outstation SLA, recruitment, resignation SLA, weekly-plan drift, Telegram HR digest |
| `phoenix-marketing-field-capture-nudge` | 6:50 AM daily | `/api/cron/marketing-field-capture-nudge` | Tells each rep which of their marketing customers still show a validated status with no field capture behind them (**new 2026-08-29** — split off `phoenix-notify-daily`, which it had pushed past the 30 s cap) |
| `phoenix-marketing-invoice-overdue-nudge` | 7:05 AM daily | `/api/cron/marketing-invoice-overdue-nudge` | Tells the requester, and finance, that an approved marketing request's invoice has passed its deadline (**new 2026-08-29**, owner: "the requester and finance"). In-app/Telegram/push only, never email. cron-job.org job `8350529`, created 2026-08-29 |
| `phoenix-distributor-upload-overdue-nudge` | 7:20 AM daily | `/api/cron/distributor-upload-overdue-nudge` | Tells Super Admin and the SFE Manager which distributor files for the month just closed are later than that same distributor's own file was last month (**new 2026-09-03**; owner asked directly and answered "sfe" and "You + Super Admins"). Judges each distributor against **its own** previous arrival day rather than one company-wide deadline — July 2026's files landed across ten days, so a single deadline would nag ten on-time distributors to catch the one that is genuinely late. In-app/Telegram/push only, never email. Silent once the period is locked, and silent while a month is merely incomplete. cron-job.org job `8375333`, created 2026-09-03, watched by `phoenix-distributor-upload-overdue-nudge` |
| `phoenix-retention-risk-sweep` | 7:40 AM daily | `/api/cron/retention-risk-sweep` | Flags **Medical Reps only** (owner, 2026-09-07) who have **not been seen since**: three or more consecutive **working** days of recorded leave, or three or more with no CRM entry of any kind (**new 2026-09-07**; owner instruction, recipients picked by him: HR Operations, HR Advisory, Super Admin, SFE Manager, plus the subject's own line manager per alert). Exists because payroll pays Part 1 at the start of the month and Part 2 the day after and people collect both and resign — 23 of 59 recorded resignations land in the first ten days of a month. Managers are excluded from the CRM half on purpose: a rep logs the visit and tags the manager. In-app/Telegram only — email was in the first cut and the owner removed it in review 2026-09-07 ("remove email keep in-app and telegram"), because the alert names a colleague as a possible resignation risk and email leaves a durable copy of that in four inboxes; never push, for the lock-screen version of the same reason. One announcement per streak, keyed on the streak's start date. cron-job.org job `8397172`, created 2026-09-07 on the owner's go-ahead, watched by `phoenix-retention-risk-sweep` |
| `phoenix-retention-risk-pre-payroll` | 7:45 AM on the 25th | `/api/cron/retention-risk-pre-payroll` | The pre-payroll "take care, HR" digest: one message listing everybody currently flagged, sent with working days still left before Part 1 pays (**new 2026-09-07**). The owner asked for this **and** a second notice when Part 1 is confirmed in the wizard, so `confirmPart1` fires its own; the two carry different `reason` values in the idempotency key and neither suppresses the other. Sends even when nobody is flagged — a notice that only appears with bad news cannot be told apart from one that has silently stopped working. cron-job.org job `8397174`, created 2026-09-07, `mdays=[25]` so it fires on the 25th only — read back from the API, because a daily copy of this notice would nag HR every morning |
| `phoenix-mailbox-offboarding-sweep` | 8:15 AM daily | `/api/cron/mailbox-offboarding-sweep` | Re-alerts Super Admin and HR Operations about leaver mailboxes whose Turbify revocation is still open, with the age of each (**new 2026-08-29**). In-app/Telegram only, never email — the owner has not been asked who would receive it. Turbify publishes no email API, so this watches the **register**, never the mailbox itself. cron-job.org job `8350624`, created 2026-08-29, watched by `phoenix-mailbox-offboarding-sweep` |
| `phoenix-territory-restamp` | 3:20 AM daily | `/api/cron/territory-restamp` | Re-derives every **open** period's Source-of-Sales geography, so the owner's "all sales attribute to today's geography" rule holds without anyone pressing the Drilldown's Sync button. **Published closings are never touched** — publishing does not freeze a closing's figures, so re-stamping one would move numbers under a report already sent. Notifies nobody; its trace is the `syncTerritoryData` audit row plus a `territory_restamp_applied` INFO log on any run that moved rows. Code merged 2026-08-29 (#2699) but **scheduled only on 2026-08-29** — it had never run in between. cron-job.org job `8350721`, watched by `phoenix-territory-restamp` |
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
| `phoenix-ireports360-sync` | 9:07 / 12:07 / 19:07 daily | Superseded by the in-process poller, which runs the same rolling 10-day sync itself and pings the same `phoenix-ireports360-sync` check. The route also captured probation double-visit days; nothing did from 2026-08-16 until the poller took that over on 2026-09-13 |
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
