---
name: phantom-worktree-not-in-git-worktree-list
description: "A session's stated 'worktree path' under .claude/worktrees/<name> can be an empty directory that git itself has never registered — verify with `git worktree list` before trusting it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5316bc9f-2ce3-4ebf-925f-c10c0967721a
---

The system prompt's "Worktree path" for a session (e.g.
`F:\Phoenix Workforce\phoenix-workforce\.claude\worktrees\<random-name>`) is not
guaranteed to be a real `git worktree add` checkout. Observed 2026-07-07 on
`elastic-dewdney-6236fa`: the directory existed on disk but contained only
`.claude`/`.next` — no `app/`, `src/`, `package.json`, `node_modules` — and
`git worktree list` (run from the primary repo) did not list it at all. All
Read/Edit calls made with the *primary* repo's absolute path
(`F:\Phoenix Workforce\phoenix-workforce\src\...`) during the session had in fact
landed correctly in the real, tracked working tree the whole time; `git status`
in that primary repo showed exactly the intended diff.

**Why:** this is the inverse of [[enterworktree-absolute-path-gotcha]] (which warns
about accidentally using a stale primary-repo path after a *real* worktree was
created). Here there was no real worktree to begin with — likely a worktree
creation step was skipped or failed silently, but the session's system prompt
still asserted one. Trying to `npx next dev` from inside the phantom directory
fails with "Couldn't find any `pages` or `app` directory", which is the
tell-tale symptom.

**How to apply:** if a dev server refuses to start with a missing-app-directory
error, or `ls` on the stated worktree path looks suspiciously empty, run
`git worktree list` from the primary repo immediately. If the session's
worktree path is absent from that list, treat the primary repo path
(`F:\Phoenix Workforce\phoenix-workforce`) as the real working tree for the rest
of the session — run `git status`/dev servers/build commands there instead of
the phantom path. Don't waste time trying to populate or fix the phantom
directory (e.g. copying `.env.local` into it) — clean up anything written there
by mistake and proceed against the primary path, where the actual edits already
are. See also [[worktree-junction-breaks-turbopack]] and
[[parallel-session-swarm-hazard]] for other worktree pitfalls in this repo.
