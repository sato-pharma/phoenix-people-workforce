---
name: github-holds-a-workflow-that-reads-every-secret-as-malicious
description: "A workflow that reads toJSON(secrets) and writes the values out is held by GitHub as \"may be malicious\" — every run ends action_required with zero jobs until the owner clicks Approve and run, PER RUN; the API lags the page."
metadata:
  node_type: memory
  type: project
  originSessionId: 9dcd167c-57b6-4a45-b46a-2fab7931a78b
  modified: 2026-11-18T23:01:58.661Z
---

On 19 Nov 2026 (credentials audit finding 1, PR 544) `move-secrets-to-environments.yml` — which reads `toJSON(secrets)` and pipes each value into `gh secret set --env main-secrets` — was held by GitHub on every dispatch: conclusion `action_required`, ZERO jobs, no log, no annotation. The reason is only on the run page (not in `gh run view`, not in the check-run output): "GitHub detected that this workflow file may be malicious. It will not run until someone with write access approves it."

- The approval is **per run**, not per file: run #1's approval never registered, a fresh dispatch was held again, and only clicking **Approve and run** on run #2 started it (it then shows "Re-run triggered", `run_attempt: 2`).
- The REST API lagged the page by several seconds after the click — read the page (Claude in Chrome, read only) before calling an approval missing.
- The click is the owner's (a safety gate on his repository); never approve it for him. Re-writing the workflow to dodge the detector is evasion — don't.
- Arm any temporary token BEFORE his click and have a background watcher delete it when the run ends or after a deadline — a job reads its secrets at start, so the token must already exist.

Result that night: 62 production secrets moved into `main-secrets` (only `main`), the 2 Railway tokens also into `urgent-deploy`, the 62 repository-wide copies deleted on his word, 15 public/staging/Telegram names stay repository-wide; `secret-drift-check` ran green after the deletion. Rules: `.claude/rules/engineering.md` "Secrets and environments"; account `docs/security/secret-rotation.md`.
