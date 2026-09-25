---
name: copilot-worktrees-outside-agents-md-conventions
description: "GitHub Copilot creates its own worktrees at C:\\Users\\satoh\\scoop\\buckets\\copilot-worktrees\\phoenix-workforce\\ — a fourth worktree location AGENTS.md's conventions don't name and the worktree-triage skill's scan does not cover."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-08-08T20:50:05.932Z
---

`git worktree list` on 2026-08-08 showed 7 worktrees rooted at
`C:\Users\satoh\scoop\buckets\copilot-worktrees\phoenix-workforce\`, branch names like
`gawish-1997-automatic-carnival` and `gawish-1997-fictional-parakeet` — auto-generated-looking
names distinct from this repo's own `codex/<task>` or `claude/<name>` conventions. This is
GitHub Copilot's coding-agent worktree management, a completely separate tool from Claude Code.

**Why this matters:** AGENTS.md section 5 names exactly three sanctioned worktree locations
(sibling `_wt-<task>` dirs, `.claude/worktrees/`, `.codex-worktrees/`), and
[[worktree-triage]]'s orphan sweep only looks at `_wt-*` at the repo root and
`.claude/worktrees/`. Neither mentions this fourth location. `scripts/repo-doctor.mjs`'s
`addFrom()` calls are similarly scoped to the primary repo root and its parent directory — this
C: drive path is neither, so repo-doctor's inventory, husk detection, and `--strip-idle` all have
a structural blind spot here. A RAM/disk audit that only trusts `repo-doctor.mjs` or the
worktree-triage skill will silently miss whatever this location is holding.

**How to apply:** when doing a full worktree/disk inventory (not just the routine
[[ram-guard-routine-every-30-min]] covers, which also does not touch this path — it only calls
into `repo-doctor.mjs`), separately check
`git -C "F:\Phoenix Workforce\phoenix-workforce" worktree list` for any entry rooted under
`scoop\buckets\copilot-worktrees\` and treat it as a different tool's domain: it may have its own
active/idle state and its own cleanup mechanism, so do not assume this repo's safety rules
(session-count guard, xlsx rescue-scan, etc.) apply there without checking first. Not yet
investigated: whether Copilot's own tooling already retires these on its own schedule.
