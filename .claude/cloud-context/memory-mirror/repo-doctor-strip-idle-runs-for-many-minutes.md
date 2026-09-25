---
name: repo-doctor-strip-idle-runs-for-many-minutes
description: "repo-doctor --strip-idle takes many minutes to delete ~900k paths; measuring mid-run reads as \"it did nothing\" — check for the live node.exe before concluding anything."
metadata: 
  node_type: memory
  type: project
  originSessionId: 716ff586-e100-4cd1-bc1e-2e4e8fcfae38
  modified: 2026-08-12T16:46:41.101Z
---

`node scripts/repo-doctor.mjs --strip-idle --force` deleting ~900,000 path entries on this
Windows box runs for **many minutes** with no incremental output — it prints each `strip` line
only after that worktree's deletion completes.

On 2026-08-06 this produced a confidently-wrong call: a `Get-ChildItem -Recurse` count taken
while it was still running reported `_wt-counters/node_modules` at 67,397 entries, and free RAM
unchanged, so the run was reported as "did not take effect". It had in fact already stripped
three worktrees; the walk was racing the deletion.

**Why:** the scan itself takes minutes across ~1M paths, so the numbers it returns are a smear
across a moving target, not a snapshot.

**How to apply:** before concluding a strip failed, run
`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId, CommandLine` and
look for `repo-doctor.mjs`. If it is there, `Wait-Process -Id <pid>` instead of measuring.
Compare `-> N total path entries` from a full read-only `repo:doctor` run against the baseline —
never a partial directory walk. Related: [[strip-worktree-payload-before-removing-it]],
[[dont-foreground-watch-long-pipelines]].

**2026-08-08 addendum: even bare `repo-doctor.mjs` with NO flags costs ~70s.** Measured
`real 1m10.936s` / `user 0.121s` / `sys 0.076s` — almost entirely disk-wait, because the full
inventory walk over every live worktree runs unconditionally before any flag is even checked, not
just for `--strip-idle`. [[ram-guard-routine-every-30-min]] throttles its calls to hours apart
because of this baseline cost, not just the much larger `--strip-idle` cost above. Also: a `git
worktree remove` on a large worktree can itself run past a couple of minutes and get killed by a
short tool timeout mid-deletion — see [[git-worktree-remove-can-timeout-and-partially-delete]].

**2026-08-12 addendum: `--force` in the command above is not optional in practice — BOTH mutating
modes refuse while more than one session is live.** `--fix` and `--strip-idle` share one
concurrent-session guard that **fails closed**: `>1` session aborts, and so does *failing to
determine the count*. With this box's normal 4–11 sessions, plain `--fix` / `--strip-idle` **never
mutate anything** — both exited 1 with:

> repo-doctor aborted — 9 Claude Code sessions are running. … Close the others, or pass --force if
> you are sure.

The guard sits **after** the full inventory walk, so you pay the ~70s+ scan before learning it
refused. Budget for that, and expect the owner to have to close sessions or authorise `--force`
before either mode does anything.

**Do not reach for `--force` casually — 2026-08-12 gave live proof of what the guard is for.** Two
runs minutes apart showed live worktrees 29 → 28, files 772,176 → 711,635 and RETIRABLE 4 → 3:
another session retired `_wt-vs-target` *while this one was scanning*. That concurrent mutation is
exactly the scenario the guard names. Also worth knowing: the background-task notification reported
**exit 0** for a run whose real exit was **1** — read the output file, per
[[background-task-notification-exit-code-is-the-wrappers]].

**With `--force` the run itself was safe: `--force` waives ONLY the session guard, never the
per-worktree proofs.** Measured 2026-08-12: **6 stripped, 405,306 path entries reclaimed**, and the
5 skips were all correct — 3 dirty (`agent-a3a1e65a…` 4 files, `_wt-office-lock` 16,
`_wt-lineoverride` 4), 1 unpushed, and `_wt-do-onephase` *"touched 2 min ago — a session may be
mid-edit"*, i.e. it declined to pull `node_modules` out from under a live session. The idle
threshold is the thing actually protecting other sessions, not the guard `--force` removes.

**🔴 But the RETIRABLE list checks uncommitted files and NOT unpushed commits — the two passes in
this one script disagree.** `scripts/repo-doctor.mjs` line ~333 builds its warning as
`const note = m.dirty ? "-- N uncommitted file(s), review before removing" : ""` — dirty files only.
So for `_wt-mm-closing` it printed a clean, unqualified

```
git worktree remove "F:\Phoenix Workforce\_wt-mm-closing"
git branch -D codex/marketing-manager-monthly-closing
```

while **the `--strip-idle` pass in the same run refused that very worktree** with *"2 commit(s) not
on any origin ref — not backed up."* Follow the RETIRABLE block verbatim and you delete unpushed
commits with no warning; `git branch -D` then leaves them reachable only as dangling objects.

Not hypothetical — another session did exactly that mid-run. Recovery worked:
`git fsck --no-progress | awk '/dangling commit/{print $3}'`, date-sort with
`git log -1 --format='%ci|%s'`, then `git branch rescue/<name> <tip>`. Nothing was lost that time —
diffing the rescued tip against `origin/main` across exactly the files those commits touched
returned **only `+` lines** (main ahead, nothing unique below). **Read the diff DIRECTION, not the
line count**: a non-zero count alone reads as "real work at risk" and is usually just main moving on.

**How to apply:** before running any RETIRABLE block, check unpushed separately —
`git -C <wt> rev-list --count --not --remotes HEAD` — because the report will not tell you. Related:
[[not-remotes-flips-when-remote-refs-are-pruned]], [[merged-pr-does-not-make-a-worktree-retirable]].

**Read [[repo-doctor-strip-idle-cannot-run-with-sessions-open]] too — cross-linked 2026-08-23.** It
is the fuller file, and carries the one way this tool can destroy something: `idleMinutes()` is NOT
a liveness check, so a long-running job that writes nothing into the worktree reads as idle and
`--strip-idle --force` will pull `node_modules` out from under it.
