# Deployment

## Infrastructure

Phoenix Workforce is deployed on **Railway** with a Supabase PostgreSQL backend. Hosting moved
here from GCP Cloud Run on **2026-08-01**, when the GCP billing account was closed. Vercel is
legacy/decommissioned and predates both (see `docs/disaster-recovery-runbook.md` § Vercel
retirement).

| Component | Service | Notes |
|---|---|---|
| Application hosting (production) | **Railway** | Project `Phoenix-HR-Workforce`, service `phoenix-people-workforce`, region `europe-west4-drams3a` (Amsterdam, EU West) — colocated with the Frankfurt Supabase project on purpose; **must stay in Europe** if re-platformed |
| Background jobs (production) | **Railway** | Service `phoenix-workforce-worker`, same project, same image, `europe-west4-drams3a`, one replica — `https://phoenix-workforce-worker-production.up.railway.app`. Runs the live CRM poller and the cron routes that do heavy work, so the website never freezes under them. See "The worker service" below |
| Application hosting (staging) | **Railway** | Same project and service, environment `staging` — `https://phoenix-people-workforce-staging.up.railway.app`, also `europe-west4-drams3a`. Tracks `main` and uses the staging Supabase project; see "Staging Environment" below |
| Database + Auth | Supabase | Separate production (`ozucdzovmcqvepbozvqf`) and staging (`cifwmndunmlxjhyjugxa`) projects |
| Scheduled jobs | **cron-job.org** (third-party, outside this repo) | See "Cron Jobs" below |
| Email delivery | Resend | — |
| Error monitoring | Self-hosted (`app_error_events` + Railway logs) | See [observability.md](observability.md) |
| Attendance agent | Local Windows machine | — |
| Rep-tablet management + remote screen | **Railway** (the same project) | Services `phoenix-headwind` (custom domain `mdm.satopharma.com`) and `headwind-db-eu` (Postgres), both in `europe-west4-drams3a`. 🔴 **The region is NOT inherited from the project — this row used to say it was.** A new Railway service in this account is created in `sfo`, so both ran in the United States until they were moved on 2026-09-28; the old `sfo` database `headwind-db` was deleted the same night, so `postgres.railway.internal` no longer resolves. Moving one takes `railway service scale europe-west4-drams3a=1 <old-region>=0` — the old region must be named `=0` in the same command or the call ADDS a region and leaves two live copies. 🔴 **This replaced a rented VPS on 2026-09-25 at the owner's instruction — no box is rented, and one should not be sought.** Its image is **built, not pulled**: Root Directory [`infra/headwind-phoenix-actions/`](../infra/headwind-phoenix-actions/) (see its `railway.toml`) extends the pinned image with the add-on carrying lock, lost mode, factory reset and screen-lock reset; on the stock image those four refuse. 🔴 **Watch Paths must stay `infra/headwind-phoenix-actions/**`** — without it every merge to `main` rebuilds the MDM server and a hundred tablets lose their check-in channel. The remote screen uses RustDesk's **own free EU relay** — no server at all. Nothing in CI builds or starts it; Railway deploys it on a push that touches those paths, and Phoenix otherwise only talks to it over HTTPS. [`docker-compose.headwind.yml`](../docker-compose.headwind.yml) is kept deliberately as the self-hosted path for the day the company wants to own the relay — Railway allows one TCP proxy port per service and no UDP, while RustDesk's ID server needs 21115–21119 TCP plus 21116 UDP. Ships dark — with `HEADWIND_MDM_*` unset, Rep Tablets is unchanged. See [devices/headwind-rustdesk.md](devices/headwind-rustdesk.md) |

Railway is **GitHub-connected**: it deploys from this repo on push to the default branch, **gated on
that commit's CI** (see "The deploy gate" below). There is no deploy workflow in
`.github/workflows/` that ships production any more.

## The base image is pulled from AWS's mirror, not Docker Hub

**Measured 2026-10-09, 20:58-21:10 Cairo.** Four merged PRs — #5711, #5712, #5713 and #5714 — sat
undeployed with production serving `e2f05f903`, and **every check suite on every one of them was
`completed/success`**, so none of the §2.3 deploy-gate tells applied. Railway had tried: the
production deployment for `d7d862603` existed and read **FAILED**, as did staging's for the same
commit in the same second. The build log named the cause in one line:

```
[ERRO] [internal] load metadata for docker.io/library/node:24-alpine
Build Failed: ... 429 Too Many Requests
```

Docker Hub rate-limits **anonymous** pulls per IP, and Railway's Metal builders share one. The build
dies at metadata resolution, **before a single layer is built**, so no layer cache helps and a
`railway redeploy` repeats it verbatim — which it did, 34 seconds after the first retry.

The fix is one line: `public.ecr.aws/docker/library/node`, Docker Hub's own official mirror on AWS
ECR Public — the same upstream image, the same tags, no anonymous pull limit. Verified from this
machine before shipping: an anonymous token against `public.ecr.aws` returned **HTTP 200** for the
`24-alpine` manifest.

🔴 **The parser cannot see this.** `scripts/check-dockerfile.mjs` is a Dockerfile parser and
`FROM node:24-alpine` parses perfectly, so rule 8 of `tests/railway-deploy-config.test.ts` pins the
REAL file instead, in the required `validate` job: **every** external `FROM` must start
`public.ecr.aws/docker/library/`, there must be at least one (so the rule cannot quietly assert
nothing once the stages are renamed), and the Dockerfile must keep the words `429 Too Many Requests`
— because without the 429 written down the next reader sees an oddly long registry path and
shortens it, which is exactly the change the rule exists to stop. It is anchored on `^FROM`, so the
incident note in the Dockerfile's own comment can quote `docker.io/library/node:24-alpine` without
satisfying or breaking it. All three were broken on purpose and seen to fire.

The `24-alpine` tag is the **same image** on every mirror: Docker Hub, `mirror.gcr.io` and
`public.ecr.aws` all answered digest `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1`
on the night of the outage.

## The deploy gate

> 🔴 **This gate ENDED on production on 2026-10-19/20: Wait for CI is OFF on `phoenix-people-workforce` (19 Oct) and `phoenix-workforce-worker` (20 Oct), and a commit is held by `/api/readyz` and ci.yml's `release-gate` job instead — see "The release gate — Railway builds while CI runs", below.** Everything in this section about a suite withholding a deploy is the account of the regime before that, and of what a service whose `checkSuites` is switched back ON would do.

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
carries CI-green commits (`staging-branch-sync.yml`, #4552) — **that branch worked, and Railway did
not follow it either: see the next subsection before describing staging as gated by anything.**
🔴 **RETIRED 2026-10-14 (owner, cost cuts): the sync workflow and its guard test are deleted** — the
`staging` branch had no consumer (staging tracks `main`, `STAGING_TRACKS_BRANCH` is unset) and the
workflow billed 57 minutes on 13 Oct for nothing. The remote `staging` branch is left as it is. Measured by one session and re-verified independently against the deployment `statuses`
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

🔴 **RE-MEASURED 2026-09-28, A DAY LATER, ON THREE CONSECUTIVE MERGES — UNCHANGED, SO NOT A
TRANSIENT.** The support follow-up rests on this set, and it is stronger than the pair above in three
ways: it is three for three, every timestamp is GitHub REST API (no dashboard, no `railway` CLI), and
it pins the trigger.

| commit | merged | staging deploy CREATED | staging `success` | `main` CI concluded | `staging` branch reached it |
| --- | --- | --- | --- | --- | --- |
| `7a6a6438e` | 20:52:14Z | 20:52:20Z (**+6s**) | 20:54:37Z | 20:57:16Z | — |
| `bad302365` | 20:53:47Z | 20:53:53Z (**+6s**) | 20:56:32Z | 20:59:15Z | 21:00:15Z |
| `58947898d` | 21:00:41Z | 21:00:47Z (**+6s**) | 21:03:28Z | 21:05:59Z | 21:06:25Z |

**The +6 seconds is the tell.** A staging deployment record appears six seconds after every merge, the
same second as production's, which pins the trigger to the push to `main` and nothing else. And in both
rows where the sync is visible, `refs/heads/staging` reached the commit **6m 22s and 5m 38s AFTER the staging
deployment already existed** — a deployment cannot originate from a branch that does not yet contain the
commit. That ordering is the one proof that survives anyone doubting a dashboard or a CLI reading.

🔴 **THE EXPOSURE, STATED AS A NUMBER: STAGING SERVES UNVERIFIED CODE FOR ROUGHLY 2m 30s – 2m 45s
AFTER EVERY MERGE.** Measured 2m 39s, 2m 43s and 2m 31s, in the row order above. Staging is a clone of
production and holds real employee and payroll data (§3), so that window is a real exposure and not a
cosmetic defect — which is the reason the ticket is open rather than filed and forgotten.

🔴 **CONVERGENCE HIDES ALL OF THIS, SO MEASURE AT A MERGE, NEVER AT REST.** Minutes later `main`, the
`staging` branch and both serving revisions were one commit (`bc049b3e4`), and every reading then looks
consistent with staging following the branch. The only readings that distinguish the two are taken
while a commit's CI is still in flight. **A converged snapshot is not evidence either way.**

**The branch itself was healthy and was not the problem (history — the workflow is deleted, see above).** `staging-branch-sync.yml` ran five times,
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

🔴 **A SELF-HOSTED RUNNER ON `main` WOULD BREAK THIS GATE SILENTLY, WHICH IS WHY `main` CAN NO LONGER
USE ONE.** A job whose label matches no ONLINE runner does **not** fall back to GitHub's — it QUEUES.
On `main` that means CI never concludes, and under the gate above **a deploy that never concludes
never happens**: no red check, no alarm, nothing to read. The repo-wide `CI_RUNNER` variable that made
this reachable was retired on 2026-09-28; all six `runs-on` lines now compute the runner and require
`github.event_name == 'pull_request'` plus a `ci-runner/` branch name, so `main`, a `workflow_dispatch`
and every ordinary PR are hosted by construction. The label is also never hard-coded — an unset
`CI_RUNNER_LABEL` means hosted — because the ten runners registered here (three online) all carry the
same four labels and none distinguishes a host. Kill switch:
`gh variable set CI_SELF_HOSTED --body off`. Procedure and the measurements:
`docs/ci-self-hosted-runner.md`, "Turning it on".

**The withholding is measured, not inferred** — from GitHub's own deployment status records:

| | commit | CI | deployment | push-to-live |
| --- | --- | --- | --- | --- |
| **before the gate** | `65b8e35b9` | still running | `in_progress` 17:51:51 → `success` 17:52:32 | **41 seconds**, CI unfinished |
| **after the gate** | `198f4e216` | 18:08:36 → 18:14:14 | `in_progress` 18:08:39 → `success` 18:16:50 | **8m 11s** |

The load-bearing number is the last one: production advanced **2m 36s after CI went green**, not 41
seconds after the push. That is the dependency doing its job.

✅ **A RED COMMIT BEING REFUSED IS NOW OBSERVED — 2026-09-27, and nobody had to manufacture it.** This
paragraph used to say refusal was unproven. Two merges 86 seconds apart (`2b654dd73` then `371200082`)
caught a window in which `CI_RUNNER` was pointed at a self-hosted runner for a smoke test, so both
`main` runs went red on infrastructure rather than on code, and:

```
railway deployment list -s phoenix-people-workforce -e production
  22:56:39  371200082  SKIPPED
  22:55:12  2b654dd73  SKIPPED
  22:38:01  bc049b3e4  SUCCESS   <- still serving
```

🔴 **Three things that reading corrects.** It is `SKIPPED` within **MINUTES** of the red conclusion, not
after the two-hour timeout — that timeout is the never-finishing case. **Re-running the CI green on the
same sha does NOT resurrect it:** main's head was green from 23:11 Cairo and production stayed on
`bc049b3e4`, so the recovery is the next merge or the dashboard, never `railway redeploy`. And
**GitHub's API only ever calls it `inactive`** — the identical word it uses for a healthy superseded
deploy — so the tell is an `inactive` that was never `success`; `verify-shipped.mjs` prints that as
`WITHHELD`. **Staging deployed both commits fine, which is why staging can never be the evidence here.**

✅ **AND THE RECOVERY IS NOW MEASURED TOO — the next green merge carries it forward with no click at
all.** An unrelated PR merged green and deployed `SUCCESS` at 23:35 Cairo; `/api/healthz` then answered
`1fb0e15c9`, and `git merge-base --is-ancestor` puts **both** withheld commits inside it (`2b654dd73`
and `371200082`, each `true`). Railway deploys `main`'s HEAD, so a later merge necessarily carries every
commit the gate skipped. **Nothing had to be redeployed, and `railway redeploy` would have been the
wrong move throughout.**

### The check that caused the drift it measures (2026-09-27)

🔴 **A FULLY GREEN `ci.yml` WAS WITHHELD, AND THE CAUSE WAS ONE OF THIS REPO'S OWN SCHEDULED
WORKFLOWS.** Everything above describes a red `main` CI. This is the same withhold with a green one,
and it is the shape that will fool a reader, because every instinct says to check `ci.yml` first.

On `cd9e0be03` (#4579) `checks`, `mobile` and `validate` were all `success`. The commit's check
suites held a **second** `github-actions` entry reading `completed/failure`: a **scheduled** run of
`deploy-drift-check.yml`. A scheduled run attaches its suite to whatever commit is `main` HEAD when
it fires, and Railway's gate waits on *every* suite — so the drift check withheld the deploy.

The drift check was measuring that very deploy. All times UTC:

```
22:29:46  merge cd9e0be03
22:29:49  ci.yml starts — the deploy cannot begin until it concludes
22:32:24  drift check fires; production is legitimately still the older revision
22:35:13  ci.yml GREEN — Railway is finally free to build
22:35:35  drift check concludes FAILURE (its 3-minute grace expired 22 seconds earlier)
22:35:40  deployment marked SKIPPED — five seconds later
```

Its 3-minute grace was written 2026-08-13, when a merge deployed immediately. Once the deploy became
**gated on the commit's own CI**, the deploy could no longer even *start* inside that grace — CI alone
took 5m24s here. So the false positive made itself true, and the next merge carried production
forward, which is why it went unnoticed.

✅ **THE FIX, and the counterfactual is measured rather than argued.** The check now compares against
the newest commit already older than `SETTLE_MINUTES` (15) and tests **ancestry**, not equality —
production is legitimately a commit or two behind HEAD almost always here, and equality reads that as
drift. At 22:32:24 the settled ref would have been `287872eb7`; production was already serving
`b91bd8c0c` (`success` at 22:26:03Z); `compare 287872eb7...b91bd8c0c` returns `ahead` → in sync →
exit 0 → no failing suite → no withheld deploy. Pinned by `tests/deploy-drift-settled-ref.test.ts`,
whose eight assertions were each confirmed to fire by breaking the fix.

🔴 **A THIRD CAUSE OF `WITHHELD`, AND IT IS BENIGN: SUPERSEDED, NOT REFUSED.** Measured 2026-09-28 on
`047a33388` — every check suite `completed/success`, no failed workflow anywhere, and a deployment
record carrying exactly ONE status, `inactive`, with no `in_progress` at all. A newer merge
(`75ef39135`, twenty seconds later) superseded it while it was still waiting for its own CI, so
Railway never started the older build. `git merge-base --is-ancestor` puts it inside what is serving.
**So `WITHHELD` alone is not a verdict — classify it:** a failed or cancelled suite on the commit means
the gate refused it and that is the problem case; every suite green plus a newer deployment means it
was merely superseded and production already carries it. `verify-shipped.mjs` prints which.

🔴 **AND WHAT DOES *NOT* HOLD THE GATE, measured the same night so nobody chases it:** the four
third-party app suites — `sentry`, `claude`, `vercel`, `railway-app` — are `queued` on *every* commit
and never report. `1825e0b45` and `b91bd8c0c` both reached deployment `success` with all four sitting
at `queued`. So "still queued = no deploy" is misleading: an Actions suite still **running** holds the
deploy (that is the gate working), a **failed or cancelled** one withholds it, and a third-party suite
that never reports does neither.

🔴 **THE GENERAL LESSON, worth more than this one workflow: any flaky scheduled job in this repo can
withhold a production deploy**, because its suite lands on `main` HEAD and the gate counts it. When a
deploy is missing and `ci.yml` is green, read the commit's suites before believing anything else.

🔴 **WHICH IS EXACTLY WHY IT GOES UNNOTICED.** On a busy night the withhold self-heals within minutes,
so by the time anyone looks, production is serving the commit and every reading is consistent. **The
window, not the outcome, is what to check** — `railway deployment list` for `SKIPPED`, never only the
live `revision`. A commit can have been unserved for an hour and leave no trace in what is serving now.

One caveat kept deliberately: this proves the gate on the `phoenix-people-workforce` service. Nobody
measured what the undocumented second Railway project (§2.3) did with the same two commits.

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
billable minutes** — the single largest slice after PR runs. **A share, deliberately, not a dollar
figure:** converting measured minutes into a monthly bill overstated it by ~2x and the owner's invoice
is the only authority (see the runner doc). That share is the price of the gate, not waste to
reclaim — see
[ci-self-hosted-runner.md](ci-self-hosted-runner.md) for the full split and for the lever that makes
those minutes cost nothing.

### 🔴 The five failure modes

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
5. 🔴 **THE PUSH CREATES NO CI RUN AT ALL, AND RAILWAY CREATES NO DEPLOYMENT — SO THERE IS NOTHING
   TO FIND.** The four modes above all assume a run *exists* and is queued, blocking, cancelled or
   bypassed. This one leaves **no run, no check suite, no deployment row, and nothing red** — the
   commit is simply invisible to both systems.

   Measured 2026-09-28 on `d3bd3367941157bf568324ab5932a20abd801967` (#4636, merged 16:48:45Z).
   `ci.yml`'s `push` trigger was correct and carries **no path filters**, and push concurrency
   groups by `github.sha` with `cancel-in-progress: false`, so neither config could drop a run:

   | commit | `ci.yml` push run |
   | --- | --- |
   | `07439c4de` | created 16:42:36Z |
   | `a4b0806b9` | created 16:44:36Z |
   | `d80c95a01` | created 16:46:53Z |
   | **`d3bd33679`** (merged 16:48:45Z) | **none — zero runs, zero CI check suites** |
   | `4a4dd8d3d` | created 17:03:43Z |

   Railway matched it: `railway deployment list -s phoenix-people-workforce -e production` showed
   its newest as `SUCCESS` at 19:46:51 +03:00 — the commit *before* the merge. **No deployment was
   ever created for the merge.** A single failed push-event dispatch explains both consumers missing
   it at once; that is inference, not proof, since Railway's webhook log is not visible from here.

   🔴 **THE CHECK SUITES THAT ARE ON THE COMMIT WILL MISLEAD YOU.** `d3bd33679` carried three
   `github-actions` suites, all `success` — from `Staging Branch Sync` (×2) and a `Synthetic
   Journeys` dispatch. None was `ci.yml`. `workflow_run` and scheduled runs attach to whatever
   `main` HEAD is when they fire (§2.3), so **their presence is not evidence CI ran**, and a glance
   at the commit's checks reads green. Ask for `ci.yml` by path, and count.

   **Recovery: do nothing.** The next merge carried it — `4a4dd8d3d` deployed and #4636 was live at
   20:13:05 Cairo, 24 minutes after merging, with no intervention. **Never `railway redeploy` and
   never re-merge** (§2.3). Unlike mode 3 there is no run to `gh run rerun`, and a fresh dispatch
   would not help: nothing is being held, because no deployment was ever queued.

   **The tell**, against mode 1: mode 1 leaves a deployment that is abandoned at the two-hour
   timeout. This leaves *no row at all* — no `SKIPPED`, no `inactive`, nothing in the deployments
   list to attribute. `verify-shipped.mjs` reports `NOT LIVE — merged, but the live revision does
   not contain it and no build is in flight`, which is accurate but does not name the cause; read
   `railway deployment list` to tell the two apart.

### Reading it

`/api/healthz` `revision` is the only answer to "did it ship?". A merged PR and a green check are now
**necessary but not sufficient**, so reading the merge is worse than useless here.
`gh run list --workflow=ci.yml --branch main --limit 3` shows whether the gate is holding.

🔴 **ASKING THE RUNS API WITH A SHORT SHA RETURNS `0` SILENTLY — it is not an error and not an
empty repo, it is a non-match.** Measured 2026-09-28 while diagnosing mode 5, where the question
being asked *is* "how many runs does this commit have", so a false zero reads exactly like the
fault:

```
head_sha=4a4dd8d3d                                  -> 0 runs
head_sha=4a4dd8d3d56cd2c3865af03b72fe45b621eb0a05   -> 1 run
```

Always pass the full 40-character sha (`git rev-parse <ref>`), and before believing a zero, run the
same query against a neighbouring commit as a control — mode 5 was only distinguishable from a
mistyped sha because the four commits either side each returned exactly one.

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

## Config as Code is deprecated — and the CLI's own migration command is DESTRUCTIVE here

🔴 **OWNER DECISION, 2026-10-10: THE 2026-10-01 HOLD IS LIFTED, AND BOTH APPLIES ARE DONE — APP FIRST, THEN HEADWIND**
(his words, *"lift the Railway IaC hold and plan the apply"*, then *"leave phoenix-headwind out of
the first apply"* *"apply the app-only plan when 5725 is live"* and, later the same night, *"apply the phoenix-headwind plan"*). The 2026-10-01 ruling was
*"leave the railway IaC inert for now"*; it ended on those words and **not** on the 2026-12-01
deadline, which is still a reason to ask him and never a mandate. 🔴 **Lifting the hold is not
blanket permission: every further apply is still a production infrastructure change that does not
pass the deploy gate, so each one needs his word.**
What happened and what it proved is under "The first apply, 2026-10-10" and "The second apply" below.

Railway now warns on every CLI call that `railway.json` / `railway.toml` is superseded by
Infrastructure as Code in `.railway/railway.ts`, and that **existing files keep working until
2026-12-01**. Two `railway.toml` files are in scope: the repo root (the app's `/api/readyz`
healthcheck) and `infra/headwind-phoenix-actions/` (the MDM image's builder).

🔴 **DO NOT RUN `railway config migrate --apply`. Measured 2026-10-01, its dry-run output would
delete most of the project.** It translates only the two `railway.toml` files and emits a
**whole-project** definition — and `.railway/README.md` states plainly that *"ordinary whole-project
applies can delete omitted resources"*. What it emits against what actually exists:

| | `migrate` emits | Live project (`railway config pull`) |
| --- | --- | --- |
| Project name | the **current directory's name** | `Phoenix-HR-Workforce` |
| Services | 2, named after directories | **4** — `phoenix-people-workforce`, `phoenix-headwind`, `phoenix-cron`, `headwind-db-eu` |
| Volume | none | **`headwind-db-eu-volume`, 50 GB**, mounted at `/var/lib/postgresql/data` |
| Custom domains | none | `phoenix-hr.satopharma.com`, `mdm-console.satopharma.com`, `mdm.satopharma.com` |
| Restart policy | **dropped from both** | `ON_FAILURE` / 10 on the app, `NEVER` on cron |

So applying it would drop three services — including a live Postgres and its 50 GB volume — and all
three custom domains, and it silently loses the restart policy it was migrating. Run in a worktree it
even names the project after `_wt-<task>`.

**`railway config pull` is the truthful import** — it reads the live project, lists every service, and
renders variables as `preserve()` so no secret value is written to source. Start there, never from
`migrate`.

🔴 **AND `pull` ALONE IS NOT ENOUGH: the app's healthcheck and restart policy are NOT service
settings.** They live in `railway.toml` and are applied at deploy time, so they do not appear in a
pulled file at all. A cutover that lands the pulled file and clears the Config File settings — which
is exactly what `migrate --apply` does — leaves production with **no readiness gate and no restart
policy**. Any authored file must add them to `phoenix-people-workforce` explicitly.

Measured again on 2026-10-10, and both halves of that paragraph now have a reading behind them:
`railway config pull --json` renders the live `phoenix-people-workforce` with **no `healthcheckPath`
and no restart policy at all**, while the build log of the revision then serving (`fab743655`) reads
`Starting Healthcheck / Path: /api/readyz / Retry window: 5m0s / [1/1] Healthcheck succeeded!`. So
the gate is demonstrably in force and demonstrably invisible to a pull, and `railway.toml` is what
Railway reads today — which was the answer to "is the new file live yet" on that day: it was not, and
no reading of the repo could make it so. **That changed on 2026-10-10 at 01:35 Cairo**: the apply
stored the healthcheck on the service, though not the restart policy (below).

🔴 **A PULLED AUTHORING FILE IS PERISHABLE, AND NINE DAYS WAS ENOUGH TO MAKE IT DESTRUCTIVE.** The
same 2026-10-10 read found `phoenix-people-workforce` carrying **107** variable names against the
**94** in `.railway/railway.ts` as pulled on 2026-10-01. Because variables are `preserve()` and IaC
owns variable EXISTENCE, an apply from the committed file would have **deleted thirteen live
production variables**: `RESEND_API_KEY_2`/`_3`, `RESEND_EMAIL_FROM_2`/`_3` and
`RESEND_WEBHOOK_SECRET_2`/`_3` (the sender rotation), `RECRUITMENT_APPLY_RECAPTCHA_SECRET` and its
`_MIN_SCORE`, the three `PHOENIX_TURBIFY_*` switches,
`PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD` and `NEXT_PUBLIC_SMI_USE_FACT_TABLES`. The other three
services had not drifted by a single name. The list in the file was refreshed from that read, but the
rule is the point and not the refresh: **thirteen names in nine days is the rate to plan against, so
the re-pull happens in the same sitting as the plan.** The twelve `RAILWAY_*` names the platform
injects are correctly absent — `pull` omits them.

One more thing the pull shows and the authoring file does not say: the live source carries
`branch: "main"`. That is left as the pull rendered it rather than written in by hand — an invented
field is how `migrate` lost the restart policy — but the source branch is the 2026-08-13 incident, so
confirm it in the plan output rather than leaving it to a default.

The safe sequence, for whoever does this before the deadline:

1. `railway config pull` into `.railway/railway.ts`, from a directory linked to
   `Phoenix-HR-Workforce` — **immediately before the plan, never trusting the committed list**, for
   the drift reason above.
2. Add the app's `deploy` block by hand: `healthcheckPath: "/api/readyz"`, `healthcheckTimeout: 900`
   (the window became 900 s on 2026-10-19 when the probe also became the release gate — never 300),
   `restartPolicyType: "ON_FAILURE"`, `restartPolicyMaxRetries: 10`. **A `pull` overwrites the file,
   so this step is not optional after a re-pull** — and since 2026-10-10 it is also not a step you
   can forget silently: rules 9-12 of `tests/railway-deploy-config.test.ts` assert the block, the
   absence of `watchPatterns`, the absence of a `builder` key and the Europe/one-replica placement
   directly against `.railway/railway.ts`, in the required `validate` job.
3. `npm install railway` at the repo root — the authoring file imports `railway/iac`, so this adds a
   real dependency.
4. **Run `node scripts/railway-iac-preapply-check.mjs` first** (needs `RAILWAY_API_TOKEN` +
   `RAILWAY_PROJECT_ID`). It reads each service's live variable names and **refuses, exit 1, if
   applying the committed file would delete any** — the mechanical form of the drift warning above.
   A clean run proves the re-pull in step 1 caught up; a refusal names the variables still missing
   from the file, so re-pull before going on. Then `railway config plan --out railway-plan.json`, and
   **read it**. A destructive apply in an agent session requires `--confirm-destructive`, which is
   Railway's own admission that this can delete.
5. Apply the reviewed plan only, and prefer CI: `railwayapp/config` with
   `apply --plan railway-plan.json`. **An apply is a production infrastructure change that does not
   pass through the deploy gate**, so it needs the owner's word in the same way a migration does.
6. Only then delete the two `railway.toml` files — **and prove Railway is reading the new
   configuration first**, which means a `config pull` showing the deploy block now stored on the
   service, plus one real deploy whose build log still prints `Path: /api/readyz` and whose
   `/api/healthz` `revision` moves to the merge. Then drop rules 1-5 of
   `tests/railway-deploy-config.test.ts` (which read the root toml) and leave rules 9-12, which read
   the authoring file and are what hold the line afterwards.

Two things `pull` confirmed that are worth knowing on their own:

- **`phoenix-people-workforce`'s source carried `checkSuites: true`** on 10 Oct (it reads `false` since the
  release gate went live, 19 Oct). That was the Wait-for-CI deploy gate of "The deploy gate" above, visible in
  configuration rather than inferred from behaviour.
- 🔴 **`phoenix-cron` is NOT a dormant leftover.** Its start command fires nine production routes on a
  time-of-day schedule — `notifications/process`, `cron/inbound-intake`,
  `cron/recruitment-email-intake`, the three iReports360 syncs, `notifications/daily`,
  `cron/background-jobs` — with `restartPolicyType: NEVER`, i.e. a one-shot container. An audit on
  2026-09-30 listed it as a leftover to delete; that was wrong, and deleting it would remove a
  production cron path. cron-job.org is the scheduler of record (§ Cron Jobs), so establish which of
  the two is actually firing each route before touching either.

### The first apply, 2026-10-10

Applied 01:35:05 Cairo, `phoenix-people-workforce` only, from a scratch copy of the file with
`phoenix-headwind`'s `builder` and `deploy` lines removed (his ruling: *"leave phoenix-headwind out
of the first apply"*). Plan **0 add / 1 change / 0 destroy**, identical on a re-plan the minute before,
no variable touched, no `--confirm-destructive` needed because nothing was destroyed.

- 🔴 **An apply REDEPLOYS the service.** Deployment `8416c821` went `BUILDING` nine seconds after
  the apply and rebuilt the SAME commit, so `/api/healthz` `revision` did **not** move and is not the
  proof; read the deployment's own status and its build log. Let any in-flight `main` deploy finish
  first, or the two cannot be told apart. It reached `SUCCESS` and printed `Path: /api/readyz` /
  `Retry window: 5m0s` / `[1/1] Healthcheck succeeded!`; `/api/readyz` answers 200.
- 🔴 **The restart policy is NEVER stored.** After the apply `healthcheckPath` and
  `healthcheckTimeout` read back from the service, but `restartPolicyType` / `restartPolicyMaxRetries`
  still plan as `null → "ON_FAILURE"` / `10` on every run — Railway applies them from `railway.toml` at
  deploy time. **His ruling: *"keep railway.toml until the restart policy is stored"*, so neither
  `railway.toml` was deleted then — met and retired on 2026-10-23, see "The cutover" below.** A plan that
  shows only those two lines is the expected steady state, not drift.
- `phoenix-headwind` did not redeploy on the first apply (its deployments read `SKIPPED`), so an apply
  that leaves its fields alone leaves the MDM server alone. Its `builder` was the second apply, below.
- **The second apply, 2026-10-10 01:51 Cairo — `phoenix-headwind` (his words: *"apply the phoenix-headwind plan"*).**
  Plan **0 add / 3 change / 0 destroy**, no variable touched; the apply returned exit 0 and "Changes (2)".
  It **redeployed the MDM server**: deployment `2d849e38` went `BUILDING` ten seconds later, built from
  `infra/headwind-phoenix-actions/Dockerfile` on the `headwindmdm/hmdm:0.1.9` base, reached `SUCCESS` in
  about 90 seconds, and the container logged `Starting Container` and the add-on seeding line. `builder:
  "DOCKERFILE"` now stores (the re-plan no longer lists it); only the restart-policy lines remain pending,
  on both services, which is the expected steady state. The app got a new `WAITING` deployment as well,
  held behind `main`'s CI gate like every other — an apply queues one even when the app's own fields are
  unchanged, so count deployments after an apply instead of assuming one.
- **How to run it on this machine.** `railway config plan` fails with a false "requires Railway CLI
  5.42.1 or newer" on CLI 5.59.0: the SDK runs `execFileSync(process.env._ || "railway", ["--version"])`,
  which cannot run the npm `.cmd` shim and gets Git Bash's `_`. Use PowerShell with `$env:_` set to
  the native `railway.exe` inside the npm-installed `@railway/cli` package (`bin/railway.exe`), with
  `npm install railway` done in a SCRATCH folder holding a copy of the file and `--file` pointing at
  it — never in the repo or a worktree. A `--out` plan pins `git rev-parse HEAD:.railway` of the
  directory it ran in, so plan from a checkout of the merge before any `--plan` apply.

### The cutover, 2026-10-23 — both `railway.toml` files retired

His words: *"migrate railway.json to Railway's new infrastructure-as-code before December"*. Since this
change `.railway/railway.ts` is the only deploy config: `railway.toml` and
`infra/headwind-phoenix-actions/railway.toml` are deleted, and rules 1-5 of
`tests/railway-deploy-config.test.ts` now refuse either file coming back (until 2026-12-01 Railway
would read a restored toml OVER the stored settings). `infra/phoenix-mcp/railway.toml` went too: no
service ever read it, and its settings now sit in `infra/phoenix-mcp/RUNBOOK.md`, for the day that
service is approved and declared in `.railway/railway.ts`.

- 🔴 **The 2026-10-10 ruling's condition was already met.** *"keep railway.toml until the restart
  policy is stored"*: Railway's own service settings read `ON_FAILURE` / `10` on every service
  (GraphQL `serviceInstance.restartPolicyType` / `restartPolicyMaxRetries`, read 23 Oct ~05:20 Cairo).
  The plan keeps listing them as `null → "ON_FAILURE"` / `null → 10` only because `config pull` leaves
  Railway's DEFAULT out of what it renders. Those plan lines are the steady state, not drift.
- 🔴 **What the toml really still held was the app's 900 s healthcheck window.** The service had stored
  `300` (the toml overrode it at every deploy). Deleting the toml first would have quietly shortened the
  release gate's window to five minutes, so the app-only apply that stores `900` comes BEFORE the merge
  that deletes the file.
- 🔴 **The committed authoring file had gone destructive again.** A plan from it on 23 Oct read
  **0 add / 4 change / 17 destroy**: sixteen live variables (the app's `HEADWIND_MDM_ACCESS_CLIENT_*`
  Cloudflare pass, the console's `PHX_ACCESS_*` gate, the `_4`, `_PEOPLE` and `_SALES` Resend senders,
  `SENTRY_WEBHOOK_SECRET`, `PHOENIX_DEPLOY_NUDGE`, `ANTHROPIC_API_KEY` on both app and worker) and the
  tablet server's files disk detached (`phoenix-headwind-volume`, added 22 Oct). The variable lists were
  re-pulled and the disk declared with its mount; the re-plan read **0 add / 3 change / 0 destroy** —
  the app's window `300 → 900` plus the three default restart-policy pairs. Rule 15 of the test now
  refuses a file that drops the disk or its mount.
- **The apply is app-only**, from a scratch copy with the worker's and `phoenix-headwind`'s restart lines
  left out, so the tablet server is not redeployed: with a volume attached Railway stops the old
  container before starting the new one, and the tablets lose their server for the restart
  (measured on 22 Oct, when attaching the disk took it down for about an hour behind a queued deploy).
- 🔴 **Nothing re-applies the settings at a deploy any more, so a dashboard edit STAYS — the daily `secret-drift-check.yml` now reads them.** Its third leg, `scripts/check-railway-deploy-settings.mjs`, compares what Railway stores for production — each service's healthcheck path and window, its restart policy, and every volume mount — with `.railway/railway.ts`, and names a live volume the file does not declare. Drift reaches Telegram and the job still concludes success (a red scheduled suite would withhold a deploy); exit 2, "cannot tell", is a warning, never a pass. Run it by hand with `RAILWAY_API_TOKEN` and `RAILWAY_PROJECT_ID` set. Pinned by `tests/railway-deploy-settings-drift.test.ts`.
- **The merge restarts the tablet server once.** Deleting `infra/headwind-phoenix-actions/railway.toml`
  matches its watch pattern, so the merge rebuilds `phoenix-headwind` (about a minute and a half of no
  server, with the disk keeping every APK). Prove it from that build's log (`load build definition from
  Dockerfile`), and prove the app from its own build log (`Path: /api/readyz` and a 15-minute retry window).

## Branch Model

| Branch | Purpose | Deployment |
|---|---|---|
| `main` | Production only | **Ships to production immediately on merge**, at full traffic |
| feature/task branch | Active development | No live deployment — verified via CI and local testing |

Never push directly to `main`. Work happens on a branch/PR and merges after CI passes.

## Deployment Workflow

1. Develop on a branch/worktree, open a PR to `main`.
2. `.github/workflows/ci.yml` declares three jobs that a PR could reach: `validate`
   (routes/migrations/sql-backups/deductions/stale-domain checks, the unit suite, and on non-PR
   events a build plus a Playwright login smoke test run against the built app **inside the CI
   runner**, pointed at the staging Supabase project — it does not deploy or hit any live preview
   URL), `checks` (lint and typecheck, folded into one job by #4527 on 2026-09-27 — `lint`,
   `typecheck` and `test` are STEPS from then on, never job or check names) and `mobile` (`npm ci`
   plus a typecheck inside `mobile/`, added 2026-09-18 and seconds long on a PR that leaves that
   folder alone). 🔴 **On a pull request only the first two of those actually run** — `mobile`
   carries `if: github.event_name != 'pull_request'` since 2026-09-29, and `secret-scan` in
   `security-scan.yml` lost its `pull_request` trigger in the same change (gitleaks moved into
   `bash-guard.mjs` clause C12, which refuses the push instead). So a PR's check list is `validate`
   and `checks`, which is exactly the required pair. The smoke test used to be a separate
   `preview-smoke` job; it now runs as a step inside `validate`, so there is no separate job to wait
   on.
3. Do **not** run a local full validation before pushing — those PR checks are the gate, and they
   are the same steps. See AGENTS.md § 7.
4. **Apply any database migration by hand BEFORE the merge.** The Railway deploy applies none. See
   "Database Deployment" below.
5. Merge to `main`. **The merge is the deploy.** (Railway builds at the merge, and the new container goes live when `release-gate` has recorded the checks green — "The release gate" below.) Railway builds and ships the new commit to
   production at **full traffic**, within minutes. There is no staged rollout, no no-traffic
   revision, no post-deploy smoke test, and no cron wait — nothing stands between the merge and
   employees using it.

> ⚠️ Branch protection does gate the merge itself: 2 required status checks (`validate` and
> `checks`) must be green on the PR head commit, with `enforce_admins: true`. 🔴 `mobile` and
> `secret-scan` were **demoted on 2026-09-29**, and the same change took both off `pull_request` —
> so neither blocks a merge and neither reports on a PR at all. A red Expo typecheck or a gitleaks
> finding will not stop a bad merge on your behalf; both surface on `main`, a schedule or a dispatch
> instead, which is a fix-forward. That list has rotted five times (4 → 5 → 6 → 4 → 2): read
> `branches/main/protection/required_status_checks` live and count passes against what it returns,
> never against this line. So a merged commit has passed the two checks that gate. But CI passing is
> the *only* gate — once merged, it serves live traffic. **Never merge anything you are not willing
> to have serving employees within minutes.**

The old Cloud Run pipeline did deploy a no-traffic revision, smoke-test it, and only then promote
it to 100%. That safety net is **gone**. Any doc, comment, or memory describing it is pre-cutover.

## A slow day is measured from the build log

Measured on 2026-10-16 after the owner said "Railway is very slow today". Railway's status page and
githubstatus.com were clean and the live site answered in 0.3-1.0 s; the merges did go live later, for
four separate reasons that stacked. Read each from its own source, never from one headline number.

- **True go-live is the `Healthcheck succeeded` line of the deploy's build log**, not GitHub's
  deployment `success`: `railway logs -b <deployment-id> -p Phoenix-HR-Workforce -e production -s
  phoenix-people-workforce --json` (pass `-p/-e/-s` from a worktree, which is not linked; on Windows
  spawn it from node with `shell: true`). GitHub's status lagged the app already serving by 4.3 and
  16.9 minutes on two deploys that day, and by nothing on the 114 before, all after the second Railway
  service (`phoenix-workforce-worker`, same repo and sha) was created. Cause unproven.
- **Baseline, push to serving (median):** 8.5 min on 13 Oct, 9.1 on 14 Oct, 8.5 on 15 Oct, 9.8 on 16
  Oct. Main CI before Railway starts: 5.4, 5.6, 5.2, 6.6 min. Railway scheduled-to-healthy: about
  2.9 min, flat.
- **The unit-suite step of `checks` swings 170-190 s against 220-320 s on the same GitHub-hosted
  `ubuntu-latest` runner** (runner variance, not a code change) and is most of the CI difference.
- **The Sentry source-map plugin adds about 40 s to every FRESH Railway build** (162 s to 202 s, n=12 and
  n=14; the upload step is about 25 s). Compare fresh builds only: a cached rebuild of one sha takes
  about 40 s and skews any all-builds median (the first comparison said +64 s and was wrong for that
  reason).
- **A scheduled run holds a deploy.** A `schedule:` run attaches its check suite to whatever commit is
  `main` HEAD when it starts, and Wait for CI holds that commit's deploy until the suite ends. On 16 Oct
  the daily Security Scan (Semgrep step alone 572 s) started at 12:45 Cairo and held a deploy about 9
  minutes. GitHub starts these crons 4.5-9.5 hours after the minute requested, so the request was moved
  from 05:17 to 20:17 UTC; merges to `main` per Cairo hour since 2 Oct run 3.4-3.8 at 22:00-00:00 and
  0.74-1.35 at 04:00-07:00. Whether the late start follows the new request is unproven: read the start
  times with `gh run list --workflow security-scan.yml` after a few days, and if they still fall after
  08:00 UTC, dispatch it from cron-job.org at a chosen quiet minute instead.
- **A build that fails only when a Sentry token is present reaches production green.** PR builds carry
  no token, so on 16 Oct 13:12-13:57 two merges never deployed (`withSentryConfig is not a function`:
  the plugin lives at `@sentry/nextjs/config`, not the package root) and the fix took about 23 minutes.
  `tests/sentry-production-only.test.ts` now loads `next.config.ts` through Next's own loader with a
  dummy token, so a plugin that cannot load fails the PR instead.

## The release gate — Railway builds while CI runs

Built 2026-10-19 on the owner's instruction *"speed up the Railway deploy"* and his question *"which is
faster and costs less"*. It replaces Railway's **Wait for CI** as the thing that stops an unchecked commit
going live, so the build no longer waits for the checks to START.

**Why.** Measured on the merge of #6163, 19 Oct 2026 (UTC): pushed 16:41:05, every check finished 16:46:12,
Railway's build **scheduled 16:46:28** and the app answered from the new commit at **16:57** — about 16
minutes, five of them checks and ten and a half Railway's build, on a day its shared builder was slow (that
build reached "Finalizing page optimization" 6 min 57 s after it was scheduled, against 2 min 44 s on an earlier one). Wait for CI made the two add up. They
should overlap: the merge then reaches production when the SLOWER of the two ends.

**How it works.**

1. With Wait for CI off, Railway starts the build the moment a commit lands on `main`.
2. `app/api/readyz` — Railway's deploy healthcheck since 2026-09-30 — answers **503 until a row for the
   container's own commit exists in `public.release_gates`**
   (`src/lib/platform/release-gate.ts`, the read in `release-gate-store.ts`). Railway keeps the OLD version
   serving until the probe answers 2xx, and marks the deploy failed if it never does within
   `healthcheckTimeout` (900 s since this change; `.railway/railway.ts` since the 2026-10-23 cutover).
3. The last job of `ci.yml`, **`release-gate`**, writes that row. It runs on a push to `main` only, needs
   exactly the required pair (`validate`, `checks`), uses `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` (the secret
   `migration-drift-check.yml` and `synthetic-journeys.yml` already use) and reads the row back before it
   passes. A red check means no row, so the new container never takes traffic and the old one keeps serving.

**Nothing is skipped.** Every check still runs on every merge and a commit still cannot go live without all
of them. What changes is that the build is no longer idle while they run.

**What the probe does and does not hold.**

| Container | Gate |
|---|---|
| Production on Railway, git commit known | **Held** until its row exists. An unreadable table is NOT ready (fail closed). |
| Urgent `railway up` upload (`public/urgent-deploy.json` present) | Never held — it skips the checks by the owner's own words. |
| `PHOENIX_RELEASE_GATE=off` | Never held. The emergency switch; only the exact word `off` counts. |
| Anything that is not production on Railway (laptop, CI, staging) | Never held — nothing writes a row for it. |

The table is never pruned: a container that restarts weeks after its deploy asks again, and a pruned row
would fail that restart.

**What it replaces, and what that changes.** Wait for CI also withheld a deploy for any failed or queued
suite on the commit, scheduled workflows and Dependabot included (`engineering-deploys` rules). With the gate
the deploy depends on exactly `validate` and `checks`. A red `mobile` job, a scheduled Security Scan that
happens to attach to `main` HEAD, or a failing `staging-migrate` no longer holds production; each still
shows red where it always did. That is the intended narrowing, not a loss: those suites were never the
checks the owner asked for, and the nine-minute hold on 16 Oct came from one of them.

**The order it went live in, and what each step proved — 19-20 October 2026 (the order to repeat if a
trigger is ever switched back on and off again).**

1. Apply the `release_gates` migration to production BEFORE the merge (the deploy applies none). Done through
   `apply-sql-file.mjs` after the production MCP declined it; the table was read back by shape.
2. Merge (PR 6166, with Wait for CI still ON). That first deploy proved the gate: live `/api/readyz` read
   `checks.releaseGate` = `{required: true, passed: true, reason: "recorded"}`, and the build log printed
   `Retry window: 15m0s` and `Healthcheck succeeded`.
3. On the owner's word, switch Wait for CI off — one `deploymentTriggerUpdate` per service (app trigger
   `d0cc31dc`, worker trigger `47c42ce8`), never a whole-project `config apply`, whose variable list goes stale
   in days. The app went first (19 Oct). 🔴 **The worker had NO healthcheck at all** (`healthcheckPath: null`
   at service level; `railway.toml` is what gave the app its probe), so the gate could not have held it:
   its probe (`/api/readyz`, 900 s) was set on the service on 19 Oct, its next builds showed `Path: /api/readyz`,
   `Retry window: 15m0s`, `Healthcheck succeeded`, and only then was its trigger switched off (20 Oct).
   `.railway/railway.ts` says the same for both.
4. Measured on the first merges with the app's trigger off (19 Oct, `3f207be29` and `085d869d1`): live 6 min 06 s
   and 7 min 51 s after the push — each 10-18 s after `ci.yml`'s last job, because the build now finishes first
   and the gate holds it. Under Wait for CI the same merges took 8.5-9.8 min on a normal day and 16 min on 19 Oct.
   Read the build log's `Healthcheck succeeded` line, per "A slow day is measured from the build log"; an overlap
   that is working shows `readyz` answering 503 `not_recorded` for a
   while and then 200.

🔴 **NEVER HAVE BOTH GATES OFF.** Wait for CI off AND `PHOENIX_RELEASE_GATE=off` means every merge goes live
the moment it builds, with nothing red anywhere. The switch exists so a broken gate cannot strand a hotfix;
turn Wait for CI back on in the same breath as setting it. The urgent route needs neither.

**Failure modes, and what to do about each.**

- **CI red.** No row, the container answers 503 for the whole window, Railway marks the deploy failed and
  the old version keeps serving. Do nothing; the next green merge carries it.
- **GitHub slow enough that CI outlasts the window** (19 Oct: results recorded 13 to 18 minutes late). The
  container fails its window while CI later goes green. Same recovery — the next green merge carries it. A
  Railway redeploy of that deployment would pass once the row exists, but that has not been tried, and
  `railway redeploy` is otherwise forbidden here.
- **The row cannot be written** (secret rotated, Supabase down). `release-gate` is red and loud; nothing goes
  live. Fix the secret or wait; this is the closed answer on purpose.
- **Two merges close together.** Each container waits for its own row; the newer one that passes becomes the
  active deploy and the older is superseded, as with any queue here.
- **A revert or hotfix** takes exactly the same path. For minutes, the urgent route is the one that skips it.

**Rollback.** Switch Wait for CI back ON. Nothing else has to change: the gate still passes because
`release-gate` still runs and writes the row first.

**Not done, deliberately.** Building the Docker image in CI and deploying that digest: it needs a GitHub
access token for Railway to pull a private image, moves the live service off its GitHub source, and was
measured slower on a normal day (a 2-core runner against Railway's builder) and dearer (about six more runner
minutes per merge plus image storage).

## The urgent route — "live in five minutes"

Built 2026-10-18 at the owner's instruction: *"an extra route that you don't ever use except with a
keyword I tell you … the merge must be live in five minutes"*, and, when Claude Code's own safety
classifier refused the work as a CI bypass, *"yes, build the fast route that skips the checks before
going live — I accept the risk"*. **The normal route is unchanged and stays the default.**

**Why the normal route cannot do it.** Measured on 18 Oct 2026: PR checks ~6 min, then `main`'s own
checks ~5-7 min (Railway's Wait for CI holds the build until they finish), then Railway's build and
`/api/readyz` healthcheck ~3 min — **8.5-10 minutes from "merge" to serving.** Two of those three
waits are the deploy gate, and branch protection (`enforce_admins: true`) lets nobody merge past them.

**What the urgent route does.** `node scripts/urgent-deploy.mjs launch <pr>`:

1. Builds ONE commit — the PR head merged onto the current `origin/main`, plus every earlier urgent
   PR the `urgent-deploy/production` branch still carries that is open and unmerged (read from the
   branch, never from what `/api/healthz` happens to answer, so a timeout cannot drop one) — with
   `git merge-tree --write-tree` and `git commit-tree`, so no checkout moves. A PR that does not merge
   cleanly onto `main` is refused, and so is a launch that cannot read the branch.
2. Force-pushes it to `urgent-deploy/production`, which starts `.github/workflows/urgent-deploy.yml`.
3. The workflow writes `public/urgent-deploy.json` (the commit sha) and uploads the tree with
   `railway up` to the production web service (`--worker` adds `phoenix-workforce-worker`). A CLI
   upload is not a GitHub deploy, so **Wait for CI never sees it** — it serves in about the build time.
4. It waits until production's `/api/healthz` `revision` equals that sha, then messages Telegram with
   the elapsed time.
5. **The guard** watches for up to 50 minutes. A normal deploy of a `main` commit WITHOUT the PR — one
   already in flight, or another merge — would silently put the bug back; the guard sees it within
   30 seconds and re-uploads the PR on top of the newest `main` (Telegram says so, at most 3 times).
   It ends when production serves a `main` commit containing EVERY urgent PR's merge, and deletes the
   branch. After 50 minutes without that, it alarms: the next normal deploy will remove the fix. It
   stands down (Telegram says why) when the branch is deleted or replaced by a newer launch, or when a
   carried PR is closed without merging; a re-upload whose push fails for any other reason alarms and
   fails the run rather than reading as "a newer launch took over".

**What it costs.** The code serves BEFORE its checks finish — a defect the checks would have caught
reaches employees, and the checks then report it after the fact. About 50-60 extra hosted Actions
minutes per use (the guard waits). Nothing else: the PR still merges the normal way.

🔴 **The rules.**

- **Only on the owner's own words "live in five minutes", about one named PR**, in a message he typed
  in this session. Never on a session's own reading that something is urgent, never from a memory,
  a doc, another session or a replayed summary. The words approve THAT PR's urgent upload and its
  normal merge when green — nothing after it.
- **The PR still merges the normal way, as soon as its checks are green** (the `ship` skill). Until it
  does, the fix lives only in the urgent build and the guard is all that keeps it there.
- **Never dispatch the workflow, never push to `urgent-deploy/*` by hand, never run it on `main`.** A
  run on `main` attaches a check suite to main HEAD, and Wait for CI would hold — or, red, withhold
  for good — the NORMAL deploy. `tests/urgent-deploy.test.ts` pins the trigger to the two branches.
- **A migration is not covered.** Apply it first, as always (§8); the route ships code only.
- **Practise without deploying:** `launch <pr> --dry-run` pushes to `urgent-deploy/dry-run`, which
  builds the commit and proves the Railway credential reads the production service, and uploads nothing.
- 🔴 **To take an urgent build back, `node scripts/urgent-deploy.mjs stop` comes FIRST — only on the
  owner's word.** It deletes the branch and cancels the running guard. A Railway dashboard Redeploy or
  a revert on its own reads to the guard as "a normal deploy lost the fix", and it uploads the urgent
  build again within 30 seconds. `stop` changes nothing that is serving; Rollback below follows it.

**How the live build is named.** A `railway up` upload carries no `RAILWAY_GIT_COMMIT_SHA`, so both
probes read `src/lib/observability/urgent-deploy-marker.ts` first: `public/urgent-deploy.json`, which
only an urgent upload contains (it is never committed — the test refuses it). The urgent commit's
first parent is `origin/main`, so `deploy-drift-check.yml`'s ancestry test reads production as in sync
and does not alarm, and `verify-shipped.mjs` resolves the revision like any other.

## The fallback route — an image built on GitHub, for the day Railway cannot build

Built 2026-10-21 at the owner's instruction: *"i need to find a fallback way to deploy when railway is
down urgently"*. Railway paused every build on 20 Oct (20:03 Cairo, five merges unserved) and again on
21 Oct (10:17 Cairo, "Dashboard and API unavailable, builds paused", five more unserved). **Both times
the old version kept serving — only NEW code could not go live.** The normal route and the urgent route
(`railway up`) both need Railway's builder, so neither helped. This route moves the BUILD to GitHub's
runners and lets Railway only RUN a finished image, which needs no builder.

**How to use it** — Actions → "Fallback image" → Run workflow, or from a terminal:

```
gh workflow run fallback-image.yml -f deploy=none        # build, boot-test, push the image; touches nothing else
gh workflow run fallback-image.yml -f deploy=rehearsal   # + a throwaway STAGING service pulls it, then is deleted
gh workflow run fallback-image.yml -f deploy=production -f services=web          # or web,worker
gh workflow run fallback-image.yml -f deploy=restore     # once Railway builds again: back to the git source
```

`ref` defaults to `main`. It is never a push or schedule trigger: an image per merge would double the
build minutes for a route needed a few days a year. A pull request that touches the workflow, the
script or the `Dockerfile` builds and boots the image (nothing pushed), which also gives the
`Dockerfile` the pull-request build coverage `validate` skips.

**What keeps it as safe as the normal route.**

1. **The gate is not skipped.** The commit must already have a green `release-gate` job in its own
   `ci.yml` push run — the same row Railway's readiness probe waits for. Only a commit that reached
   `main` and passed `validate` + `checks` can be built for production.
2. **The image carries `RAILWAY_GIT_COMMIT_SHA`.** Railway injects it only into a build it ran itself.
   An image deploy would carry none, and `release-gate.ts` reads "no commit" as "nothing to wait for" —
   the gate would silently open. The workflow adds one `ENV` layer, so `/api/readyz` still answers 503
   until the row exists and `/api/healthz` `revision` names the commit.
3. **It is booted before it is pushed**, and `/api/healthz` must report the commit.
4. **The build values are Railway's own.** `NEXT_PUBLIC_*` are inlined into the client bundle at build
   time, so the image needs the same values Railway's build used. `build-values` reads them from
   Railway's production variables (exactly the `Dockerfile`'s `ARG` list — pinned by the test); only if
   Railway cannot be read does it use GitHub's copies, and the run summary says so. Trimmed: the GitHub
   copy of `NEXT_PUBLIC_APP_URL` has carried a leading space.
5. **`SENTRY_AUTH_TOKEN` is not passed**, so a fallback build uploads no source maps and spends no
   observability credential.

**The Railway side** (`scripts/fallback-image-deploy.mjs`, public GraphQL, introspected 2026-10-21):
`serviceInstanceUpdate(source: {image}, registryCredentials)` moves a service onto the image, then the
script waits for the new deployment and, for the web service, for `/api/healthz` to report the commit.
`restore` reconnects `Gawish-1997/phoenix-people-workforce@main` with `serviceConnect` and waits again.

- 🔴 **The source is service-level, shared by every environment** (§2.3's `source connect` incident), so
  `switch` and `restore` refuse `--env staging`: a "staging test" of a source change would change
  PRODUCTION. The rehearsal creates a service of its own (`fallback-rehearsal-<sha>`, staging only),
  deletes only what it created (re-checked by name), and `cleanup` removes a leftover.
- **The private image needs a pull credential.** With the secret `GHCR_PULL_TOKEN` (a classic personal
  access token with ONLY `read:packages`, stored by the owner himself:
  `gh secret set GHCR_PULL_TOKEN --repo Gawish-1997/phoenix-people-workforce`) Railway can re-pull the
  image for as long as the fallback is in use. Without it the run's own token is used: enough to start
  the container now, **not** enough for a later restart on another node. The production job's summary
  says which one was used. Never make the package public — it holds the compiled server code.
- **What was there before is kept**: `fallback-snapshot.json` (source and root directory per service,
  no credentials) is uploaded as an artifact for 30 days.
- **web first, then the worker**; a failed web deployment stops before the worker is touched. Railway
  keeps the previous version serving when a new deployment fails its health check. Never run two
  workers: the CRM poller keeps in-memory state (`PHOENIX_LIVE_CRM_POLL`), and the switch is a normal
  Railway deployment with the usual overlap, not a second copy.
- **A migration is not covered** — apply it first (§8), as on every route. **Railway fully down is not
  covered either**: the running container only keeps serving, and a second host with a DNS flip is a
  separate piece of work (it needs another account and a copy of the variables kept outside Railway).

**When even this fails** — Railway refusing the deploy call itself, as on 21 Oct from 10:24 Cairo ("Deploys have
been paused temporarily") — use the emergency host below; it builds through this workflow (`workflow_call`,
`deploy=none`) and runs the image somewhere else.

**What is proven and what is not.** Proven by `tests/fallback-image-deploy.test.ts` and a live read-only
run of `read` and `build-values` on 2026-10-21: the helpers, the workflow's triggers and gate, the
Dockerfile/ARG parity, and that Railway's API answers both reads during the outage. **Not proven until
`deploy=rehearsal` has run:** that Railway pulls and starts a private ghcr image with these
credentials. **Not proven until the first real use:** the repo → image → repo transition on the real
service (`restore` is the same `serviceConnect` path that repointed production in August).

## The emergency host — a standby copy on Fly.io, for the day Railway will not deploy at all

Built 2026-10-21 at the owner's instruction: *"built a fallback deployment route to relly on when railway fails
free vercel or any other option easy and user firendly"*. He picked **Fly.io in Frankfurt** and **"one button I
press"** (not an automatic switch). The trigger: from 10:24 Cairo that day Railway paused builds AND refused every
deploy call — `serviceInstanceDeployV2` answered "Deploys have been paused temporarily" for more than nine hours — so
a merged, green fix for a medical rep blocked from logging visits could not go live by any Railway route, and the
fallback route's own rehearsal was refused the same way.

**Why not free Vercel:** its free plan forbids commercial use, it cannot run this app's Docker image (a different
build from production), and Vercel is a retired platform here.

**The button** — GitHub → Actions → **Emergency host** → Run workflow (the GitHub phone app works too):

| action | what it does | users notice |
| --- | --- | --- |
| `status` | where the domain points, what Railway and the standby serve, the standby's certificate | nothing |
| `setup` | once (and after a production variable changes): create the Fly app, copy Railway's production web variables into it, get a certificate for `phoenix-hr.satopharma.com` | nothing |
| `rehearse` | run a commit on the standby, prove `<app>.fly.dev/api/healthz` reports it, stop it again | nothing |
| `go-live` | run the commit on the standby, prove it, then point the domain at it; Telegram says when it serves | the new version |
| `back-to-railway` | point the domain back (refused if Railway is not answering), wait 3 minutes, stop the standby | nothing |

**How it works.**

1. **The gate** — the same rule as the fallback route: the commit must have a green `release-gate` job in its own
   `ci.yml` push run. 🔴 **Off Railway this is the ONLY gate**: the container's readiness gate keys on
   `RAILWAY_ENVIRONMENT_NAME`, which the standby never has.
2. **The image** — the fallback route's own build (`fallback-image.yml` called with `deploy=none`, so no Railway service
   is touched), reused when `ghcr.io/gawish-1997/phoenix-people-workforce:<sha>` already exists. The job hands it to
   Fly's own registry, because Fly cannot pull the private ghcr package — never make it public.
3. **The standby** — `infra/fly-standby/fly.toml`: Frankfurt (`fra`), one `shared-cpu-2x` machine with 2 GB, health
   check `/api/healthz`. 🔴 **WEB ONLY**: `[env]` forces `PHOENIX_PROCESS_ROLE=web` (the schedulers refuse to start)
   and `PHOENIX_LIVE_CRM_POLL=false`. Railway's worker keeps every scheduler and the CRM poller — a second copy would
   run the same jobs twice against one database. Between emergencies it has **zero machines**, so it costs nothing.
4. **The variables** — `setup` copies Railway's production web variables into Fly secrets (`--stage`, values never
   printed, the temporary file removed). `scripts/emergency-host.mjs` drops every `RAILWAY_*` key and every key
   `fly.toml` forces, because a Fly secret outranks `[env]`. The copy is as fresh as the last `setup`: **re-run setup
   after changing a production variable on Railway**, while Railway's API answers.
5. **The switch** — one Cloudflare record: `CNAME phoenix-hr` holds `xok6ir4p.up.railway.app` normally and
   `<app>.fly.dev` during an emergency, unproxied, TTL 60 s (`setup` lowers it from Cloudflare's automatic 300 s,
   content untouched). The certificate is issued beforehand through an `_acme-challenge` record, so the standby can
   answer for the domain the moment the record moves. `point` refuses: a record holding anything else (a state
   nobody here set), a standby without a certificate or not answering with the commit, and a flip back to a Railway
   that does not answer. Its proof is **the domain answering from the chosen host** (Fly's `fly-request-id` header).
6. **Same address, same everything** — staff keep `phoenix-hr.satopharma.com`, so logins, emailed links and the
   cron-job.org calls follow the record.

**What only the owner does, once** (a session may not create accounts or handle these tokens):

- A Fly.io account with a card (pay-as-you-go; the standby has no machines between emergencies).
- An organisation token from the Fly dashboard → `gh secret set FLY_API_TOKEN --repo Gawish-1997/phoenix-people-workforce`.
- A Cloudflare API token with **Zone → DNS → Edit** and **Zone → Zone → Read** on `satopharma.com` only →
  `gh secret set CLOUDFLARE_API_TOKEN --repo Gawish-1997/phoenix-people-workforce`.
- Then Actions → Emergency host → `setup`, then `rehearse`. Optional repository variables: `FLY_APP` (default
  `phoenix-hr-standby`, if that name is taken on Fly) and `FLY_ORG` (default `personal`).

**What is NOT covered.** A migration (apply it first, as on every route). The worker: the workflow never deploys
it — since 2026-10-22 it runs on Fly too, deployed by hand (next section). A Supabase outage. **Not proven until `setup` and `rehearse` have run with the owner's tokens:** the Fly app,
the variable copy, the certificate, and the image booting on Fly. Pinned by `tests/emergency-host.test.ts`.

### The worker on Fly

✅ **ENDED 23 Oct 2026, Cairo — the background jobs and every deployment are back on Railway** (owner, ~04:33: *"Railway
is back — retire the all-deployments-through-Fly rule"*). 04:31:56 the Fly worker was scaled to zero; 04:31:58 Railway's
worker was set to `PHOENIX_PROCESS_ROLE=worker` and redeployed, booting `[process-role] worker` and
`[crm:live-poll] started` at 04:33:30; 04:33:32 the four cron-job.org jobs moved back to
`phoenix-workforce-worker-production.up.railway.app` (`inbound-intake` stays off); 04:35:41 `phoenix-worker-standby` was
destroyed. Read live 23 Oct ~05:17: the worker's `/api/healthz` answers from Railway, and Fly reports
`Could not find App "phoenix-worker-standby"`. `phoenix-hr-standby` is kept, stopped at zero machines, as the Emergency
host button's app. The go-live's worker step has no app to move now and fails harmlessly (`continue-on-error`). What
follows is the outage record, kept for the next time Railway cannot deploy.

From 22 Oct 2026 03:38 Cairo the background jobs ran on Fly as well (owner, choosing **"Separate worker on Fly"**).
Railway's worker was stuck on its 20 Oct deployment holding the database key that had just been switched off, and
Railway could not deploy, so every scheduler had stopped at about 02:35 Cairo.

- **The app** is `phoenix-worker-standby` (Frankfurt, one `shared-cpu-2x` machine, 2 GB). Its config is
  `infra/fly-standby/fly-worker.toml`: `PHOENIX_PROCESS_ROLE=worker`, `PHOENIX_LIVE_CRM_POLL=true`,
  `PHOENIX_HOST=fly-worker`, and **`RAILWAY_ENVIRONMENT_NAME=production` on purpose**: it is the CRM poller's host
  pin (`resolveInProcessHostRefusal` in `src/lib/crm/live-poller.ts`). It also makes the release gate **required**
  there: the image carries `RAILWAY_GIT_COMMIT_SHA` (built in by `fallback-image.yml`), so `/api/readyz` reads that
  commit's recorded gate — read live on 22 Oct: `required: true, passed: true, reason: "recorded"`. Until 22 Oct the
  file lived only in a Temp folder, which Windows empties.
- 🔴 **The go-live moves it, right after the website** (re-audit, 2026-10-22). It used to be a hand step after every
  go-live, and on 22 Oct it was missed: the website served `81a75f428` while the worker ran `65eafc9a7`, and System
  Issues — which compares every error with the *website's* build — showed every worker error as Resolved. The
  workflow's step "Move the background worker to the same commit" deploys the image the go-live just pushed and
  waits for the worker's own `/api/healthz` to report it. If it fails, the website stays live, the step is marked
  failed and Telegram says so; then, and only then, move it by hand:

  ```bash
  flyctl deploy -a phoenix-worker-standby -c infra/fly-standby/fly-worker.toml --image registry.fly.io/phoenix-hr-standby:<sha> --regions fra --ha=false --strategy rolling
  ```

  Prove it from `https://phoenix-worker-standby.fly.dev/api/healthz` (`revision`) and from the log lines
  `[process-role] worker` and `[crm:live-poll] started`.
- **Its secrets** were copied from Railway's worker through `filterVariables` (`scripts/emergency-host.mjs`), so every
  key the config forces is dropped from the copy, as on the website. **Every secret rotation must reach this app
  too.**
- 🔴 **ONE worker only.** Railway's worker was stopped (`deploymentStop`) and its `PHOENIX_PROCESS_ROLE` set to `web`,
  so a Railway redeploy can never run the jobs twice; there is no single-runner lock, and two pollers would hit one
  iReports360 account.
- **What calls it:** the four cron-job.org jobs that used to call Railway's worker address — `crm-contact-lists`,
  `process-notifications`, `recruitment-email-intake` and `inbound-intake` — now call
  `phoenix-worker-standby.fly.dev`. Every other job calls `phoenix-hr.satopharma.com`, so it follows the website.
- **Moving back to Railway is one change, in this order:** stop the Fly worker
  (`flyctl scale count 0 -a phoenix-worker-standby`), set Railway's worker `PHOENIX_PROCESS_ROLE=worker`, deploy it,
  move the four jobs back to `phoenix-workforce-worker-production.up.railway.app`, then delete the Fly app.

Pinned by `tests/emergency-host.test.ts` (the worker role, the poller, its host pin, one machine that never idles,
and that the variable copy drops every key the config forces).

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

Right after a merge, `--wait [minutes]` re-reads every 90 seconds (30 minutes by default) until the answer is settled — shipped, not merged, or shipped with a red `main` — and a timeout is printed as NOT a pass. Run it with `run_in_background: true`, never as a poll loop.

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

## The worker service

**Why it exists.** Until 16 Oct 2026 one process answered every page AND ran the background work.
Node runs JavaScript on one thread, so a heavy job froze every page in flight: three 4.3-second
freezes in three and a half hours, each straight after the biggest slice of the hourly doctor-list
scrape. The owner chose a separate worker service (16 Oct 2026, "Separate worker service").

**How the two processes differ — one variable, `PHOENIX_PROCESS_ROLE`** (`src/lib/platform/process-role.ts`):

| Service | `PHOENIX_PROCESS_ROLE` | `PHOENIX_LIVE_CRM_POLL` | Runs |
|---|---|---|---|
| `phoenix-people-workforce` (the website) | `web` | — | Pages and API only. Its log says `[process-role] web` and `[crm:live-poll] not started: …` at boot |
| `phoenix-workforce-worker` | `worker` | `true` | The live poller and its deep runs, the Early Birds close, CRM housekeeping, and the moved cron routes |

Unset means `all`, today's single-process behaviour, so removing the variable from the website is the
whole rollback for the in-process jobs. 🔴 **Never let two processes run the poller:** its state lives
in memory, so two would double every sync. Turn it on in one place only, and only after the other
place's log says it did not start.

**Every other variable on the worker is a Railway reference to the website's own**
(`${{phoenix-people-workforce.NAME}}`), so the GitHub → Railway secret sync, which writes the website,
reaches the worker with nothing to keep in step. Its source is `main` with "Wait for CI" off since 20 Oct, held
by the same release gate as the website, and its healthcheck is `/api/readyz` (set on the service itself on
19 Oct — until then it had none). Both are in `.railway/railway.ts`.

**Which cron-job.org jobs call the worker** (moved 16 Oct 2026, the address only; schedule, switch
and bearer unchanged and read back):

| Job | cron-job.org id | Path |
|---|---|---|
| `phoenix-process-notifications` | `8200914` | `/api/notifications/process?limit=50` |
| `phoenix-inbound-intake` | `8200920` | `/api/cron/inbound-intake` |
| `phoenix-recruitment-email-intake` | `8200919` | `/api/cron/recruitment-email-intake` |
| `phoenix-crm-contact-lists` | `8344730` | `/api/cron/crm-contact-lists` (runs 05:00–05:55 only, so its first run on the worker was 17 Oct) |

Every other job, `job-heartbeat-sweep` included, still calls `https://phoenix-hr.satopharma.com`.

**Since 23 Oct 2026 these four, and `phoenix-background-jobs` (`8200915`, on the website), are declared in
`scripts/cronjob-sync.mjs` as `adopted`** (technical audit, S-INT-19): the script reports each one — OK,
DRIFT or MISSING — and never creates or patches it, even with `--apply`, so `cron-autoarm.yml` writes
nothing for them. And the four worker routes now answer **503 `wrong_process`** on the page server
(`PHOENIX_PROCESS_ROLE=web`), so a job pointed back at the website goes red instead of running there
(audit F-04, `src/lib/platform/worker-only-route.ts`). The live poller is single across processes by a
database lease since the same day (`public.job_leases`, `src/lib/platform/job-lease.ts`) — once
`20261023140000_job_leases.sql` is applied; until then it runs exactly as before.

🔴 **A job declared in `scripts/cronjob-sync.mjs` that runs on the worker carries `base: WORKER`.**
The script matches a live job by its full URL, so a moved job declared without it reads as MISSING,
and `--apply` would create a second copy on the website. To move another job, change only its URL in
cron-job.org (one job at a time; the account allows 100 API requests a day), wait for its next run
to answer 200 on the worker, then add `base: WORKER` to its declaration if it has one, and a row here.

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

### Arming a new cron on deploy (`cron-autoarm.yml`)

A cron route merged with a new entry in `scripts/cronjob-sync.mjs`'s `JOBS` map **arms itself** on
the deploy that ships it. `.github/workflows/cron-autoarm.yml` runs on any push to `main` that
touches `scripts/cronjob-sync.mjs`, and `scripts/cron-autoarm.mjs` diffs that file, takes only the
keys that were **added** on the push, and runs the sanctioned one-at-a-time
`cronjob-sync.mjs --job <key> --apply` for each. So the manual "don't forget to arm it" step that
once left `territory-restamp` dead for weeks is gone for a genuinely new job.

It stays strictly inside `cronjob-sync`'s own rule (that script's header: 100 cron-job.org requests
per day, bulk edits are unrollback-able, "resist the urge to add `--all`"): it never sweeps and
never patches an existing job. A **changed schedule** on a job already live, or one you disabled by
hand, is left untouched — that stays a deliberate manual `--apply`. New jobs are rare, so this fires
seldom and spends a handful of the daily budget.

It needs two Actions secrets: `CRON_SECRET` (already present, and upstream of Railway) and
`CRONJOB_API_KEY` (**must be added once**, same value as Railway). Until the key exists, a push that
adds a new job fails this run with that message; a push that adds none stays green. The workflow is
**not** a required check and never blocks a merge — the route is already shipped; this only winds its
clock. Scope and the new-key detection are pinned by `tests/cron-autoarm.test.ts`.

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

🔴 **An URGENT build is rolled back with `node scripts/urgent-deploy.mjs stop` FIRST** (The urgent
route, above), then a Redeploy from the dashboard. While its guard runs, either step below alone is
read as "the fix was lost" and the urgent build is uploaded again within 30 seconds.

Railway also keeps prior deployments and can redeploy the last-good one from the **dashboard**
(project `Phoenix-HR-Workforce` → service `phoenix-people-workforce` → **Deployments** → **Redeploy**) —
faster than a rebuild when the last good commit is known. The **CLI cannot** redeploy an arbitrary
older deployment (`railway redeploy` only redeploys the *latest*); see
docs/disaster-recovery-runbook.md § 2. If the cutover itself ever needs reversing, the
pre-cutover Cloudflare record was `A 8.232.10.208` (Cloud Run) — but note GCP deletes a closed
project's resources roughly 30 days after closure, so that target may no longer exist.

See docs/disaster-recovery-runbook.md for the full incident-response procedure. For database
rollbacks, see docs/migrations.md.

## `AGENTS.md` — the full wording condensed out on 2026-10-08

AGENTS.md loads on every request and again after every compaction, so on 2026-10-08 these lines were shortened to their rule. Nothing was dropped: each block below is the wording as it stood, word for word, and the rule it carries is still in AGENTS.md. Search here for the evidence, the owner's words and the measurements behind a rule.

### §2 — The deploy is gated on CI

- 🔴 **THE DEPLOY IS GATED ON CI, AND THE GATE FAILS BY NOT SHIPPING — SILENTLY.** Railway "Wait for CI" holds the deploy until every check suite on the pushed commit finishes; **red, cancelled, or still queued = no deploy, and after 2 hours Railway SKIPS it with nothing turning red.** So a merge that never shipped now looks exactly like one that did — read `/api/healthz` `revision`, never the merge. Any workflow on that commit can hold it, not just `ci.yml` (a failed `staging-migrate` blocks production), and `railway variables --set` **bypasses the gate entirely**. Never remove `push: main` from `ci.yml` to save minutes — that silently un-gates production. 🔴 **And never cancel a stuck `main` run and walk away** — a commit whose ONLY run is `cancelled` is exactly this failure (it happened on `88f86ee57`, saved only by a dispatch 5 seconds later): fix the cause and `gh run rerun <id>` on the push run, or produce a succeeding run on that same SHA. Account: `docs/deployment.md`, "The deploy gate".
