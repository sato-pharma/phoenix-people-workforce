---
name: a-powershell-rmdir-of-a-spaced-path-is-blocked-as-a-system-path
description: "In the PowerShell tool, the worktree-triage skill's `cmd /c \"rmdir ...\"` on a path under `F:\\Phoenix Workforce` is refused before it runs (\"Remove-Item on system path 'F:\\Phoenix' is blocked\") because the guard splits the spaced path - remove a worktree's node_modules JUNCTION with [System.IO.Directory]::Delete($path, $false) instead, which deletes only the link."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 7e9b36e6-65d1-4de2-98a3-81e9a1a2d423
  modified: 2026-10-23T17:50:11.424Z
---

Measured 2026-10-23 while retiring two idle detached `.claude/worktrees/*` worktrees: the PowerShell tool refused the whole script with `Remove-Item on system path ''F:\Phoenix' is blocked. This path is protected from removal.` The `rmdir` token (an alias of Remove-Item) beside a path containing a space made the guard read the path as `F:\Phoenix`. Nothing ran: the worktrees, the junction and the primary's `node_modules` (65 top-level entries) were all unchanged afterwards.

**Why:** the triage skill (step 5) and the older notes prescribe `cmd /c "rmdir ..."`, and that exact text trips the guard in the PowerShell tool for every path under `F:\Phoenix Workforce`.

**How to apply:** before `git worktree remove`, take the `node_modules` junction out with `[System.IO.Directory]::Delete("$wt\node_modules", $false)` after checking `(Get-Item -LiteralPath $nm -Force).LinkType -eq 'Junction'`. The `$false` makes it non-recursive, so it removes the link and never its target. Then run `git -C <primary> worktree remove <wt>` with no `--force`, and check the folder is gone with `Test-Path`. Related: [[archiving-a-session-does-not-remove-its-claude-worktrees-folder]] (`new-session.mjs --remove` refuses `.claude/worktrees` folders, so the manual order applies) and [[prove-a-husks-junction-is-not-load-bearing-before-deleting-it]] (count the primary's package links that point into the folder first: 0 of 69 here).
