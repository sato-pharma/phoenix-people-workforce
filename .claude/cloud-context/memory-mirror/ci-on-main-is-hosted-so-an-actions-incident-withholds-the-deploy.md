---
name: ci-on-main-is-hosted-so-an-actions-incident-withholds-the-deploy
description: "ci.yml takes the self-hosted box ONLY on pull_request, so every push to main runs on ubuntu-latest — during a GitHub Actions incident PR checks stay green while main's run is dropped and Railway withholds the production deploy; and the suite that withholds it is usually NOT ci.yml"
metadata:
  node_type: memory
  type: project
  originSessionId: d96338c4-b2ab-41ed-aa4e-ed85e9af64ce
  modified: 2026-10-05T20:46:22.726Z
---

`ci.yml`'s four `runs-on` lines are one expression that picks `vars.CI_RUNNER_LABEL` only when
`github.event_name == 'pull_request'`. **A push to `main` therefore always lands on
`ubuntu-latest`** — so a GitHub hosted-runner outage leaves PR checks perfectly green on the
self-hosted box while every `main` run is dropped, and Railway's "Wait for CI" withholds the
production deploy. Measured 2026-10-05: the self-hosted runner read `online busy=false` throughout.

**Why:** the deploy gate waits on EVERY check suite on the merge commit, and after 2 hours Railway
marks that deploy SKIPPED for good. So a hosted-runner outage is a silent production-deploy outage
that a green PR cannot show you.

**How to apply:**
- A job `cancelled` at ~15 minutes with **no steps and an empty `runner_name`** was never picked up
  by a runner. It is capacity or a platform incident, never a failing test — `gh run view
  --log-failed` prints **nothing** for it, which reads as "no failure found".
- **Read the status page before blaming the repo, the bill or your own change:**
  `curl -s https://www.githubstatus.com/api/v2/summary.json`. On 2026-10-05 an "Incident with
  Actions" opened 19:11 UTC; the last hosted job to succeed was 19:19 and everything from 19:37 was
  dropped. The Actions **billing** API needs a `user` scope no session here has, so a spending-limit
  theory cannot be confirmed from a session — do not assert it.
- **The suite that withholds a deploy is usually not `ci.yml`.** `21f76daf3` had `ci.yml`
  **success** and was still WITHHELD, held by two `Synthetic Journeys (production smoke)` runs and
  two Dependabot runs — all `ubuntu-latest`. Read every run on the commit, not just CI.
- `gh api ".../actions/runs?head_sha=<short sha>"` returns an **empty list** for an abbreviated sha,
  which reads as "main has no verdict". Resolve the full 40 characters first
  (`gh api repos/<repo>/commits/<short> --jq .sha`).
- Repair is a re-run on the **same sha** inside Railway's 2-hour window (AGENTS.md §2 — never cancel
  a stuck `main` run and walk away), and only once the status page says Actions is operational again;
  re-running into the outage just spends the window. Never re-merge and never redeploy.

Related: [[a-declined-tool-call-is-not-proof-the-change-did-not-land]] — the same discipline of
reading the live source rather than the tool's own verdict.
