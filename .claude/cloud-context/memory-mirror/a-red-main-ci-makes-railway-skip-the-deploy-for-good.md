---
name: a-red-main-ci-makes-railway-skip-the-deploy-for-good
description: "Railway's Wait-for-CI marks a production deploy SKIPPED within minutes of ANY check suite on that commit going bad - not just a red ci.yml, and a fully green ci.yml does NOT rule it out because a scheduled workflow attaches its suite to whatever commit is main HEAD when it fires - and re-running it green afterwards does NOT resurrect it, so a merged, green, CI-passing commit sits unserved with nothing red anywhere to show it"
metadata:
  node_type: memory
  type: project
---

🔴 **CORRECTED 2026-09-28 — IT IS NOT ONLY A RED `ci.yml`.** The gate waits on EVERY check suite on the commit, and a **scheduled** workflow attaches its suite to whatever commit is `main` HEAD at the moment it fires. Measured on `cd9e0be03` (#4579): `checks`, `mobile` and `validate` were ALL `success` and the deploy was withheld anyway, because a scheduled `Deploy Drift Check` run concluded `failure` on that sha at 22:35:35Z — Railway marked the deployment SKIPPED at 22:35:40Z, five seconds later. That alarm was a FALSE POSITIVE about the very deploy it thereby withheld: it compared production against `main` HEAD, which the CI gate guarantees is not serving yet. Fixed the same day (it now compares a settled commit by ancestry, `tests/deploy-drift-settled-ref.test.ts`), but the general fact stands: **any flaky cron in this repo can silently stop a production deploy, and `gh run list --workflow=ci.yml` will look innocent.** Read `gh api repos/<repo>/commits/<sha>/check-suites`. `verify-shipped.mjs` now names the bad suites itself.

🔴 **The CI deploy gate's failure mode is a commit that is merged, green and NOT SERVING.** First
observed 2026-09-27, the day the gate went live — and this is the **withheld deploy** that
`docs/deployment.md` said must be seen before the gate could be called established fact.

Two commits merged 86 seconds apart (`2b654dd73` #4560, `371200082` #4559). Both main CI runs went
red, so Railway withheld both:

```
22:56:39  371200082  SKIPPED
22:55:12  2b654dd73  SKIPPED
22:38:01  bc049b3e4  SUCCESS   <- still serving, two commits behind
```

**Three things that are not what the docs led me to expect:**

1. **SKIPPED lands in SECONDS, not after two hours.** `docs/agents-production-hooks.md` says Railway
   skips "after two hours … with nothing turning red". It skipped as soon as CI concluded red.
2. **Re-running CI green does not un-skip it.** A green run on the same SHA twenty minutes later left
   production on the older commit. The deploy must be re-triggered — the owner's dashboard Redeploy,
   or the next merge, since Railway deploys main's HEAD. **The next merge is what actually fixed it,
   measured:** an unrelated PR merged green at 23:35 Cairo, deployed `SUCCESS`, and
   `git merge-base --is-ancestor` then put BOTH withheld commits inside the live revision. So the
   recovery costs nothing and needs no dashboard click as long as something else is landing — which
   is also why the withhold can go unnoticed on a busy night.
3. **Staging and production disagree.** Staging deployed the head fine (`success`) while production
   skipped, so a green staging deploy says nothing about what production is serving.

**How to apply.** After any merge, read `railway deployment list -s phoenix-people-workforce
-e production` for the word **SKIPPED** — not just the live `revision`, and never conclude from a
green re-run that the deploy recovered. Do **not** reach for `railway redeploy`: `AGENTS.md` and the
ship skill both forbid it.

## 🔴 Why those runs were red — and the diagnostic trap in it

**Not a GitHub flake, and not either change.** Another session was smoke-testing self-hosted CI
runners that night (Railway replicas, project `phoenix-ci-runner`, to cut a $300.88 September bill)
by flipping the repo variable **`CI_RUNNER`** to `self-hosted`. Both merges landed inside its third
test window. Read the **runner label on the job**, which settles it in one call:

```
att 1  validate failure  runner=phoenix-ci-30e93799…  labels=self-hosted
att 2  validate failure  runner=phoenix-ci-dd08deaf…  labels=self-hosted
att 3  validate success  runner=GitHub Actions …      labels=ubuntu-latest
```

`gh api repos/<owner>/<repo>/actions/runs/<id>/attempts/<n>/jobs --jq '.jobs[] | "\(.name)
\(.conclusion) \(.runner_name) \(.labels|join(","))"'`

`OS can't spawn worker thread: Resource temporarily unavailable (os error 11)` is the container's
thread ceiling: it sees the host's 47 CPUs, Next sizes its worker pool from that, and the pid limit
is far lower — so tokio gets EAGAIN at "Collecting page data using 47 workers". The compile itself
succeeds. "The runner has received a shutdown signal" is the same cause from the other side, a
replica replaced mid-job.

🔴 **The trap: "I re-ran it and it passed, so nothing was wrong" is not a diagnosis when the runner
changed underneath you.** I read attempt 3's green as proving the code was fine "with nothing
changed" — but the runner HAD changed, and the same reading would have hidden a real self-hosted
regression. Check `runner_name`/`labels` before calling any re-run a flake. Likewise the Turbopack
warning in the same log (`award-cheque.ts:68` tracing 15,826 files) is a genuine inefficiency but was
NOT the cause — a plausible in-log warning is the easiest wrong answer to reach for.

🔴 **`CI_RUNNER` is repo-wide with no per-branch or per-run override, so flipping it hits every
session's merges** — and those merges' CI is what gates production. Never flip it while `validate`
fails on it, and only in a window when nothing is landing. Related:
[[a-403-on-a-phoenix-crm-route-proves-nothing]] — the same habit of reading an infrastructure answer
as a fact about the code.

🔴 **REVERTING `CI_RUNNER` DOES NOT SAVE AN ATTEMPT THAT ALREADY EXISTS — `vars.*` is resolved once
per RUN ATTEMPT, when that attempt is created, and NOT when each job starts.** So every job of an
attempt created before the revert still lands on the self-hosted runner, however much later it starts,
and the session that pushed it reads a failure it did not cause. Revert is necessary and NOT
sufficient; the only guard that works is **no run may be CREATED while the variable is flipped** —
polling the sha, or watching for jobs to start, cannot close it, because by the time either is visible
the attempt already carries the runner.

Proof, revert at **21:54:31Z** (2026-09-27, re-measured 2026-09-28 from the runs API):

- `36353275114` CREATED 21:52:04Z — jobs started 21:54:34, 21:54:59, 21:55:06, i.e. **3, 28 and 35
  seconds AFTER the revert — all three still self-hosted.** This is the clean proof.
- `36353489706` created 21:55:56Z and `36353549733` created 21:57:02Z — **created after the revert, all
  jobs ubuntu-latest.** So a run created after it IS clean; the window closes at run creation.

🔴 **A `gh run rerun --failed` CREATES A NEW ATTEMPT, SO IT DOES PICK UP THE REVERTED VALUE — that is a
real rescue, not a hope.** On `36353309585` attempt 1's `validate` ran self-hosted and failed; attempt 2
ran on `ubuntu-latest` and passed, while attempts 1 of `checks` and `mobile` stayed self-hosted in the
same run. **A run showing two different runners is that, not per-job resolution** — read `run_attempt`
on the JOBS (`/jobs?filter=all`) before concluding anything about how the label was chosen.

🔴 **Corrected 2026-09-28 — the original note said the PR's run "started at 21:55:08Z, 37 seconds after
the revert".** That timestamp is the `validate` JOB's start; run `36353309585` was CREATED at 21:52:41Z,
110 seconds BEFORE the revert. The conclusion held, the example did not. **A run's `created_at` and its
jobs' `started_at` differ by minutes here — never read one for the other.**

🔴 **`validate` passing once on self-hosted is NOT evidence it works there:** `36353275114`'s head
`3dfc8fd8b` touches only `docs/observability.md`, so the docs-only fast path skipped the Playwright
step. The `checks` and `mobile` self-hosted passes are real.

**The failure it produced was not the `set -euo pipefail` one, and that matters** — that signature
(every job dead in 18–30s on `Set-Variable : A parameter cannot be found that matches parameter name
'euo'`) is the WINDOWS self-hosted runner. Here `checks` (3m32s) and `mobile` both PASSED on
self-hosted, and only `validate` failed, after 3m23s, at **"Run Playwright login smoke test"** with
`Error: Timed out waiting 120000ms from config.webServer`. So a self-hosted window does not announce
itself by killing everything: it can take out exactly ONE required check, the slowest one, and look
like a real defect in the pushed branch. **Read `runner_name` and `labels` off the jobs API before
believing any `validate` failure, and read the failing STEP** — `gh api
repos/.../actions/runs/<id>/jobs --jq '.jobs[]|"\(.name) \(.conclusion) \(.runner_name)
\(.labels|join(","))"'`.

**Re-running IS the right move in exactly this case, and it is not "hoping for a flake":** the
runner genuinely changed underneath, which is a stated cause. `gh run rerun <id> --failed` then put
`validate` on `GitHub Actions … / labels=ubuntu-latest` while the two passed jobs kept their
self-hosted results. Say WHICH runner each attempt used when reporting it — the 2026-09-27 incident
was a session calling attempt 3 "green with nothing changed" when the runner had moved.

**And the same window left a red `main` run that did NOT cost the deploy.** `524d9c462` has a
`success` on `ubuntu-latest` at 21:42:43Z and a LATER `failure` on `self-hosted` at 21:50:39Z, and
production was serving `524d9c462` at 22:00:59Z. The gate is the run that existed when Railway
waited, so a red re-run after the fact does not retract a deploy — do not "rescue" one by re-merging.

🔴 **WHY `validate` TIMES OUT ON THE RAILWAY RUNNER, MEASURED IN THE CONTAINER: it sets `PORT=8080`, and
every Next server binds `process.env.PORT`.** So the app serves on 8080 while Playwright's
`webServer.url` polls 3000 and waits out the full 120 s. `printenv PORT` → `8080`; `next start` there
prints `- Local: http://localhost:8080` and `✓ Ready in 93ms`, so **the server is not broken and the
`"next start" does not work with "output: standalone"` warning is advisory** — it prints that line and
serves anyway. GitHub's hosted runners set no `PORT`, which is the whole difference, and it is why
`localhost` → `127.0.0.1` could not have helped: there was nothing on 3000 on any address.

**Switching server does not matter; PINNING THE PORT is the fix, and #4577 ships it** —
`playwright.config.ts` sets `env: process.env.CI ? { PORT: "3000", HOSTNAME: "127.0.0.1" } : undefined`
on `webServer`, and Playwright spreads `webServer.env` **LAST** over the inherited environment
(1.63.0, `playwright/lib/runner/index.js:872` — `{...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env,
...this._options.env}`), so `PORT=3000` overrides the container's 8080 and **nothing is stripped**.
`.next/standalone/server.js` line 8 is `parseInt(process.env.PORT, 10) || 3000`, so the standalone
server would have bound 8080 too — the command change stands on its own merit (it runs the artifact the
Dockerfile ships), never as this fix.

🔴 **Corrected 2026-09-28, same session, twice in one night: I reported that #4577 set no `PORT` and so
did not fix self-hosted. It does.** I grepped `ci.yml` for `PORT` — the pin is in `playwright.config.ts`
— and read only that file's first 40 lines, where the `env:` line sits on 41. **Two wrong greps, both
of which LOOKED like a clean negative result.** When a fix is reported as absent, grep the file that
would hold it and read the whole block, never a window.

🔴 **THE DURABLE RULE: the port the server BINDS and the port the poll WATCHES must be the same number,
and their disagreement is SILENT** — the log shows a ready server and a timed-out poll with nothing
connecting them. More generally, a self-hosted runner inherits its Railway service's WHOLE environment,
so anything in CI reading an ambient variable can differ there: `printenv` it before believing the code
when a server "never starts".

**The runner container's `/home/runner/_work` SURVIVES between jobs**, so a finished run's build can be
inspected afterwards with `railway ssh` — that is how both facts above were measured rather than inferred.
