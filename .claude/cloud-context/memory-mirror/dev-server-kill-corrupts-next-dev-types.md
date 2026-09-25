---
name: dev-server-kill-corrupts-next-dev-types
description: "Killing a Next.js dev server mid-write leaves a truncated .next/dev/types/routes.d.ts that fails typecheck and blocks git push — delete .next/dev, don't debug your own code"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f1ea15f-81e9-4172-888c-40dd3d8fefd9
  modified: 2026-08-01T04:44:04.342Z
---

Stopping a `next dev` server (TaskStop, Ctrl-C, force-kill) can leave
`.next/dev/types/routes.d.ts` **truncated mid-token**. The next `tsc --noEmit`
then reports a burst of syntax errors — `TS1005 ';' expected`, `TS1109
Expression expected`, `TS1160 Unterminated template literal` — all pointing at
that one generated file, with line numbers near the end of it.

Hit on 2026-08-01 in worktree `_wt-team-cal-dedup`: the repo's **pre-push hook**
runs lint + typecheck, so this blocked `git push` with `BLOCKED: typecheck
failed` even though the committed source was clean and `check:harden` had passed
green minutes earlier.

**Why:** it's a build artifact Next.js regenerates, not source. `.next/` is
gitignored, so the corruption is invisible in `git status` / `git diff` — which
makes it read like a real type error in your own change.

**How to apply:** if typecheck errors are confined to `.next/dev/types/*` (or any
path under `.next/`), do NOT debug your diff. Delete the directory and re-run:

```
Remove-Item -Recurse -Force .next/dev
```

Tell it apart from a genuine failure by the file path alone — errors in
`src/`/`app/`/`tests/` are yours; errors in `.next/` are the artifact. Related:
[[typecheck-incremental-false-green]] (the inverse — a warm cache reporting a
false *green*), and [[git-push-to-origin-hangs-retry-immediately]], which fired
on the very next push attempt in the same session.
