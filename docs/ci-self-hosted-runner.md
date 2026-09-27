# CI on a self-hosted runner

Why this exists, how to turn it on, how to turn it off, and the rules that keep it safe.

## The measurement that motivated it

Measured 2026-09-27 against the live account and the Actions API:

| | |
| --- | --- |
| Billable Actions minutes, September | **37,610** ($300.88 ÷ $0.008/min) |
| Included with GitHub Pro | **3,000 / month** |
| `ci.yml` runs, 7 days | **1,105** (591 `pull_request` · 338 `push` · 71 dispatch) |
| Billable minutes per full run | **14** |
| August bill | $240.77 · **September** | $300.88 |

14 billable minutes for 4m33s of wall clock, because **GitHub bills each job separately and
rounds every job UP to a whole minute** (measured on run `36277556391`: validate 273s→5,
typecheck 196s→4, test 139s→3, lint 50s→1, mobile 8s→1).

GitHub charges **$0/minute for self-hosted runners** — you pay only for the machine. A ~$12/month
8 GB VPS provides ~43,200 minutes of wall clock a month, which covers 37,610 outright. That is a
fixed cost that does not climb with the commit rate, against a metered one that does.

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

Measured 2026-09-27 over **two independent samples, 240 `ci.yml` runs**:

| trigger | share of CI minutes | avg billable min/run | of the $300.88 month |
| --- | --- | --- | --- |
| `pull_request` | **63.4%** | 13.2 | ~$191 |
| `push` to `main` | **32.7%** | 13.5 | ~$98 |
| `workflow_dispatch` | **3.9%** | **1.2** | ~$12 |

Dispatch runs are cheap because most die in seconds — a skipped `full_e2e` no-op, a bad input, an
outage. The older of the two 120-run samples contains **zero** of them, so the steady-state share is
lower still.

**`ci.yml` is 84.3% of the whole Actions bill** — 350 of 415 billable minutes across the last 80 runs
of *every* workflow. Security Scan is 7.2%, Synthetic Journeys 4.1%, everything else under 3% each,
and those two already carry comments recording earlier cost trims. **Nothing outside `ci.yml` is
worth touching.**

Two more facts that close off the obvious ideas:

- **2.18 CI runs per PR** (109 `pull_request` runs across 50 distinct branches). That is the push
  discipline the ONE WIDE PR rule above is aimed at, and it is the biggest remaining lever.
- **`main` gets exactly one run per commit** — 51 commits, 51 runs, zero duplicates. No waste there.

🔴 **And `main`'s 32.7% is no longer waste at all — it is the price of the production deploy gate.**
Railway's Wait for CI reads the check suites on the pushed commit, so removing `push: main` from
`ci.yml` to save that ~$98 would silently un-gate production. See [deployment.md](deployment.md),
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
