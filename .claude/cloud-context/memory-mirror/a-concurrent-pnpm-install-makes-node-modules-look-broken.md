---
name: a-concurrent-pnpm-install-makes-node-modules-look-broken
description: "Mid-install the shared node_modules is briefly missing packages (next vanished, 63 entries → 61), so a health check run right after removing a worktree's junction reads as \"I deleted through the link\" — find the running install before believing it."
metadata:
  node_type: memory
  type: project
  originSessionId: 3c1b7da3-77e1-454b-94d7-22abe2fead0b
  modified: 2026-10-03T04:19:56.087Z
---

Retiring `_wt-crm-audit` on 2026-10-03 produced a false alarm worth not repeating.

**The safe removal itself.** A worktree's `node_modules` is a **junction** to the primary's
(`Directory, ReparsePoint`, target `…\phoenix-workforce\node_modules`). Remove it with
`cmd /c rmdir "<path>\node_modules"` — that deletes the LINK only — then `cmd /c rmdir` the empty
folder. **Never `rm -rf` it in git-bash**, which treats the junction as a directory and can recurse
into the primary's real `node_modules`, breaking every session on the machine.

**The false alarm.** I counted the primary's `node_modules` before (63 entries) and after (61) the
junction removal, and `next` was absent — which reads exactly like having deleted through the link.
It was not: another session was running `pnpm run repo:doctor --fix --no-auth`, which spawned
`pnpm install` against the shared `node_modules` in that same second (`.pnpm` and `.bin` rewritten
at 07:18:04). Seconds later the install exited, `next` was back and the count was 63 again.

**So before concluding you damaged it:** look for the running process —
`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'pnpm|install' }` —
and re-count after it exits. A dip during an install is normal; a "repair" launched on that reading
is how a real break would start. The same window also makes any other session's build or dev server
fail for reasons nothing in its own work explains.

**And a worktree can disappear under you:** that same `repo:doctor --fix` removed `_wt-crm-audit`
between two of my commands (`git` answered "not a git repository" mid-check) and retired other
`_wt-` folders in the same pass. Nothing was lost — both branches were pushed and merged — but
re-read `git worktree list` rather than trusting a listing from a minute ago.
See [[a-worktree-husk-is-pinned-by-the-session-not-its-cwd]].
