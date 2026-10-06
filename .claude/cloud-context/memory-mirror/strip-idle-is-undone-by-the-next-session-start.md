---
name: strip-idle-is-undone-by-the-next-session-start
description: repo-doctor --strip-idle reclaims nothing durable here - a worktree's node_modules is a JUNCTION to the primary's (so the "111,924 path entries" is tree-walk cost, never disk) and the SessionStart hook `sync-worktree-env.mjs --all` re-links every worktree whenever ANY session starts or compacts, measured 90 seconds after a strip on 2026-10-05. Report it as swept, never as space reclaimed.
metadata:
  type: reference
---

🔴 **`node scripts/repo-doctor.mjs --strip-idle` DOES WHAT IT SAYS AND THEN IT COMES BACK.** Measured
2026-10-05: it stripped `.claude/worktrees/youthful-hermann-3b1160` (idle 660 min, clean, fully
pushed) and printed `-111,924 paths`, and **a fresh junction existed at 19:52:07, about 90 seconds
later** — `CreationTime` proves it, not a guess.

**What re-creates it:** the **SessionStart** hook in `.claude/settings.json`,
`node scripts/sync-worktree-env.mjs --all` ("Provisioning node_modules + env in all worktrees"). It
sweeps EVERY worktree, not the starting session's own, and it fires on a plain session start **and on
a compaction**. With ~10 sessions open on this laptop the next one is always minutes away, so a strip
survives only until then. `node scripts/new-session.mjs <task>` sweeps all worktrees too.

**And the payload was never disk.** Both worktrees' `node_modules` are `Directory, ReparsePoint`
junctions pointing at `F:\Phoenix Workforce\phoenix-workforce\node_modules` — one copy on disk, linked
from each worktree. So the figure repo-doctor quotes is **path entries a tree-walking tool would
visit**, which AGENTS.md §5 already says is NOT why the machine or the app feels slow (disk sat
99.6-99.9% idle while the box was slow; free RAM is what binds). `.next` is the only part that is
real build output.

**How to apply:** run it when asked — it is the sanctioned command and it is harmless — but report it
as **swept, not as space reclaimed**, and never as a memory or disk remedy. If a worktree must stay
stripped, the thing to change is the SessionStart sweep, not the strip. A worktree touched inside the
**120-minute** guard is held back by name ("a session may be mid-edit") and that is correct — it is
another session's; `--strip-idle=N` sets the threshold and `--strip-idle=0` is refused.
🔴 **The offer line and the held-back line can quote the SAME number** (both read 111,924 here,
because the junction target is identical), so the figure does NOT tell you which worktree it is
about — read the names. A session misattributed it on 2026-10-05 for exactly that reason.
