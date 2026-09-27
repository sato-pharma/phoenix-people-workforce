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

## 🔴 The safety rules

1. **PRIVATE REPOSITORIES ONLY.** A self-hosted runner executes whatever a workflow tells it to.
   On a **public** repo, anyone opening a fork pull request runs arbitrary code on the host.
   `phoenix-people-workforce` is private, so only accounts with repository access can trigger it —
   the case GitHub's own guidance considers acceptable. **If this repo is ever made public, remove
   the runner first.**
2. **Never on the owner's laptop.** `AGENTS.md` §5 records that the 16 GB machine already
   hard-freezes under a build plus a dev server. A CI runner there guarantees it.
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
