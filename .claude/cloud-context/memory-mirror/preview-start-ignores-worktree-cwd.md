---
name: preview-start-ignores-worktree-cwd
description: "Claude_Preview MCP preview_start always launches from the fixed primary working directory, never the worktree you cd'd into — silently tests the wrong code"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a61d2fea-0999-45f0-9c7e-e523d2cd9479
---

`mcp__Claude_Preview__preview_start` (and its launch.json) is tied to the session's
fixed primary working directory (`F:\Phoenix Workforce\phoenix-workforce`), NOT
wherever Bash last `cd`'d to. Running it while working in an isolated worktree
(e.g. `_wt-foo`) silently starts/reuses a `next dev` server rooted in the PRIMARY
worktree — your edits in the worktree never get served, and you'll see confusing,
seemingly-random test results (patched behavior that "doesn't work", changes that
"don't take effect" even after full restarts and `.next` cache clears).

**Why:** Discovered during a marathon debugging session (2026-07-02, [[resignation-contract-scope-check-audit-2026-07]]-adjacent work on `/workspace/marketing-requests`
redirect bug) — a patch appeared to have zero effect across ~10 restarts,
viewport-0x0 red herrings, and misleading `fetch()`/`curl` 200-status checks
(Next.js App Router's `redirect()` doesn't produce a classic HTTP 3xx for
Document-type requests — it embeds a `NEXT_REDIRECT` marker in the RSC payload
that only the hydrated client router acts on, so status-code-only checks are
worthless for detecting redirects either way). The actual root cause: `netstat`
+ `Get-CimInstance Win32_Process` showed the process on port 3000 had
`CommandLine` rooted at the PRIMARY worktree path, not the worktree directory —
`preview_start` never picked up the worktree's `.claude/launch.json` context.

**How to apply:** When verifying a fix made inside a git worktree:
1. Do NOT rely on `preview_start`/`preview_*` tools for worktree-scoped work —
   they test the primary worktree's server, not yours.
2. Instead launch `next dev` directly via Bash with an explicit port, backgrounded
   and detached from within the worktree: `cd <worktree> && (npx next dev --webpack -p <port> > log 2>&1 &)`.
3. Verify the server is actually rooted in the worktree via the startup log's
   "Detected additional lockfiles" warning or by checking `Win32_Process`
   `CommandLine` for the listening PID.
4. To check whether a Next.js Server Component `redirect()` actually fired for a
   given request, grep the raw HTML/RSC response for `NEXT_REDIRECT` (the
   digest looks like `NEXT_REDIRECT;replace;/target;307;`) — HTTP status alone
   (200 vs 3xx) does NOT reliably indicate whether `redirect()` fired.
5. Kill only the PID you yourself just spawned (verified via `CommandLine`) —
   never kill a process whose CommandLine points at the primary worktree path,
   since that's very likely another active session's legitimate server (see
   [[parallel-session-swarm-hazard]]).
