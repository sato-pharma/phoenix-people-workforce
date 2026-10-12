---
name: phx-live-is-installed-and-the-mirror-group-bug-it-exposed
description: "phx-live is INSTALLED on the Hetzner box since 2026-10-12 (owner: \"install phx-live on the Hetzner box\") and runs PRODUCTION keys — he ran `phx-live -InstallEnv` himself at 18:04 Cairo that day, ref `ozucdzovmcqvepbozvqf`. Users phxlive/phxtunnel, port 3100 firewalled to those two uids only, `/home/phx/live-ctl.sh`, box scripts kept at `~/.claude/scripts/phx-live-box/`. 🔴 Installing it exposed a live phx-preview defect: mirror objects in `objects/<xx>` dirs without the setgid bit get group `phx`, so a clone dies with \"unable to open loose object … Permission denied\" — 15 objects that day, which would have broken a phx-preview of a fresh commit too; the guard now sits in `refresh_preview_mirror`, so every caller gets it."
metadata:
  node_type: memory
  type: project
  originSessionId: e92e7929-b494-4f05-a30f-3ad6d87b11ca
  modified: 2026-10-12T15:29:41.570Z
---

**What is on the box now** (install script, idempotent: `~/.claude/scripts/phx-live-box/install.sh`):
users `phxlive` (runs the server and the forced-command receiver, in group `phxpreview` to read the
mirror) and `phxtunnel` (nologin, `permitopen="127.0.0.1:3100"` only); `/opt/phx-live/` holding
`live-receiver.mjs`, `live-prepare.sh` and `firewall.sh`; `/home/phx/live-ctl.sh`;
`phx-live-firewall.service`; and a `3100) plog=/home/phx/live.log` case in
`/home/phx/preview-idle-reaper.sh`. Everything proven live the same evening — the measurements are in
`docs/agents-worktree-and-machine-limits.md`, "Installed and proven on the box, 2026-10-12".

**It runs PRODUCTION keys.** `install-env-staging` was used only for the install test; the owner ran
`phx-live -InstallEnv` himself at **18:04 Cairo on 2026-10-12**, and the box env now names
`ozucdzovmcqvepbozvqf`. A session never sends those keys — that was his own decision in the plan.
`-InstallEnv` also stops the box server, because `next` reads its env once at start and a running
server would keep showing staging rows from a box already pointed at production.

**Three traps that cost a cycle each during the install, all fixed in the scripts:**
- `preview-scope.sh`'s `stop_preview_port` assigns `$(pgrep …)`, and pgrep exits 1 when nothing
  matches. Any caller with `set -e` dies there, before the server starts. `live-ctl.sh` routes every
  stop through its own `stop_live`, which drops errexit around the call.
- `sudo -u phxlive` keeps the CALLER's working directory. Called from anywhere under `/home/phx`,
  every git command exits 128 with "failed to stat" — `live-prepare.sh` now `cd`s first.
- The mirror is owned by `phx`, so git calls it dubious ownership and refuses until
  `safe.directory` is recorded for `phxlive`.

🔴 **THE MIRROR GROUP DEFECT, WHICH IS phx-preview's PROBLEM TOO.** `/srv/phx-preview-mirror.git` is
readable through group `phxpreview`. Git creates `objects/<xx>` directories without the setgid bit,
so objects written into a fresh one get the creator's primary group — `phx` — and nobody else can
read them. On 2026-10-12, 15 of that day's objects were in that state, so a clone failed with
`unable to open loose object … Permission denied`, and **a phx-preview of a fresh commit would have
failed the same way**.

**How to apply:**
- A clone or fetch from the mirror failing with "unable to open loose object" is this, never a
  corrupt repository: `sudo find /srv/phx-preview-mirror.git ! -group phxpreview -exec chgrp
  phxpreview {} +` and `sudo find … -type d ! -perm -2000 -exec chmod g+s {} +`.
- 🔴 **The guard lives in `preview-scope.sh`'s `refresh_preview_mirror`, immediately after the fetch
  that creates the bad directories** (owner, 2026-10-12: "add the mirror-group guard to
  preview-scope.sh"). Every caller is covered — `preview-start.sh` (3000), `preview-b.sh` (3001) and
  `live-ctl.sh prepare`. **Do not re-add a copy to `live-ctl.sh`**; the duplicate that lived there
  was removed in the same change. Both `find`s end in `|| true` on purpose: every caller runs under
  `set -e`, and a preview that cannot be re-grouped must still start. Backups of the pre-change
  files: `/home/phx/*.pre-mirror-group-guard-20261012`.
- Never make the mirror group-WRITABLE to solve this: a planted `reference-transaction` hook would
  run as `phx` on the next fetch, which is the whole reason the mirror exists.

Related: [[the-hetzner-previews-run-on-staging-not-production]].
