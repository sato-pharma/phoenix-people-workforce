# CI on a self-hosted runner

Why this exists, how to turn it on, how to turn it off, and the rules that keep it safe.

## The measurement that motivated it

Measured 2026-09-27 against the live account and the Actions API:

🔴 **THE INVOICE IS THE ONLY AUTHORITY ON THE MONEY, AND MEASURED MINUTES MUST NEVER BE CONVERTED
INTO ONE.** On 2026-09-27 a session measured every job of the month, multiplied by GitHub's published
$0.008/min, and reported **~$559** for September. The owner's answer: *"I never paid this value. The
maximum value I paid is the September value"* — **$300.88, the highest Actions invoice he has ever
paid.** The invoice is real money; the derivation was arithmetic on top of an assumed rate and an
assumed allowance. **The invoice wins.**

**The gap is roughly 2x and is NOT explained.** Three candidate causes were tested and all three
failed, so do not re-run them: queue time inside a job's `started_at` accounts for only **2.6%**;
**zero** jobs of 25 September ran on a self-hosted runner (all 1,235 were GitHub-hosted); and
excluding zero-duration skipped jobs changes nothing. Even billing the raw unrounded wall clock
(2,615 min that day instead of 3,230) still lands well above the invoice. The rate that would
reconcile is ~$0.0043/min, almost exactly half the published Linux rate — which points at a plan
allowance, a spending cap or a discount that **cannot be read from here: the billing endpoints need a
`user` token scope no session has.**

🔴 **So the rule is: measure MINUTES, report MINUTES, and anchor every dollar to the invoice.** A
session that converts minutes to money will overstate it and be contradicted by the owner, who is the
only one who can see the bill.

| | |
| --- | --- |
| **September invoice — the anchor** | **$300.88** (owner, the most ever paid) · August $240.77 |
| Measured billable job minutes, 25 Sep, `ci.yml` | **3,230** (3,624 across all workflows) |
| `ci.yml` runs, 09-01..09-26 | **4,304** (2,657 `pull_request` · 1,647 `push` · ~8 dispatch) |
| Billable minutes per full run | **14** before #4527 · **10.9** after |
| **Owner's target** | **$60/month TOTAL** — not a $60 saving (owner, 2026-09-27) |

**The minute measurement is reproducible and internally consistent** — a model built from real
per-day run counts predicts 3,233 billable `ci.yml` minutes for 25 September against **3,230
measured**, and 3,628 across all workflows against **3,624**, 0.1% out on both. Trust it for
*ratios*, which is what it is for. Never for a monthly total.

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
Two 4-vCPU instances give **8 concurrent job slots**, which is the shape that matters: ~4 slots
covers steady demand, so 8 leaves roughly 2x headroom and turns a 6-run burst from about half an hour
of queueing on three slots into about ten minutes.

🔴 **CORRECTED 2026-09-28 — THIS PARAGRAPH CARRIED THE COST AT ~€27/MONTH FOR THE PAIR, AND THE ORDER
TABLE BELOW SAYS ~€35.49 EACH.** That is **~€71/month**, a 2.6x understatement, in the one paragraph
someone would decide the purchase on. It is almost certainly the pre-increase price: Hetzner's rose
about 170% on 15 June 2026, which is why the order table already says to re-read rather than trust it.
**I could not confirm a current figure** — hetzner.com renders its prices client-side, so the public
page yields nothing readable, and the authenticated console is the only authority. **Read the price in
the console before buying; treat both numbers in this file as stale.**

The second figure was wrong in a quieter way. "~11,500 runner-minutes a day of headroom" is 8 slots x
1,440 minutes — the theoretical ceiling at 100% utilisation, which the sentence two lines above says no
CI runner reaches. Usable is more like 7,000-8,000, against demand of ~1,650. The conclusion does not
change; the word "headroom" for a ceiling is what made it read as spare capacity.

🔴 **AND THIS IS THE ONLY LEVER THAT REACHES THE OWNER'S $60/MONTH TOTAL.** Against the $300.88
invoice, $60 is an **80% cut**. #4527's per-run saving is 16.5%; driving re-pushes from 1.61 runs per
PR to a perfect 1.0 adds ~20% more; together they land near $190, not $60. **No combination of
pipeline tuning and push discipline gets there** — only taking the per-minute price to $0 and paying
a fixed machine cost instead, which two 4-vCPU boxes do at roughly half the target. Say that plainly
rather than offering another trim.

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
box's capacity, and the section above establishes the requirement is two to three. 🔴 **At ~$95 per
box Railway does NOT reach the owner's $60 total, and two of them are three times it** — a flat-rate
VPS does, which is why the comparison matters and why Railway's metered compute is the wrong shape for
this job even though it is the platform already in use.

🔴 **MEMORY WAS THE ASSUMPTION NOBODY HAD MEASURED, AND THE FIRST REAL ATTEMPT FAILED ON IT.** A
Railway-hosted runner rollout on 2026-09-27 (`CI_RUNNER=self-hosted`, set 20:01:18Z) failed `validate`
reproducibly on two different runners, in the Build step, with an identical signature:

    OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
    fatal runtime error: failed to initiate panic, error 5, aborting

Runs `36346183612` and `36346466953`; the failing **jobs** inside them are `108695670880` and
`108696483287`. 🔴 **Those two were labelled "job ids" here until 2026-09-28, and that mislabel costs
real time: `gh api actions/jobs/36346183612/logs` returns EMPTY with no error**, which reads as "the log
expired" rather than "wrong id". A second job on that rollout printed every test as PASS and
then took `The runner has received a shutdown signal`, which is a replica cycling mid-job, not a test
failing. Rolled back with `gh variable set CI_RUNNER --body ubuntu-latest` at 20:04:38Z; set it
explicitly rather than deleting it, so the repo variables still read safe.

🔴 **THE HEADING ABOVE AND THE SENTENCE "SO THE ~4 GB FIGURE IS TOO LOW" WERE BOTH MINE, AND BOTH ARE
WRONG — MEMORY IS NOT IMPLICATED AT ALL.** I read `os error 11` as a memory/pids cap and passed that on
before looking at the rest of the log. The build **succeeds**; the abort comes afterwards, and the line
before it names the real cause:

```
✓ Compiled successfully in 40s
Collecting page data using 47 workers ...
OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
```

`next build` sizes that worker pool from the CPUs it can **see**, which inside a container is the
HOST's count — 47 — not the container's allowance, so tokio asks for 47 threads against a far lower pid
limit and gets `EAGAIN`. **Nothing to do with memory, the image, or the code**, and more replicas would
split the same allowance. Memory therefore remains exactly as unmeasured as the table above says:
neither confirmed nor refuted. **Raising the container's memory would not have fixed this.**

🔴 **AND NO ENVIRONMENT VARIABLE CAN CAP IT.** `NEXT_CPUS` was set on the service and the next run
still printed `using 47 workers`. Read from the installed `next@16.3.3`, `dist/build/index.js:371`
takes the count from `config.experimental.cpus` alone. So the cap lives in `next.config.ts` behind
`PHX_BUILD_CPUS`, and `ci.yml`'s Build step passes it **only** when
`runner.environment == 'self-hosted'` — a GitHub-hosted build keeps the key absent and is byte-for-byte
its old configuration, because capping workers on GitHub's 4-core runners would slow every build here
to buy nothing. Pinned by `tests/next-build-cpu-cap.test.ts`, both guards proved by breaking them.

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

## It is BUILT, and two of the three jobs already pass — 2026-09-27

The owner had it built rather than prepared, overriding this document's own "a session prepares, it
does not press". What exists:

| | |
| --- | --- |
| Railway project | `phoenix-ci-runner` `d657a3c0-684c-4e83-88bc-ded47b32a00d` |
| service | `ci-runner` `f6a18a22-1434-4423-95d5-875b88928f9b`, image `ghcr.io/actions/actions-runner:latest` |
| region | EU West `europe-west4-drams3a` — **explicitly scaled there, see the trap below** |
| shape | 3 replicas, runners named `phoenix-ci-<RAILWAY_REPLICA_ID>`, labels `self-hosted,X64,Linux,phoenix` |

Three tested flips, each reverted on anything but success:

| job | result | against GitHub-hosted |
| --- | --- | --- |
| `mobile` | **success**, 33s | — |
| `checks` | **success**, 201s | ~254s hosted — **faster**, and this is the dominant job |
| `validate` | **failure**, 97s | the `Build` step only; steps 1–12 pass. Fixed above. |

🔴 **THE OWNER HALTED THIS TESTING UNTIL THERE WAS A PER-BRANCH SWITCH** — his ruling, typed in another
session's window on 2026-09-28 and relayed here, recorded because it *stopped* an action, which is the
safe direction to err in. The reason is below: a flip cannot be made safe by watching, only by scoping.

✅ **That condition has since been met.** The per-branch switch landed in #4594 (merge `9bde1c3a4`):
the repo-wide `CI_RUNNER` is gone, all six `runs-on` lines compute the runner, and self-hosted is
reachable only from a same-repo `ci-runner/<task>` PR. Verified on `main`'s own run for that merge —
`validate`, `checks` and `mobile` all on `ubuntu-latest`. **Arming it is still a separate decision
and still the owner's**; this file does not record whether the variable is currently set, because that
changes without a commit — read `gh variable list`.

### What the three flips actually established — 2026-09-28

| job | on the runner | against GitHub-hosted |
| --- | --- | --- |
| `mobile` | **success**, 33s | — |
| `checks` | **success**, 201–212s | ~254s hosted — **faster**, and it is the dominant job |
| `validate` | **failure** | `Build` fixed by the CPU cap; then the smoke test, cause below |

🔴 **ONE `validate` PASS ON THE RUNNER IS NOT EVIDENCE — run `36353275114` was docs-only.** Its head
`3dfc8fd8b` changes `docs/observability.md` and nothing else (verified: one file), so `ci.yml`'s
docs-only fast path skipped the build and the Playwright step entirely. The `checks` and `mobile` passes
are real; that one is not. **Check the head's file list before citing any green as progress.**

🔴 **AND THE SMOKE TEST'S CAUSE WAS THE INHERITED `PORT`, NOT ANYTHING ABOUT NEXT.** The runner inherits
its Railway service's whole environment, which sets `PORT=8080`; `next start` and the standalone server
both bind `process.env.PORT`, defaulting to 3000 only when it is unset — true on GitHub's runners, false
here. Measured inside the container: `printenv PORT` → `8080`, and `next start` → `Local:
http://localhost:8080  ✓ Ready in 93ms`. The server was healthy on a port nothing watched.

**Two wrong diagnoses were published before that one, and both are retracted in the code:** `::1`
resolution order (#4570 — changed nothing) and `output: "standalone"` (#4577 — the warning is advisory;
the server serves 93 ms after printing it). **#4577 is nevertheless the fix**, because its
`env: { PORT: "3000", … }` overrides the inherited 8080 — `webServer.env` is spread last over
`process.env` in playwright 1.63 — and #4579 corrects the stated reason. Pinned by
`tests/next-build-cpu-cap.test.ts`, including that the bound port and the polled port are the same
number.

**So the remaining work is not a flip.** It is the per-branch switch the owner asked for; until then
`CI_RUNNER` stays `ubuntu-latest` and the registered runners sit idle.

**Two traps this rollout paid for:**

- 🔴 **`ghcr.io/actions/actions-runner:latest` is BARE — no Node.js** — and `ci.yml` runs
  `Enable Corepack (pnpm)` **before** `actions/setup-node`, so step 4 dies `corepack: command not
  found` (exit 127). Solved in the container's start command (NodeSource Node 24, then
  `corepack enable`, logging `node v24.21.0 corepack 0.36.0` before it registers). That ordering
  assumption in `ci.yml` is invisible until an image without Node runs it.
- 🔴 **A NEW RAILWAY SERVICE IN THIS ACCOUNT IS CREATED IN `sfo`, NOT EUROPE** — the same default that
  put `superb-smile` in the US. `AGENTS.md` §3's "it must stay in Europe" therefore needs an
  **explicit** `railway service scale` on every new service, and the region map printed by the scale
  API is the only place it shows.

**While `CI_RUNNER` reads `ubuntu-latest`, the replicas still bill** — roughly $8/month in idle memory
for three. That is spend producing nothing, and parking them at 0 is a dashboard decision.

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

The workflows do **not** hard-code `self-hosted`, and since 2026-09-28 they do not read a
repo-wide `CI_RUNNER` either. All six `runs-on` lines — four in `ci.yml`, two in
`security-scan.yml` — are byte-identical and read:

```yaml
runs-on: ${{ (vars.CI_SELF_HOSTED != 'off' && vars.CI_RUNNER_LABEL != '' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.head_ref, 'ci-runner/')) && vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}
```

**Self-hosted is opt-in PER BRANCH: push `ci-runner/<task>` and that PR runs on the label; every
other branch, and `main`, runs hosted.** Each condition earns its place:

| condition | why |
| --- | --- |
| `vars.CI_SELF_HOSTED != 'off'` | a one-word kill switch that does not require remembering the configured label |
| `vars.CI_RUNNER_LABEL != ''` | **nothing is baked in.** A job whose label matches no online runner does **not** fall back — it QUEUES, for ever, with nothing red. An unset variable therefore means hosted |
| `github.event_name == 'pull_request'` | **`main` can never be self-hosted.** main's CI *is* the production deploy gate, so a runner that fails or queues there stops shipping |
| `head.repo.full_name == github.repository` | same-repo only — a fork PR on a self-hosted runner is arbitrary code execution on our own machine |
| `startsWith(github.head_ref, 'ci-runner/')` | the opt-in is the branch **name**, so there is nothing to flip and nothing to remember to revert. It also cannot change mid-flight, unlike `vars.*`, which are re-resolved on every new run **attempt** |

🔴 **WHY THE LABEL IS A VARIABLE AND NOT `self-hosted`, MEASURED 2026-09-28.** `runs-on: self-hosted`
matches **every** self-hosted runner on the repo, so it can never mean "the box I provisioned" — and a
label that matches no online runner **queues for ever** rather than failing. When this switch was
written every runner here carried the same four labels (`self-hosted,X64,Linux,phoenix`), so nothing
could be targeted deliberately at all.

✅ **That has since been fixed at the owner's instruction (2026-09-28): the Railway replicas now also
carry `railway-eu`**, kept alongside their existing labels rather than replacing them, so nothing that
targeted them before broke. Verified live — three runners, all online, all carrying
`self-hosted,X64,Linux,phoenix,railway-eu`. **So `CI_RUNNER_LABEL=railway-eu` names that pool on
purpose, and the switch is provable end to end without new hardware.** A future Hetzner box takes its
own label and is selected the same way.

🔴 **Do not quote a runner COUNT from this or any doc.** It read **ten** and then **three** inside the
same hour on 2026-09-28: the Railway replicas register non-ephemerally, so stale registrations pile up
after each redeploy until someone clears them, and a session that had just written "ten" was stale
within the hour. Read `gh api repos/<repo>/actions/runners` and compare the label **sets**. Register a new host with its own extra label and name that label here:

```bash
# on the host, BEFORE running the setup script
export RUNNER_LABELS=self-hosted,linux,x64,phoenix,hetzner
```
```bash
# then point the switch at it — and note this does NOT turn anything on by itself:
# only a same-repo ci-runner/<task> PR is eligible
gh variable set CI_RUNNER_LABEL --body hetzner    # or railway-eu, which already exists
```

🔴 **DO NOT READ THE CURRENT SWITCH STATE FROM THIS FILE — read `gh variable list`.** These are
repository variables: they change without a commit, so any value written here is a snapshot that
begins rotting the moment it is written. This paragraph used to assert *"neither variable is set
today, deliberately"*, and it went false about twenty minutes later, when `CI_RUNNER_LABEL` was set
to `railway-eu` on the owner's instruction (2026-09-28T00:22:00Z). A session reading it would have
believed every job was hosted while `ci-runner/` PRs were already going to the replicas. The file had
been wrong about a live value twice that night — the other was the cost figure, corrected in #4607.

| what `gh variable list` shows | what it means |
| --- | --- |
| `CI_RUNNER_LABEL` **unset** | every job hosted, whatever the branch — the switch cannot fire at all |
| `CI_RUNNER_LABEL` **set** | a same-repo `ci-runner/<task>` PR runs on that label; `main`, dispatches, schedules and every other PR stay hosted |
| `CI_SELF_HOSTED=off` | kill switch, wins over everything, takes effect on a new run **attempt** |

✅ **A DATED MEASUREMENT IS SAFE TO WRITE DOWN HERE; A CURRENT VALUE IS NOT** — which is why the
evidence below stays and the state above does not. On 2026-09-28, **with `CI_RUNNER_LABEL` already
armed**, dispatch `36362005374` put `validate`, `checks` and `mobile` on `ubuntu-latest` while the
replicas sat idle, and PR #4599 took all four required checks on the replicas including the Playwright
login smoke test. Both arms of the prefix condition, demonstrated on real events rather than computed
from the expression. Those readings are true for ever because they carry their date; "the label is
set today" is not.

**Arming it is the owner's call**, and *the label existing is not the same thing as the switch being
on* — that sentence stays true whatever the variables happen to read today.

`scripts/setup-self-hosted-runner.sh` defaults `RUNNER_LABELS` to `self-hosted,linux,x64,phoenix` —
byte-identical to what the Railway replicas carry — so the override is the whole point. Deregistering
those replicas is **not** a prerequisite and does not work as one: the service re-registers a replica
whenever one cycles, so `gh api -X DELETE .../runners/<id>` is a loop, not a fix. Stopping that
project is the owner's dashboard decision.

`PHX_BUILD_CPUS` is unaffected — it gates on `runner.environment == 'self-hosted'`, which is true on
any self-hosted runner whatever its labels.

**The rollback is `gh variable set CI_SELF_HOSTED --body off`**, and because `vars.*` are re-resolved
on a new run attempt, `gh run rerun --failed` then rescues a stuck `ci-runner/` PR.

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
5. Point the switch at the label you gave it — **never at `self-hosted`**, which matches every
   self-hosted runner on the repo:
   ```bash
   gh variable set CI_RUNNER_LABEL --repo Gawish-1997/phoenix-people-workforce --body 'hetzner'
   ```
   This alone turns nothing on: only a same-repo PR from a `ci-runner/<task>` branch is eligible.
   `main`, dispatches, schedules and every other PR stay hosted.
6. Open a PR from a `ci-runner/<task>` branch and watch that run end-to-end before trusting it —
   including which machine took each job (section D below).

## Click by click — from nothing to a proven runner

Ported from PR #4583 (`codex/runner-label-guard`), which was closed once the per-branch switch landed:
its `CI_RUNNER` instructions were superseded, but this procedure was not, and it is the half that
matters when there is hardware on the desk. Reconciled with the switch, so the variable names here are
the live ones.

The numbered steps above assume a host that already exists and a shell that is already non-root.
🔴 **Hetzner's Ubuntu image logs you in as `root`, and `setup-self-hosted-runner.sh` refuses to run as
root** (`[ "$(id -u)" -ne 0 ] || die`) — so the procedure above stops dead at that line with the
servers already bought. **Step B2 is the missing step.**

🔴 **THIS ORDER WAS REFUSED AND THE SECTION IS KEPT ONLY AS COSTED RESEARCH — DO NOT ACT ON IT AND
DO NOT RE-PITCH IT.** The owner's answer on 2026-09-28 was *"I WILL NOT BUY THIS"*, about exactly this
pair at €70.98/month. It stays in the document because the price research, the region trap and the
root-login trap below all cost real work to establish and would otherwise be re-derived — not because
anything is pending. **Self-hosted CI already runs on the existing Railway pool** (the switch above);
nothing here is required for that.

**A — order (browser, `console.hetzner.com`), IF it is ever revisited.** Prices read from Hetzner's own
data 2026-09-28; they rose about 170% on 15 June 2026, so re-read them rather than trusting this table
later.

| field | value | why |
| --- | --- | --- |
| **Add server** | in the project, **Servers** → **Add server** | |
| Location | **Nuremberg (NBG1)** | EU. `sfo` is the default for a new service elsewhere in this account — not here, but check it |
| Image | **Ubuntu 24.04** | the script installs Node 24 itself |
| Type | **Shared vCPU · AMD · CPX32** — 4 vCPU, 8 GB, 160 GB, 20 TB | about €35.49/mo each. **NOT CPX31** — US-only, 3 TB, far dearer |
| Networking | leave **Public IPv4 + IPv6** on | the runner needs outbound only, but SSH in is how you set it up |
| SSH key | **add your public key** | without one Hetzner emails a root password, which is worse in every way |
| Volumes / Firewalls / Backups / Placement | skip | a runner holds no state worth backing up |
| Name | `phx-ci-1` | `RUNNER_NAME` defaults to `phoenix-ci-$(hostname -s)`, so distinct names give distinct runners — which is what makes step D readable |
| quantity | **2** if the console offers a count, otherwise repeat for `phx-ci-2` | |

**B — on EACH box.** B2 is the step the old procedure was missing.

```bash
# B1  from your machine, as root (Hetzner's default)
ssh root@<server-ip>

# B2  make a non-root sudo user and give it your key — the script REFUSES to run as root
adduser --disabled-password --gecos "" phx
usermod -aG sudo phx
install -d -m 700 -o phx -g phx /home/phx/.ssh
cp /root/.ssh/authorized_keys /home/phx/.ssh/authorized_keys
chown phx:phx /home/phx/.ssh/authorized_keys && chmod 600 /home/phx/.ssh/authorized_keys
exit

# B3  back in as that user
ssh phx@<server-ip>
git clone https://github.com/Gawish-1997/phoenix-people-workforce
cd phoenix-people-workforce

# B4  the label override — the whole point of the section above
export RUNNER_LABELS=self-hosted,linux,x64,phoenix,hetzner

# B5  a registration token, valid about ONE HOUR, from
#     /settings/actions/runners/new  (get a fresh one per box if the first expires)
export RUNNER_TOKEN=<paste>

bash scripts/setup-self-hosted-runner.sh
```

It installs Node 24 plus corepack/pnpm and Playwright's system libraries, registers the runner and
installs it as a systemd service so it survives reboot. It warns below 7 GB — a CPX32 reports 8, so
that warning appearing means you bought the wrong plan.

**C — arm the switch. 🔴 READ `gh variable list` FIRST — this step is only an *arming* if
`CI_RUNNER_LABEL` is unset.** If it already names another pool, the same keystroke is a **repoint**, and it
moves every opted-in PR off that pool in one write with nothing to warn you.

```bash
gh variable list                                  # what does CI_RUNNER_LABEL say NOW?
gh variable set CI_RUNNER_LABEL --body hetzner    # the label you gave the box in B4
```

This step said *"Two variables, and neither is set today"* until 2026-09-28, and it was false — the same
claim §L452 carried, surviving twenty lines further down after that one was fixed. It is the worse of the
two placements: L452 is read by someone **checking** state, this is read by someone **acting** on it, minutes
after paying for hardware. Which is the rule the whole file now works to — **a dated measurement is safe to
write down; a current value is not** — applied to an instruction rather than a description: do not tell the
reader what the variable is, tell them to look, and say what each answer means for the command underneath.

Then push a branch named `ci-runner/<task>` and open a PR from it. **Nothing else becomes
self-hosted** — not `main`, not a dispatch, not any other PR. Roll back with
`gh variable set CI_SELF_HOSTED --body off`, which takes effect on `gh run rerun --failed` because
`vars.*` re-resolve on a new attempt.

**D — prove it, and prove it on the right hardware.** A green run is not evidence on its own; read
which machine took each job:

```bash
gh api repos/Gawish-1997/phoenix-people-workforce/actions/runners \
  --jq '.runners[] | select([.labels[].name] | index("hetzner")) | "\(.name) \(.status) \(.os)"'
gh run list --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId'
gh api repos/Gawish-1997/phoenix-people-workforce/actions/runs/<id>/jobs \
  --jq '.jobs[] | "\(.name) on \(.runner_name) \([.labels[]] | join(","))"'
```

Every job's `runner_name` must start `phoenix-ci-phx-ci`. **A `phoenix-ci-<uuid>` name is a Railway
replica**, which means the label selection did not hold — those carry `railway-eu` as well as
`phoenix`, so check the labels line too. 🔴 **And watch that first `main` run to a verdict**: `main` is
never self-hosted under the switch, but a red `main` for any reason makes Railway skip the production
deploy within minutes, and re-running it green does not resurrect it.

## Widening it beyond `ci-runner/` branches — the owner's ruling, 2026-09-28

🔴 **NO — and no longer "not yet".** The earlier wording parked this behind buying two CPX32s. **The
owner refused that purchase outright on 2026-09-28: *"I WILL NOT BUY THIS"*.** So there is no arriving
hardware to wait for, and **widening is judged on the pool that exists or it is not judged at all**.
This is still the obvious-looking improvement a session reading the cost numbers will reach for,
because the remaining share of the Actions bill genuinely does sit in ordinary pull requests — and the
measurement below is now the whole of the answer rather than an interim one.

**The measurement that decided it.** On the night the switch was proven, two `ci-runner/` PRs ran on the
pool and **four required jobs wanted three replicas**: `validate`, `checks` and `mobile` queued behind
`secret-scan` and serialised. Widening the predicate — dropping the `startsWith(github.head_ref,
'ci-runner/')` clause so every same-repo PR is eligible — would put *every* PR into that queue. That
trades a measured saving for an unmeasured one and makes the pipeline slower than GitHub-hosted CI,
which is the opposite of the point.

**It is pinned, not merely written down.** `tests/ci-runner-switch.test.ts` requires that clause, and it
runs in the required `checks` job — so removing it turns a PR red with the ruling in the failure
message. Do not "fix" that test to widen the predicate; the test is the ruling.

**When it changes:** once the Hetzner boxes are registered and carrying their own label, the pool is
deep enough for the queue to stop being the bottleneck. Re-propose it then, with his word, as its own
change — never bundled into something else.

## Turning it off

```bash
gh variable set CI_SELF_HOSTED --repo Gawish-1997/phoenix-people-workforce --body off
```

That is the kill switch and it wins over everything else, so it works without having to remember which
label was configured. `gh variable delete CI_RUNNER_LABEL` also does it, by making the label unset —
either way an eligible PR falls back to hosted rather than queueing. 🔴 **`gh variable delete CI_RUNNER`
is the OLD command and now does nothing**: that variable was retired in #4594 and no workflow reads it.

Because `vars.*` are re-resolved on each new run **attempt**, a run already in flight keeps the old
value — `gh run rerun --failed` is what picks the kill switch up. The next run goes back to
GitHub-hosted. Nothing else changes, no workflow edit, no PR. Do this
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
