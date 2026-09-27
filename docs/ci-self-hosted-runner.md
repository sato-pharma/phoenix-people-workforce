# CI on a self-hosted runner

Why this exists, how to turn it on, how to turn it off, and the rules that keep it safe.

## The measurement that motivated it

Measured 2026-09-27 against the live account and the Actions API:

🔴 **CORRECTED 2026-09-27, and the correction is large: the $300.88 this document was built on is a
MONTH-TO-DATE figure read around 16-17 September, not September.** Reconstructing the month from real
per-day run counts puts cumulative spend at $284.92 on 09-16 and $309.33 on 09-17 — $300.88 lands
between them — and the 37,610 minutes derived from it matches this model's 09-15 cumulative of 37,667.
August's **$240.77 is a closed month** and so comparable; September's was not, and setting them side
by side made the growth look flat when it roughly doubled. **Never quote a GitHub cost figure without
the date it was read on.**

| | |
| --- | --- |
| Billable Actions minutes, September | **~72,800** (26 measured days scaled to 30) |
| September cost at $0.008/min after the free 3,000 | **~$559** |
| Included with GitHub Pro | **3,000 / month** |
| `ci.yml` runs, 09-01..09-26 | **4,304** (2,657 `pull_request` · 1,647 `push` · ~8 dispatch) |
| Billable minutes per full run | **14** before #4527 · **10.9** after |
| August bill (closed month) | $240.77 |

**Model validation, which is the only reason to trust the figures above:** it predicts 3,233 billable
`ci.yml` minutes for 25 September against **3,230 measured**, and 3,628 across all workflows against
**3,624 measured** — 0.1% out on both.

14 billable minutes for 4m33s of wall clock, because **GitHub bills each job separately and
rounds every job UP to a whole minute** (measured on run `36277556391`: validate 273s→5,
typecheck 196s→4, test 139s→3, lint 50s→1, mobile 8s→1).

GitHub charges **$0/minute for self-hosted runners** — you pay only for the machine. That is a fixed
cost which does not climb with the commit rate, against a metered one that does.

🔴 **BUT CAPACITY IS SPENT IN RUNNER-SECONDS, NOT IN BILLABLE MINUTES, AND THE TWO ARE 35% APART.**
This document previously concluded that one ~$12 8 GB VPS "covers 37,610 outright" by comparing
billable minutes against a machine's wall clock. They are different quantities: GitHub's ceil-per-job
rounding inflates what it CHARGES above the work actually done, while a self-hosted box owes only the
work. Measured over every job of 25 September: **3,858 billable minutes against 2,850 runner-minutes
of real work — 35.4% of the bill is rounding.** That gap is exactly where the saving comes from; it is
also why the capacity sum must use the smaller number.

At September's average volume with post-#4527 per-run cost, real demand is **~1,650 runner-minutes a
day**. A 2-vCPU box supplies 1,440 a day *at 100% utilisation, serially* — which no CI runner reaches,
because a run wants its four jobs concurrent and peak days are twice the average. So the honest
requirement is **two to three boxes, not one**, and the ~$12 single-VPS figure was never achievable.
Two 4-vCPU instances (~€27/month together) give 8 concurrent job slots and ~11,500 runner-minutes a
day of headroom.

**This is a separate lever from [#4527](https://github.com/Gawish-1997/phoenix-people-workforce/pull/4527)**,
which merges `lint`+`typecheck`+`test` into one job and cuts ~14% off every run. They compose:
fewer billable minutes per run, and those minutes billed at $0.

## Why the volume is what it is

The pipeline is already tuned close to its limit. **The spend is driven by how many times it runs,
and that is self-inflicted by how agent sessions ship.** Measured 2026-09-27:

| | |
| --- | --- |
| Pushes to `main`, 7 days | **338** (~48/day) — each a full CI run |
| PRs merged, 7 days | **≥100** (query capped at 100) |
| PRs touching **≤3 files** | **41%** |
| PRs changing **≤50 lines** | **23%** |
| Billing per shipped change | **~28 billable minutes** (≈14 on the PR + ≈14 on the merge to `main`) |

A three-file change costs the same ~28 minutes as a three-hundred-file one, because billing is
per-job-rounded-up, not per-line. `AGENTS.md` §0 records the shipping pattern — "~46 commits/day,
6.7 files per commit" — as a neutral fact about how this repo is run; at $0.008/minute it is also
the single largest line in the bill.

**The rule this produced** (owner, 2026-09-27: *"you make many prs and many merges you can wider the
contact of the pr to make less merges"*) is in `AGENTS.md` §6 under Git hygiene: batch related work
into one branch and one PR, and push fixups in fewer, larger commits — concurrency cancels
superseded PR runs, so two pushes a minute apart bill twice and verify once.

Still split when the parts need **separate approval** (a migration, a locked file, a protected rule)
or when one part is urgent and the rest is not. Never split merely because it reads tidier.

This composes with everything below: fewer runs, each cheaper (#4527), each billed at $0 (the
runner).

## 🔴 Where the money actually is — and why the run COUNT lies

**Counting runs gives the wrong answer, and a session acted on it.** On 2026-09-27 the owner was told
manual re-runs were "26% of the bill, ~$78/month" because they are ~26% of the *runs*. They are
**3.9% of the minutes**. The correction matters because the obvious cost lever — "stop re-running CI"
— is worth about **$12/month**, not $78, and chasing it would have cost more effort than it saved.

🔴 **AND A SAMPLE LIES TOO.** The shares below were first measured over 240 runs and were wrong by
enough to matter. These are counted from **every run of 09-01..09-26**, per event, with per-run cost
measured over a full day:

| trigger | runs | share of CI minutes | avg billable min/run |
| --- | --- | --- | --- |
| `pull_request` | 2,657 | **60.5%** | 12.8 |
| `push` to `main` | 1,647 | **39.5%** | 13.5 |
| `workflow_dispatch` | ~8 | **~0.0%** | 1.2 |

Dispatch is a **rounding error** — not the 3.9% a sample showed, and certainly not the 26% a run count
showed. September holds about eight of them in total.

🔴 **The trap that produced every wrong figure in this document: the Actions runs API caps at 1,000
rows and truncates the OLDEST silently.** Four separate wide queries came back with *exactly* 1,000
rows and looked like complete months. Count the rows; if the answer is exactly 1,000, narrow the
window and query again.

**`ci.yml` is 89.1% of the whole Actions bill** — 3,230 of 3,624 billable minutes across every run of
every workflow on 25 September, a full day rather than a tail of recent runs. Security Scan is 6.3% at
1.3 min/run, Synthetic Journeys 2.1%, everything else under 1.5% each. **Nothing outside `ci.yml` is
worth touching.**

Two more facts that close off the obvious ideas:

- 🔴 **1.61 CI runs per PR, and 1,652 PRs in 26 days — THE LEVER IS THE 1,652, NOT THE 1.61.**
  Counted over the whole month: 2,657 `pull_request` runs across **1,652 distinct branches**. The
  earlier "2.18 runs per PR" came from a 50-branch sample and overstated the re-push waste; on
  2026-09-27 the measured figure was **1.27**, close to the floor of 1.0. So push discipline is
  nearly exhausted as a saving: driving 1.61 to a perfect 1.0 would reclaim ~$103/month and demands
  that no PR ever gets a second push. **Sixty-four PRs a day is the actual cost driver**, which is
  what the ONE WIDE PR rule attacks — batching five narrow PRs into one saves four PR runs *and*
  four `main` runs, roughly ten times what a re-push costs.
- **`main` gets exactly one run per commit** — 51 commits, 51 runs, zero duplicates. No waste there.

🔴 **And `main`'s 39.5% is no longer waste at all — it is the price of the production deploy gate.**
Railway's Wait for CI reads the check suites on the pushed commit, so removing `push: main` from
`ci.yml` to save that ~$197 would silently un-gate production. See [deployment.md](deployment.md),
"The deploy gate". **That leaves the runner as the only lever that cuts the bill without cutting
safety** — which is the whole argument of this document.

### Reproducing the measurement

GitHub's own `/timing` endpoint returns `{"billable":{}}` while an account is payment-restricted, so
these figures were computed from per-job wall clock with **ceil-per-job** applied, the way GitHub
charges:

```bash
gh run list --workflow=ci.yml --limit 240 --json databaseId,event \
  --jq '.[] | "\(.databaseId)|\(.event)"' |
while IFS='|' read -r id ev; do
  m=$(gh api "repos/Gawish-1997/phoenix-people-workforce/actions/runs/$id/jobs" \
    --jq '[.jobs[] | select(.started_at != null and .completed_at != null)
           | ((.completed_at|fromdateiso8601) - (.started_at|fromdateiso8601)) / 60 | ceil] | add // 0')
  echo "${m:-0}|$ev"
done | awk -F'|' '{s[$2]+=$1; n[$2]++; t+=$1} END {for (e in s) printf "%7d min %5.1f%% %3d runs %s\n", s[e], 100*s[e]/t, n[e], e}'
```

The sample window is short — 240 runs was ~27 hours on that day. **Trust the shares, not a monthly
projection from them**, and anchor the money to the real invoice.

## 🔴 THE DECISION: the runner goes on Railway — owner, 2026-09-27

*"Railway's own compute maths came out around $95/month ok accepted."* So the host is a Railway
container, not the owner's laptop and not a rented VPS.

**The arithmetic, with its assumptions attached — this is an ESTIMATE, not a quote.** Railway's
published standard-compute rates, converted from per-second, billed on actual usage rather than
allocation:

| | rate | per month |
| --- | --- | --- |
| memory | $0.00000386 / GB / sec | **$10.14 per GB** |
| vCPU | $0.00000772 / vCPU / sec | **$20.29 per vCPU** |

Workload, corrected to measured runner-second demand rather than to billable minutes:
**~1,650 runner-minutes/day ≈ 835 busy hours/month** at September's average volume. At ~2 vCPU and
~4 GB while busy: ~$44 CPU + ~$44 memory + ~$8 idle across replicas ≈ **$95** — but that buys ONE
box's capacity, and the section above establishes the requirement is two to three. Against a **~$559**
month rather than the ~$301 once written here, the payback case survives paying for the extra boxes
and is stronger than this document claimed.

🔴 **MEMORY WAS THE ASSUMPTION NOBODY HAD MEASURED, AND THE FIRST REAL ATTEMPT FAILED ON IT.** A
Railway-hosted runner rollout on 2026-09-27 (`CI_RUNNER=self-hosted`, set 20:01:18Z) failed `validate`
reproducibly on two different runners, in the Build step, with an identical signature:

    OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
    fatal runtime error: failed to initiate panic, error 5, aborting

Job ids `36346183612` and `36346466953`. That is a thread or process limit in the container —
RLIMIT_NPROC, or a pids/memory cap — **not vCPU count, so adding replicas will not help and may hurt**
by splitting the same allowance. A second job on that rollout printed every test as PASS and then took
`The runner has received a shutdown signal`, which is a replica cycling mid-job, not a test failing.
**So the ~4 GB figure above is too low for the Build step.** The knobs are the container's
process/thread limit and its memory, plus pinning the build's own concurrency. Rolled back with
`gh variable set CI_RUNNER --body ubuntu-latest` at 20:04:38Z; set it explicitly rather than deleting
it, so the repo variables still read safe.

🔴 **A BROKEN RUNNER ROLLOUT TURNS `main` RED, AND THE DEPLOY GATE THEN CORRECTLY PINS PRODUCTION.**
That is the gate working, but it is invisible until somebody reads it, and Railway abandons the
withheld deployment at the two-hour mark with nothing turning red. On 2026-09-27 two commits were
withheld this way. **Never flip `CI_RUNNER` without watching the first `main` run to a verdict**, and
roll back on the first failure instead of debugging while production is held. Quote the range and the
assumption, never the $95 alone.

### Four constraints, each one evidenced

1. 🔴 **LINUX x86_64, NEVER WINDOWS — the day's most expensive lesson.** The `OMAR-GAWISH` runner was
   Windows/X64 and failed **all three jobs in 18–30 seconds**, because every `run:` step here is bash
   and GitHub's default shell on Windows is PowerShell: `set -euo pipefail` becomes
   `Set-Variable : A parameter cannot be found that matches parameter name 'euo'`. A Railway container
   is Linux, so this is satisfied by construction — it is written down anyway, because the next person
   to stand one up by hand on a laptop will hit it again.
2. **A SEPARATE Railway project, not a service beside production.** The safety rules below already say
   the host has repository-level trust and must be treated as production infrastructure; a runner
   executes whatever any workflow tells it to. The Phoenix project is also where cross-service
   `${{...}}` variable references are the documented pattern. And `superb-smile` demonstrated on
   2026-09-25 exactly what an extra project connected to this repo does when nobody is watching it.
3. **2–3 replicas minimum.** A runner takes one job at a time and the work is ~26.6 h per 24 h day, so
   a single runner queues behind itself — which from the outside is indistinguishable from the
   2026-09-27 startup-failure outage. Pro allows 42 replicas at 24 vCPU / 24 GB each, so this is a
   configuration choice, not a ceiling.
4. **The rollback stays ONE command:** `gh variable delete CI_RUNNER`, or set it back to
   `ubuntu-latest`. **Never hard-code `self-hosted` in a `runs-on`.**

### An open question nobody has settled

Railway now sells **Sandboxes** — in its own words, *"isolated Linux VMs for agents, builds, and
untrusted code"* — billed only while running, at roughly $50/GB-month and $50/vCPU-month while
active. That is the product literally designed for untrusted code, and for a bursty CI load it may
beat standard compute or be far worse, depending entirely on how the idle listener is billed. It
could not be settled from the pricing page, and it has not been guessed at. **Price it before
choosing standard compute, and record the answer here.**

### Who does what

Creating the Railway project and service is a **money move on a production surface — the owner's
dashboard click**, per the standard `docs/devices/headwind-rustdesk.md` §4 sets: *a session prepares;
it does not press.* What is ours is the last step only: flipping `CI_RUNNER` once the runner reads
**Idle**, and reverting it the moment anything queues. 🔴 **Do not flip it while zero runners are
registered** — since the `OMAR-GAWISH` deregistration there are none, and jobs do **not** fall back
to GitHub's: `main` runs would queue for ever rather than fail, which under the production deploy
gate means no deploy at all, silently, until Railway abandons it at the two-hour timeout.

## 🔴 The safety rules

1. **PRIVATE REPOSITORIES ONLY.** A self-hosted runner executes whatever a workflow tells it to.
   On a **public** repo, anyone opening a fork pull request runs arbitrary code on the host.
   `phoenix-people-workforce` is private, so only accounts with repository access can trigger it —
   the case GitHub's own guidance considers acceptable. **If this repo is ever made public, remove
   the runner first.**
2. **Never on the owner's laptop.** `AGENTS.md` §5 records that the 16 GB machine already
   hard-freezes under a build plus a dev server. A CI runner there guarantees it.
   🔴 **This happened.** On 2026-09-27 a runner named `OMAR-GAWISH` (`self-hosted, Windows, X64`)
   was registered and online, and with `CI_RUNNER=self-hosted` it took the jobs — see rule 2b for
   what that did. Deregister it: `gh api -X DELETE repos/Gawish-1997/phoenix-people-workforce/actions/runners/<id>`,
   and on the machine `cd C:\actions-runner && .\config.cmd remove`. A registered runner is not
   idle — it competes for every job the moment the variable points at it.
2b. 🔴 **THE RUNNER MUST BE LINUX. A WINDOWS RUNNER FAILS EVERY JOB IN SECONDS, AND LOOKS HEALTHY
   DOING IT.** Every `run:` step here is bash; GitHub's default shell on a Windows runner is
   PowerShell, which cannot parse `answer() { … }` or `[ "$X" = "y" ]`. Measured 2026-09-27 on
   PR #4537: all four required checks failed in 11–25 s with `An expression was expected after '('`
   and `Missing type name after '['`, from
   `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.EXE`. Nothing reports "wrong OS" — the
   runner shows `status: online`, the checks simply go red, and the failure reads like a broken
   branch. **Under the production deploy gate this is far worse than a red PR:** every `main` run
   would fail in seconds, so Railway would withhold every deploy and then skip it at the two-hour
   timeout with nothing red to explain why (`deployment.md`, "The deploy gate", failure modes 1 and
   3). `scripts/setup-self-hosted-runner.sh` is an Ubuntu script and refuses anything else; the
   `runs-on` label must resolve to a **Linux x86_64** host, and a runner registered any other way
   must be deregistered rather than left online.
3. **The host has repository-level trust.** Anything in `.env` on that box, and any credential the
   workflows use, is reachable by any job. Treat it as production infrastructure: no shared logins,
   SSH keys only, firewall everything except SSH out.
4. **The registration token is short-lived** (~1 hour) and is never written to disk by the setup
   script. It is not a long-term secret, but do not paste it into chat or commit it.

## Turning it on

The workflows do **not** hard-code `self-hosted`. Every job reads:

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
```

That default is deliberate and load-bearing. **A job whose `runs-on` matches no online runner does
not fall back — it queues.** Hard-coding `self-hosted` means that the moment the box reboots,
fills its disk or loses network, every PR silently stops getting CI, which is precisely the outage
this repository spent 2026-09-27 living through for a different reason. With the variable, the
runner is opt-in and the rollback is one command.

1. Provision a host — Ubuntu 22.04/24.04, **x86_64, 8 GB RAM minimum** (`ci.yml` runs typecheck
   with `--max-old-space-size=6144`, and the build peaks around 4 GB), ~40 GB disk.
2. Get a registration token: **Settings → Actions → Runners → New self-hosted runner**
   (`/settings/actions/runners/new`).
3. On the host:
   ```bash
   git clone https://github.com/Gawish-1997/phoenix-people-workforce
   cd phoenix-people-workforce
   export RUNNER_TOKEN=...
   bash scripts/setup-self-hosted-runner.sh
   ```
   It installs Node 24 + corepack/pnpm, Playwright's **system** libraries (the browsers themselves
   are still downloaded and cached per run by `ci.yml`), registers the runner and installs it as a
   systemd service so it survives reboot.
4. Confirm it shows **Idle** at `/settings/actions/runners`.
4b. 🔴 **Confirm the OS before flipping the variable, and that NO other runner is registered** —
   this is the step whose absence cost PR #4537 a full red cycle on 2026-09-27 (safety rule 2b):
   ```bash
   gh api repos/Gawish-1997/phoenix-people-workforce/actions/runners \
     --jq '.runners[] | {name, os, status, labels: [.labels[].name]}'
   ```
   Every row must read `"os": "Linux"`. A `"Windows"` row will take the jobs and fail all of them in
   seconds, and `status: online` tells you nothing about whether it can run bash.
5. Flip CI onto it:
   ```bash
   gh variable set CI_RUNNER --repo Gawish-1997/phoenix-people-workforce --body 'self-hosted'
   ```
6. Watch the first run end-to-end before trusting it.

## Turning it off

```bash
gh variable delete CI_RUNNER --repo Gawish-1997/phoenix-people-workforce
```

The next run goes back to GitHub-hosted. Nothing else changes, no workflow edit, no PR. Do this
first and diagnose afterwards whenever the runner misbehaves — a queued job reports no status, and
a required check with no status blocks every PR.

## What to expect after the switch

- **Cost**: metered Actions spend for this repo goes to ~$0. The VPS is the whole bill.
- **Speed**: likely faster. `ci.yml` notes the Build step ranges 148–245s purely on which shared
  2-vCPU runner drew the job; a dedicated box removes that variance. A persistent runner also keeps
  the pnpm store and Playwright browsers warm between runs.
- 🔴 **A persistent runner keeps state between jobs**, which GitHub-hosted runners never do. That is
  where the speed comes from and also the one new failure mode: a stale `node_modules`, `.next` or
  generated type file can make a run pass that should have failed. If a result ever looks
  suspicious, clear `~/actions-runner/_work` and re-run before believing it.

## Do not re-attempt these

Recorded in `ci.yml`'s own comments with the measurements:

- `next build --turbopack` — a **no-op**; Next 16.2.11 already builds with Turbopack (175s vs 174s,
  byte-identical output).
- `.next/cache` — restored fine, **saved nothing** (148s warm vs 143s cold), and its entries reached
  97% of the 16.47 GB repository cache budget.
- Extending the docs-only fast path to `main` pushes — measured **4 of the last 200 commits (2%)**
  are docs-only. Worth roughly $2/month.
