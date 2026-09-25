---
name: worktree-remove-permission-denied-still-deregisters
description: "git worktree remove that fails with 'Permission denied' is NOT a refusal — it still deletes the registry entry, so the directory becomes an orphan the instant the command 'fails'; never re-classify it as KEEP the way the worktree-triage skill's step 5 says to."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f6d1381-b399-46c3-bd85-05ad11145943
  modified: 2026-08-19T20:21:41.912Z
---

**What happened (2026-08-16).** Worktree triage, 6 approved removals. Five ran clean. The sixth,
`.claude/worktrees/hungry-moser-87e420`, printed:

```
error: failed to delete '...hungry-moser-87e420': Permission denied
```

That is a non-zero exit and reads like a refusal. **It was not.** The registered-worktree count
still went 14 → 8 — all six were deregistered, including the one that "failed". Git had already
dropped `.git/worktrees/<name>` and the worktree's own `.git` file before it hit the undeletable
directory node.

**Why this matters:** [[worktree-triage]] step 5 says "If `git worktree remove` refuses (dirty),
re-classify as KEEP — dirty and report; do not force." Following that literally here is wrong. The
worktree is gone from git's point of view; what is left is an **orphan** (step 1b) — unregistered,
no `.git`, resolving up into the primary checkout — which is exactly the hazard class the skill
exists to eliminate. Left as "KEEP", it would never be swept again by any `git worktree list` check.

**How to apply:**
1. **Never judge `git worktree remove` by its exit code alone.** After every batch, re-count
   `git worktree list --porcelain | grep -c '^worktree '` and confirm the drop equals the number
   attempted. A "failed" removal that still lowered the count deregistered successfully.
2. **A `remove` that errors on the directory has created an orphan, not preserved a worktree.**
   Re-classify it as ORPHAN and finish it with plain `rmdir /s /q`, not with `git worktree remove`
   again (git no longer knows about it and will say "is not a working tree").
3. **Exit 32 on an already-empty directory means it is a live process's current working directory.**
   Confirmed here: `rmdir` emptied the contents (repo-doctor afterwards reported it as
   `0 dirs, 0 dangling links`) but could not remove the final node. Nothing is corrupt and no handle
   needs breaking — do NOT kill processes. It becomes deletable **only once that session exits**;
   `pnpm run repo:doctor --fix` clears it then, and not before. **`--fix --force` does NOT help**
   — the force flag skips the concurrent-session guard, not the Windows lock, so it prints
   `FAILED … EPERM` and removes nothing (measured 2026-08-19: 0 of 2 husks removed, both were
   live sessions' cwds). See [[repo-doctor-strip-idle-cannot-run-with-sessions-open]].
   **Refined 2026-08-19: the holder is not necessarily YOUR session, and a stale
   `.claude/session.lock` does not mean the folder is free.** `exciting-lumiere-c85025` held a lock
   naming PID 33032, which `Get-Process` proved dead — yet `rmdir` (Git-Bash) and `Remove-Item`
   (PowerShell) both still failed as busy, and it was not this session's cwd either.

   **The holder is the other CCD session's own process, and you can name it.** Do not bother with
   `Get-CimInstance Win32_Process` — the path never appears in a command line, and `rmdir` fails
   identically whether or not you `cd` your own shell away first. Instead call
   **`mcp__ccd_session_mgmt__list_sessions`** and match each husk against the `cwd` field. Measured
   2026-08-19, all four husks resolved instantly: `elegant-wilbur-e405a4` → the #2220 session
   (running), `exciting-lumiere-c85025` → the #2223 session (running), `pensive-lalande-049952` →
   the #2206 session, and `determined-gates-9dc719` → the current session. A session's
   `.claude/session.lock` PID can be long dead while the session process itself is very much alive,
   so **the lock file is not the holder** — `list_sessions` is.

   Consequence: `--fix --force` cannot ever help here. The guard `--force` skips is the
   session-count check; the thing actually blocking deletion is Windows refusing to remove a live
   process's working directory. The only release is that session ending. Since a husk holds zero
   files and reclaims zero path entries, **leaving it is the correct answer** — do not hunt handles,
   do not kill processes, and do not archive someone's running sessions to tidy a cosmetic folder.
4. Distinguish this from a genuine dirty-tree refusal, which fails *before* deregistering and leaves
   the count unchanged. The count is the only reliable discriminator.

Related: [[git-worktree-remove-can-timeout-and-partially-delete]] (the other partial-failure mode —
that one leaves real files behind and is far more dangerous), [[orphaned-worktree-symlink-skeletons]],
[[phantom-worktree-not-in-git-worktree-list]], [[strip-worktree-payload-before-removing-it]].
