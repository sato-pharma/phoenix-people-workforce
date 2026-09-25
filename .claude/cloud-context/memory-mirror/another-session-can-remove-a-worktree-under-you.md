---
name: another-session-can-remove-a-worktree-under-you
description: "A worktree can be torn down by ANOTHER live session while you are mid-check — .git vanishing under your commands reads like repo corruption but is a concurrent git worktree remove."
metadata: 
  node_type: memory
  type: project
  originSessionId: 38cac8f5-eef9-4ca8-9b4c-3c23b0534074
  modified: 2026-08-19T12:50:29.996Z
---

Hit 2026-08-19 while retiring `_wt-cv-rules` (PR #2202). Pre-checks ran clean at ~12:47 Cairo —
`git branch --show-current`, `git status --porcelain`, an untracked-file sweep, all normal. Four
minutes later the SAME folder produced:

```
fatal: not a git repository (or any of the parent directories): .git
find: './node_modules/.pnpm/bluebird@3.4.7': No such file or directory
```

**Nothing was corrupt.** Another session was running `git worktree remove` on it at that moment.
The tell is the combination, and all three appear together:

1. `<worktree>/.git` is gone — that file is the FIRST thing git deletes.
2. `git worktree list` flips the entry to **`prunable`**.
3. `find` errors on directories that existed when the walk started (node_modules tearing down).

A fourth, softer tell: the worktree list gains and loses unrelated entries between two of your own
commands (`_wt-lineoverride` disappeared and `_wt-do-extra-areas` appeared in the same window).

**Do not race it, and do not "repair" it.** The instinct at 4am is to re-run with `--force`, or to
re-create the worktree because the repo looks broken. Both fight a deletion that is already
succeeding. Stop, re-read `git worktree list`, and let it finish — the other session also deleted the
branch (`codex/cv-free-ocr-clean` was gone by the time I looked).

**What IS safe afterwards, and is usually left behind:** the husk. `git worktree remove` leaves
`node_modules/` with **zero regular files** — 1,476 dirs and 3,372 dangling symlinks in this case.
`node scripts/repo-doctor.mjs --fix --force` cleared it (4,848 path entries). Report mode first: it
classifies a zero-file husk as *safe to delete* and refuses anything holding even one file. See
[[repo-doctor-strip-idle-cannot-run-with-sessions-open]].

**Why:** this machine routinely runs 5+ interactive sessions (27 `claude` processes were live that
afternoon), and AGENTS §5 only forbids two sessions in ONE folder — nothing stops a second session
retiring a worktree the first is inspecting.

**How to apply:** before deleting a worktree, re-read `git worktree list` immediately before the
destructive command, not only at the start of the task. If the entry says `prunable` or its `.git`
is already missing, someone else got there first — verify and clear the husk, do not re-run the
removal. Related: [[worktree-remove-permission-denied-still-deregisters]],
[[gitignored-wt-scratch-makes-a-worktree-look-clean]].

## 2026-08-23 — the RETIRABLE verdict goes STALE, and that is the dangerous direction

Same class of race, but it points the other way and it can destroy work rather than merely confuse you.

**`repo:doctor` names the branch that was checked out AT SCAN TIME.** It listed
`.claude/worktrees/sweet-goldberg-103585` as retirable for PR #2330 `codex/drift-check-comment-resolved`.
Between that scan and the removal, a peer session had **checked out a different, UNMERGED branch in the
same folder** — `git worktree list --porcelain` read `branch refs/heads/codex/zz-backup-primary-keys`,
and its HEAD moved `3e7af49c → 32e4228b` inside a single exchange. It had also repopulated from 4,980 to
61,216 files. **Removing it on the strength of the doctor's line would have deleted live work.**

**So the RETIRABLE list is a candidate list, never an instruction.** Immediately before removing any
worktree, re-read `git worktree list --porcelain` for the path and confirm the branch is still the one
the verdict named, then confirm THAT branch merged with `gh pr list --head <branch> --state merged`
(squash-aware — AGENTS.md §2). A folder name tells you nothing; a peer reuses it.

**New tell for the removal-under-you race:** `git worktree remove <path>` fails with

```
fatal: '<path>' is not a working tree
```

**while `git branch -D <its branch>` in the same command SUCCEEDS.** Git refuses to delete a branch a
worktree holds, so a branch delete that goes through proves the worktree was already deregistered — by a
peer, in the window between your `git worktree list` and your removal. That is exactly what happened to
`_wt-hc-sync` here. Nothing was wrong; the peer simply got there first. Re-read the list and move on.
`git worktree prune` had nothing to do afterwards, and no husk was left behind.

**One claim above did NOT reproduce.** This file records `repo-doctor --fix --force` clearing a
1,476-dir / 3,372-dangling-symlink husk on 08-19. On 08-23 that identical shape **failed with `EPERM`**
and needed `rmdir /s /q`. Both observations stand as dated records — do not edit the 08-19 one — but
expect the failure and see
[[repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm]] for the mechanism and the remedy.

## 2026-08-23 (later) — the SAME folder, twice in one session, and the peer FINISHED it itself

`sweet-goldberg-103585` went stale **a second time within the same session**, which makes it a pattern
rather than an accident. At 16:40 it read `codex/zz-backup-enable-rls` (PR #2333, merged) — a verdict
that re-verified clean. Ten minutes later, immediately before removal, it read **`main` at `3e7af49c`**.
Minutes after that it was **gone from `git worktree list` entirely and its branch was deleted** — by the
peer, not by me. **The peer session was retiring its own worktree the whole time.**

🔴 **A retirable worktree with a LIVE transcript is that session's job, not yours.** Do not race it. The
owner asked for three removals; taking the third would have collided with a session mid-cleanup, and the
only reason it did not is that the liveness check ran first.

**The liveness test that decided it, and it is cheap:** read the newest `*.jsonl` mtime under
`~/.claude/projects/<slug>/`, where `<slug>` is the worktree path with `:` dropped and every `\` and
space turned into `-` (e.g. `F:\Phoenix Workforce\_wt-wa-reach` → `F--Phoenix-Workforce--wt-wa-reach`).

| Reading | Meaning |
| --- | --- |
| **no session dir** | nobody has ever run a session there — safe |
| last write **0–2 min** | a session is live in it RIGHT NOW — leave it, it is theirs |
| last write hours+ | stale; still re-check the branch before acting |

Both worktrees that were safe to remove (`_wt-attend-nonemp`, `_wt-wa-reach`) had **no session dir at
all**; the one that was not had **0 min**. Perfect separation, in about a second.

⚠️ **Do NOT probe liveness by grepping process command lines for the target path — you match YOUR OWN
probe.** A `Win32_Process … CommandLine -like "*$target*"` scan reported PID 26732 referencing both
target worktrees; the PID was the PowerShell process running that very query, and it was gone a second
later. Check `ProcessId -ne $PID`, or use the transcript-mtime test above, which cannot self-match.

**Husk note:** a clean `git worktree remove` does NOT always leave the 3,372-junction farm this file and
[[repo-doctor-fix-cannot-delete-a-wt-husk-pnpm-junctions-eperm]] describe. `_wt-attend-nonemp` left
**nothing**; `_wt-wa-reach` left a husk of **0 files, 0 dirs, 1 reparse point** — a single `node_modules`
junction. **Measure before reaching for `rmdir /s /q`.** A one-junction husk clears with
`[System.IO.Directory]::Delete($junction, $false)` then `Delete($dir, $false)` — no recursive force
delete, so it does not trip the `Remove-Item on system path '/s'` guard that blocks a
`cmd /c rmdir /s /q` string outright.
