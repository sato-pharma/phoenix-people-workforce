---
name: branch-up-to-date-rule-disabled-2026-08-05
description: "\"Require branches to be up to date\" was turned OFF on main 2026-08-05 to stop Actions cost — do NOT run `gh pr update-branch` reflexively any more; AGENTS.md §2 still says the opposite."
metadata: 
  node_type: memory
  type: project
  originSessionId: d460a4ef-6b05-4d9d-8830-b68409d4aed4
  modified: 2026-08-22T22:18:54.502Z
---

On **2026-08-05** the owner approved disabling **"Require branches to be up to date before
merging"** on `main` (`required_status_checks.strict` → `false`). The required checks were
**unchanged and still gating**. `enforce_admins: true`, force-pushes and deletions still blocked,
conversation resolution still required, `required_approving_review_count: 0`.

*Count corrected 2026-08-23:* this said **5** required checks and listed `sast-scan` as the fifth.
Verified live against `gh api …/branches/main/protection`, there are **4** — `validate`, `lint`,
`typecheck`, `secret-scan`. Semgrep's `sast-scan` was deliberately never restored and no longer runs
at all (`.github/workflows/sonarqube.yml:53`). `strict: false` is confirmed still in force, which is
the fact this file exists for. See [[github-personal-account-no-ghas-oss-scanning]].

**Why:** it was the dominant GitHub Actions cost driver. July billed 5,933 Linux minutes ($17.26
net); Aug 1–5 alone billed 11,391 minutes ($50.00 net) — ~12x the daily burn, tracking to $400+/mo.
With **278 PRs merged Aug 1–5 (74 on Aug 5 alone)**, every open PR fell behind `main` within minutes
of any merge, and each `gh pr update-branch` moved the head SHA → **all 5 checks re-ran from scratch
and the prior green run was discarded**. Measured 3–16 CI runs per branch in one day
(`codex/cairo-vacancy-current-date` ran CI 16 times). Cost is ~16 billed min per head commit
(CI 10.2 + Security Scan 5.7), so re-runs scaled as open-PRs × merges-per-day, not additively.

**How to apply:**
- **Do NOT run `gh pr update-branch` out of habit.** A PR behind `main` is no longer refused. Run it
  only when the change genuinely depends on something newly on `main`. Each one costs ~16 Actions
  minutes and throws away a green run.
- 🔴 **[AGENTS.md](AGENTS.md) §2 is now STALE** — it still states "protection sets 'require branches
  to be up to date'" and describes the refusal + `update-branch` recovery as mandatory. Believing it
  re-creates the exact cost this removed. Fix pending owner approval to commit.
- The accepted trade-off: a PR validated against an older `main` can now merge, and
  [merging ships to production instantly](railway-merge-is-the-production-deploy.md). Two PRs that
  each pass alone but conflict semantically can now both land. Watch for that when merging several
  PRs touching the same module in one sitting.
- SonarQube was separately retired to `workflow_dispatch` only (PR #1790, merged 15:38Z the same
  day) — it had been running ~155 PR scans/day at ~5 min each.
- Related: [ci-jobs-failing-in-seconds-means-billing-not-code](ci-jobs-failing-in-seconds-means-billing-not-code.md)
  (the spending cap hit at 20:24Z that froze all merges), and
  [merge-blocked-says-checks-but-means-behind](merge-blocked-says-checks-but-means-behind.md) —
  that "BLOCKED = behind" symptom should now largely disappear.
