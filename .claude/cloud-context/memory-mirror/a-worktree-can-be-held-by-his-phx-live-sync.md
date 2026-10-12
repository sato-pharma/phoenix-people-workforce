---
name: a-worktree-can-be-held-by-his-phx-live-sync
description: "Before retiring a worktree, look for a `phx-live-sync.mjs --folder <that worktree>` process and read the box's `live-ctl.sh status` — phx-live can be serving that exact folder with devauth on, and removing it would yank his live preview. And a missing `.claude/session.lock` inside an `_wt-*` folder NEVER proves the session left: an `_wt-*` session reports the PRIMARY as its cwd, so its lock lives there."
metadata:
  node_type: memory
  type: project
  originSessionId: c6c5b9e1-3dc9-4ddb-bddb-2f58c01d2ce3
  modified: 2026-10-12T21:34:21.157Z
---

🔴 **A worktree you are about to retire can be held by TWO things that no `git status` shows: his
phx-live sync, and a live session whose lock is not in that folder.**

**Measured 13 Oct 2026, 00:19–00:33 Cairo**, retiring `_wt-hr-landing-premium-deck`.

**1. The phx-live holder.** The gate "nothing is running in the worktree" failed on
`node.exe/26448` — not a dev server but
`phx-live-sync.mjs --folder "F:\Phoenix Workforce\_wt-hr-landing-premium-deck" --base <sha> --devauth 1`,
with a sibling `ssh.exe -N -L 3000:127.0.0.1:3100` tunnel, both orphaned (their wrapper shell had
already exited). The box agreed: `live-ctl.sh status` → `scope=active base=<sha> mem=2006MB
peak=3320MB devauth=1`. Removing the folder would have broken his live preview mid-look.
**Check for both the local `--folder` match and the box's `status` before any worktree removal**, and
treat the sync as HIS: it stops on his word. A full stop is three acts — `Stop-Process` the watcher,
`live-ctl.sh stop` on the box (`scope=inactive mem=0MB`), then kill the tunnel ssh; only a local
`000` on port 3000 proves the forward is gone.

**2. The lock is in the primary, not the worktree.** A first watcher called the same worktree "idle"
because `<worktree>\.claude\session.lock` was missing, 20 minutes after the folder appeared. Wrong:
an `_wt-*` session reports the PRIMARY checkout as its cwd, so the primary holds its lock. That
session was alive and went on to commit twice more and open a PR. **A missing lock in an `_wt-*`
folder is unknown, never unattended** — the only honest tests are "is the branch still checked out
anywhere" and "is a process running with that folder in its command line".

**How to apply.** Gate a worktree retirement on: PR by NUMBER merged · every PR file byte-identical
on `origin/main` (blob by blob) · `status --porcelain` empty and `rev-list --count origin/<b>..HEAD`
zero · no protected-type file unique to the folder · no holder process, with his phx-live sync
reported apart rather than killed.

Related: [[i-may-stop-a-dev-server-i-started-myself]],
[[a-worktree-husk-is-pinned-by-the-session-not-its-cwd]],
[[a-reused-branch-name-finds-the-old-merged-pr]].
