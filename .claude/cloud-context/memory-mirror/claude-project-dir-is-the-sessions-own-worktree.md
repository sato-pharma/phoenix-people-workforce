---
name: claude-project-dir-is-the-sessions-own-worktree
description: "CLAUDE_PROJECT_DIR is the session's own worktree ONLY in a CLI session; in the DESKTOP APP every hook gets the PRIMARY and runs in it (measured 2026-11-18), so folder-keyed hooks read the transcript's project folder through scripts/lib/session-folder.mjs. It is ABSENT from Bash children, which get CLAUDE_CODE_SESSION_ID instead."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a80d0f9-5a91-4f2d-b3a9-d24d3a4bf271
  modified: 2026-11-18T22:30:00.000Z
---

**In the desktop app it is the PRIMARY** (measured 2026-11-18, app build 3.x): a session that runs in
its own `.claude/worktrees/<name>` folder hands every hook `CLAUDE_PROJECT_DIR` = the primary
checkout, and the hook's own working directory is the primary too. `session-lock.mjs start` printed
the primary's path from inside a worktree session. What that broke, silently, in every desktop session:

- `primary-write-guard.mjs` took the primary as the session's own tree; every worktree sits inside it,
  so every write into another session's worktree was allowed;
- `session-lock.mjs` kept the PRIMARY's lock, and the app copies the primary's gitignored `.claude`
  files (the lock among them) into each new worktree, so every new session was told "another session
  is ACTIVE in this folder";
- `worktree-exit-guard.mjs` saw the primary and stayed silent at every session end (no SessionEnd
  entry in its log after 2026-10-02);
- `sync-worktree-env.mjs --hook` said "this IS the primary — nothing to sync".

**In a CLI session it is the session's own tree** (measured 2026-09-12 with a probe hook injected via
`claude --settings`): a nested `.claude/worktrees/<name>`, a sibling `_wt-*` and the primary each
answered themselves.

**What never moves:** the payload's `transcript_path` sits under `<config>/projects/<slug>/`, the slug
being the folder the session STARTED in with every non-alphanumeric character turned into `-`.
`scripts/lib/session-folder.mjs` matches that slug against the payload's `cwd` and its parents, then
every registered worktree, and falls back to `CLAUDE_PROJECT_DIR` only when nothing matches. The four
hooks above use it, and every lock now names its `folder`; `tests/session-folder.test.ts` drives each
hook in the desktop layout.

**Not in a Bash child** (measured 2026-09-18): a script run from the Bash tool gets no
`CLAUDE_PROJECT_DIR` — only hooks do. It does get `CLAUDE_CODE_SESSION_ID`, the same value hooks
receive as `session_id` and `session-lock.mjs` stores in every lock. Key anything a script must tie
to its session on that id, never on the folder.

**Why:** a hook that keys on the wrong folder fails open and prints nothing, so the measurement that
mattered (September, CLI) read as true everywhere for two months.

**How to apply:** never read `CLAUDE_PROJECT_DIR` or the hook's working directory as the session's
folder; call `sessionFolder(input)`. Re-measure in BOTH the CLI and the desktop app before trusting any
claim about this, the public docs included. See [[permission-allowlist-rules-can-embed-a-live-secret]].
