---
name: claude-project-dir-is-the-sessions-own-worktree
description: "CLAUDE_PROJECT_DIR resolves to the session's OWN worktree in every hook layout here, contrary to what the public docs imply — measured, not assumed. It is ABSENT from Bash children, which get CLAUDE_CODE_SESSION_ID instead."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a80d0f9-5a91-4f2d-b3a9-d24d3a4bf271
  modified: 2026-09-18T01:57:50.251Z
---

`CLAUDE_PROJECT_DIR` in a SessionStart hook is the session's **own** tree in all three layouts on
this machine. Measured 2026-09-12 with a probe hook injected via `claude --settings`, not inferred:

- nested `.claude/worktrees/hopeful-bartik-286279` -> that nested worktree
- sibling `_wt-claude-config-audit` -> that sibling worktree
- primary `phoenix-workforce` -> the primary

This matters because Claude Code's worktrees documentation has a section titled "Hook paths don't
follow the worktree" saying `CLAUDE_PROJECT_DIR` "stays put" at the project root. That describes a
session that STARTS in the main checkout and then moves into a worktree. Sessions here open directly
in the worktree directory, so the two readings diverge and only the measurement settles it.

**Not in a Bash child** (measured 2026-09-18): a script run from the Bash tool gets no
`CLAUDE_PROJECT_DIR` — only hooks do. It does get `CLAUDE_CODE_SESSION_ID`, the same value hooks
receive as `session_id` and `session-lock.mjs` stores in every lock. Key anything a script must tie
to its session on that id, never on the folder.

**Why:** `.claude/settings.json` resolves every hook's `DIR` as
`${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}`. If `CLAUDE_PROJECT_DIR` were the primary,
`sync-worktree-env.mjs` (guarded by `[ -f "$DIR/.git" ]`, true only in a worktree) would never run,
`session-lock.mjs` would lock the wrong tree, and `worktree-exit-guard.mjs` would inspect the wrong
tree — all silently, because every hook ends in `|| true`.

**How to apply:** treat the env var as the session's own tree, and do not "fix" that settings.json
expression back to bare `git rev-parse`. If a future hook must distinguish worktree from primary,
read the `cwd` field from the hook's stdin JSON and compare. Re-measure with a `--settings` probe
hook before trusting any doc claim about this. See [[permission-allowlist-rules-can-embed-a-live-secret]].
