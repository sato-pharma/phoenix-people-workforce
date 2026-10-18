---
name: phx-live-runs-main-only-and-follows-every-merge
description: "Owner, 2026-10-17 ~19:31 Cairo: \"I want the PHX live to always run on main. Any update I will do, I will push to main and test on main, never on any branch.\" phx-live now serves GitHub's main ONLY and follows every merge by itself (phx-live-follow.mjs polls main every 60 s; box `live-ctl.sh follow <sha>` moves the tree under the running server, the build mode rebuilds while the old build serves). -Folder is REFUSED; plain phx-live = production build again, -Dev/-DevAuth = next dev. Never ask him to look at a branch; a branch look is the session's own laptop dev server."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 164a490b-b177-4b7c-a3bc-cd2c15da8076
  modified: 2026-10-17T16:43:11.803Z
---

**His words (2026-10-17, ~19:31 Cairo):** "I want the PHX live to always run on main. Any update I
will do, I will push to main and test on main, never on any branch."

**What changed the same evening** (all outside the repo, each with a backup):
- `~/.claude/scripts/phx-live.ps1` — plain `phx-live` serves main's sha from GitHub (`gh api`), never
  a folder; `-Folder` prints "phx-live runs MAIN only" and exits 1; the production build (`fast`) is
  the default again, `-Dev` / `-DevAuth` give `next dev`, `-Build` is accepted and ignored. It starts
  `phx-live-follow.mjs` in the minimised window instead of the folder mirror `phx-live-sync.mjs` (kept,
  no longer started). `-InstallEnv` still reads the primary folder's `.env.local`. Backup
  `phx-live.ps1.pre-main-only-20261017`.
- `~/.claude/scripts/phx-live-follow.mjs` (new) — every 60 s compares main on GitHub with the commit
  the BOX is on (not its own memory, so anything that moves the box off main is put right) and runs
  `live-ctl.sh follow <sha>`; a dependency change answers NEEDS_INSTALL and it runs prepare + serve
  (about a minute down). Restarts a crashed scope, leaves an idle-reaped one stopped, prints
  "SERVING main <sha> — reload the page".
- Box `/home/phx/live-ctl.sh` — new `follow <sha>`: refreshes the mirror, then as phxlive checks out
  <sha> under the running server (no stop) unless package.json / pnpm-lock.yaml / pnpm-workspace.yaml /
  .npmrc / patches changed (exit 6). Box + laptop copy byte-identical, sha256 `5dc393fe…`; box backup
  `live-ctl.sh.pre-main-only-20261017`.
- His PowerShell profile — the phx-live comment and the retired phx-preview's help line say main only
  (backup `Microsoft.PowerShell_profile.ps1.pre-phx-live-main-only-20261017`). Still ASCII-only.

**Why the production build is the default again:** `next dev`'s only advantage was a SAVE showing in
seconds, which a main-only server never has; its costs stay (a first compile per page, the 6.8 GB
cap — [[phx-live-compile-weight-is-dead-start-up-code-and-two-bridges]]).

🔴 **What "test on main" means here:** a merge to main also deploys to production once main's CI is
green (about 10-15 minutes), so phx-live shows a merge only minutes before the real site does — it is
not a pre-production gate. He was told so once; do not re-argue it.

**How to apply:**
- Never ask him to look at a branch, a worktree or a preview. A session that needs a browser look at
  its own branch uses its own laptop `node scripts/dev-server.mjs` (RAM permitting); his look is on
  main, after the merge.
- Never pass `-Folder` or propose a branch on phx-live; never re-add the folder mirror.
- 🔴 **Repo docs still lag:** `docs/agents-worktree-and-machine-limits.md` lines ~1298 and ~1339 describe
  `phx-live -Folder <worktree>`. A docs-only PR is "small" and he will not merge one — fold the fix into
  the next WIDE PR that touches anything, and AGENTS.md §5's phx-live clause with it.

Supersedes the `-Folder` lines of [[phx-preview-is-retired-phx-live-is-the-one-dev-server]].
