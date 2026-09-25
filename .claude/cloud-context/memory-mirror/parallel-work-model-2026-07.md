---
name: parallel-work-model-2026-07
description: "Owner-approved workflow — one local boss session, cloud sessions for parallel tasks, ≤2-3 worktrees with delete-on-merge CLEAN ritual"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ebd520b9-df41-447e-bd6f-272417759a86
---

Owner policy set 2026-07-17 (in AGENTS.md via PR #1105 — codified there; this memory is the pointer + context).

**Why:** Owner runs many concurrent tasks. Two past failure modes: (1) two interactive sessions sharing one checkout → git corruption incidents; (2) worktrees never deleted → 26 folders, 15 full node_modules copies (~12GB, millions of files) → 16GB laptop froze, Claude Code "slow as a turtle" (RAM 12.4/15.8GB, ~10 claude processes).

**How to apply:**
- ONE local interactive session (control tower: credentials/gcloud/browser-verify/merge decisions). Parallel independent tasks → **cloud sessions (Claude Code web)**, each ends in a PR; CI+auto-deploy handle the rest.
- ~~Local worktrees ≤2-3 alive; `npm ci` only when the task needs build/typecheck (pre-push gate needs node_modules — install right before push).~~ **[RETARGETED 2026-08-27 — three separate things here are now false. (a) The pre-push gate is GONE (`.git/hooks` holds only `pre-push.bak-20260730`). (b) The ≤2-3 ceiling was measured against a ~19.79 GB commit limit; the pagefile has since been re-pinned and the limit floats from ~47.79 GB up, so **sessions were never the ceiling** — budget ~5 concurrent HEAVY jobs and read headroom live with `node scripts/new-session.mjs --status`. (c) Never `npm ci`/`pnpm install` inside a worktree — it duplicates ~1.9M path entries and `pnpm run` purges `node_modules` outright; **junction it from the primary** and invoke `node` directly. See AGENTS.md §5.]**
- **Delete-on-merge**: after each PR merges, ask owner "CLEAN?" → verify (dirty=0 or only generated files I created; branch ancestor of origin/main; no UNTRACKED xlsx/pdf — the 8 tracked repo docs appear in every worktree and are fine) → `git worktree remove` + `git branch -d`. Never remove locked `.claude/worktrees/*` (other live sessions) or worktrees with modifications I didn't create.
- node_modules purge from kept-idle worktrees is safe (regenerable) — freed ~6GB across 6 worktrees in the 2026-07-17 sweep.
- 2026-07-17 sweep result: removed 5 merged worktrees (+5 branches), purged 6 node_modules. KEPT + flagged: `_wt-other-approvals-leak` (branch merged but 4 modified source files nobody claimed — approvals-hub pages, action-center service, hrefs), `_wt-ci-deploy-speed` (other session's unpushed superseded branch — owner to drop), phantom no-branch folders (_wt-crm-sync-telegram, _wt-crm-tz-fix, _wt-employee360-redesign, _wt-expenses-outstation-merge, _wt-offer-*, _wt-outstation-submit-notify, _wt-probation-intel, _wt-portal-speed — not in `git worktree list`, no node_modules, detached unmerged tips; low priority).
- pnpm migration: **DONE 2026-07-17 — PR #1108 open, awaiting owner merge decision** (see [[pnpm-migration-2026-07-17]]; worktree `_wt-pnpm-migration` alive until merge+CLEAN ritual). [[windows-defender-dev-exclusions]] exclusion for "F:\Phoenix Workforce" + node.exe still on the owner to run as admin.

[[gcp-speed-audit-2026-07-17]] [[parallel-session-swarm-hazard]] [[feedback-parallel-session-pr-collision]]
