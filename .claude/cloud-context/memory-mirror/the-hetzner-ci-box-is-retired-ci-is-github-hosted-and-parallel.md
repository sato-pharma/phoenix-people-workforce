---
name: the-hetzner-ci-box-is-retired-ci-is-github-hosted-and-parallel
description: "Owner 2026-10-19 retired the Hetzner CI/preview box (\"source of slowness\"): ci.yml is six parallel GitHub-hosted jobs (validate, static, unit x3, checks), remote-check reads the PR's GitHub run, the pre-push \"remote-check test\" step is gone, phx-live/phx-preview are dead — never route CI to a machine of ours or pitch hardware."
metadata:
  node_type: memory
  type: project
  originSessionId: 972237fc-5fa0-4625-9335-4116607ef38b
  modified: 2026-10-19T15:15:23.721Z
---

Owner, 2026-10-19: *"make all ci actions to be on github and be able to make checks on one or more or ten or even 100 at the same time … as fast as you can safely without skipping any check"* and *"retire the hetzner box and do not use it … it is the source of slowness"*. Shipped in PR 6163 (branch `codex/ci-github-only-parallel`).

- `ci.yml` jobs: `validate` (build + login smoke, required), `static` (contracts, audit, lint, typegen, the type gate), `unit` (3 parallel jobs x 2 shards, each writes a coverage record), `checks` (required; the gate over `static` + `unit` plus `scripts/ci-unit-coverage.mjs`). All literal `ubuntu-latest`; `tests/ci-runner-switch.test.ts` fails anything else.
- `scripts/remote-check.mjs` now reads the pushed commit's PR run (or `--dispatch`es one); the retired flags `--wait/--no-wait/--free/--no-actions/--else-actions` are refused by name. `lockfile` goes through `.github/workflows/lockfile.yml`.
- The runner `phoenix-ci-ubuntu-8gb-nbg1-1` was stopped, disabled and deregistered on 2026-10-19; repo variables `CI_RUNNER_LABEL` and `CI_SELF_HOSTED` deleted. The box's only running service was that runner (phx-live was already not running). Deleting the Hetzner server itself is HIS click (money).
- Capability lost: the 2026-10-12 pre-push `remote-check test` for a push that adds a test file (GitHub runs only a commit origin holds). Replaced by `node scripts/check-contracts.mjs` (~8s) and the PR's `unit` jobs.

**Why:** the single 7.7 GB box serialised sessions' checks and was the slowness; GitHub-hosted jobs run in parallel with no queue of ours.
**How to apply:** never route CI to a self-hosted label, never pitch or use phx-live/phx-preview/the box, never put hardware to him as a Next step. Not decided, his call: Railway deploying a CI-built image digest, a GitHub organization (larger runners / higher concurrent-job cap). See [[no-hardware-purchase-for-the-ci-box]] and [[phx-preview-is-retired-phx-live-is-the-one-dev-server]].
