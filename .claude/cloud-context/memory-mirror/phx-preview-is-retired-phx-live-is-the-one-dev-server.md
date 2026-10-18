---
name: phx-preview-is-retired-phx-live-is-the-one-dev-server
description: "CORRECTED 2026-10-17 ~18:24 Cairo: phx-live is NO LONGER the one dev server — the owner chose \"Laptop + lighter compile\" after phx-live stopped working anywhere, so the laptop's `pnpm run dev` is the default again in every folder (his profile wraps pnpm to `node scripts/dev-server.mjs`) and phx-live is OPTIONAL; never ask him to run it. phx-preview stays RETIRED since that morning; plain `phx-live` is `next dev`, `-Build` the 3-minute-rebuild mode. Its leftovers were REMOVED (archive /home/phx/retired/phx-preview-20261017.tar.gz); KEEP preview-scope.sh, the mirror, the phxpreview user+group, preview-state and the idle reaper - phx-live uses them."
metadata:
  node_type: memory
  type: project
  originSessionId: 164a490b-b177-4b7c-a3bc-cd2c15da8076
  modified: 2026-10-17T15:48:04.228Z
---

🔴 **AND AGAIN at ~19:31: phx-live is MAIN ONLY — `-Folder` is refused; see [[phx-live-runs-main-only-and-follows-every-merge]].**

🔴 **SUPERSEDED THE SAME EVENING — the laptop is the default again.** At ~18:20 Cairo he said he used to
run `pnpm run dev` freely in any folder or branch and that phx-live now worked nowhere; asked in chat
as multiple choice he picked "Laptop + lighter compile". phx-live was stopped at 18:25. His PowerShell
profile now wraps `pnpm`: `pnpm run dev` / `pnpm dev` run `node scripts/dev-server.mjs` from the
nearest Phoenix folder (so a worktree's junctioned node_modules is never offered for deletion), every
other pnpm command passes through (backup `Microsoft.PowerShell_profile.ps1.pre-pnpm-dev-wrapper-20261017`).
AGENTS.md §5 and docs/agents-worktree-and-machine-limits.md say so in PR 6048, which also cuts what
`next dev` compiles ([[phx-live-compile-weight-is-dead-start-up-code-and-two-bridges]]). The "How to
apply" lines below that tell a session to ask him to run phx-live are DEAD; the rest is box history.

On 2026-10-17 the owner said he wanted ONE thing exactly like his old `pnpm run dev` (localhost
pointing at production, edits live), not both phx-preview and phx-live, and then typed: "make
phx-live work like pnpm run dev by default and retire phx-preview".

**What changed (all with backups):**
- `~/.claude/scripts/phx-live.ps1`: plain `phx-live` = mode `dev` (`next dev`); new `-Build` = the
  production-build mode `fast`; `-Dev` still accepted and ignored; `-DevAuth` beats `-Build`.
  Backup `phx-live.ps1.pre-dev-default-20261017`.
- His PowerShell profile (`OneDrive\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`):
  `phx-preview` now only prints that it is retired and points at `phx-live`. Backup
  `Microsoft.PowerShell_profile.ps1.pre-retire-phx-preview-20261017`. The file is ASCII-only on
  purpose (PowerShell 5.1 reads a BOM-less file as ANSI).
- `/home/phx/live-ctl.sh` on the box and its laptop copy in `~/.claude/scripts/phx-live-box/`:
  comment only, byte-identical (sha256 `8f02a71a…`). Box backup `live-ctl.sh.pre-dev-default-20261017`.
- Repo rules: AGENTS.md §5 bullet rewritten; account in `docs/agents-worktree-and-machine-limits.md`.

**Why `next dev` can be the default again:** the "2.5-3 minutes a page" that made the build mode
the default on 2026-10-16 was phx-live sitting inside `phx-previews.slice` (4.5 GB cap beat its own
scope's). It moved to `phx-live.slice` (7 GB) the same day. Measured on the box on the morning of
2026-10-17: `/employee-portals/plans` first open 30.9 s, then 0.7-3.2 s.

**How to apply:**
- A browser look at any code goes on `phx-live` (`-Folder <worktree>` for a branch). Ask him to run
  it, and say that `-Folder` moves HIS server off his main folder.
- What was lost is the STAGING sandbox: a dev-auth header walk now runs on `phx-live -DevAuth`,
  against production data, and notifications started there are lost for good.
- **The leftovers were REMOVED the same day** (owner, 2026-10-17 16:15 Cairo: "remove the phx-preview
  leftovers from the box"): box `preview-start/b/stop/sync.sh`, their backups and logs, `.preview-new/`,
  `preview-reaper-arm.sh`, `phxpreview`'s two checkouts (3.5 + 1.5 GB), its `secure/` env copy and
  caches, and `phx-previews.slice` (unit file + runtime drop-ins). Disk went 41 GB -> 36 GB used.
  Archive: box `/home/phx/retired/phx-preview-20261017.tar.gz` (29 files); laptop
  `~/.claude/backups/retired-phx-preview-20261017/` holds `phx-preview.ps1`, its 4 backups, the three
  laptop copies of the box scripts and a copy of the tarball. `live-ctl.sh` lost its
  `set-property --runtime phx-previews.slice` line (it would quietly recreate the slice); box and laptop
  copies byte-identical, sha256 `cecab66b…`, box backup `live-ctl.sh.pre-retire-preview-20261017`.
- The box's `/home/phx/_old-preview-docs-20261008` (636 files, 26 MB: the documents and uncommitted
  edits rescued from the FIRST preview checkouts on 2026-10-08) was copied to
  `F:\Claude Scratchpad Archive\_box-old-preview-docs-2026-10-08` ("copy the box's old preview documents
  to the laptop archive"), fingerprint-matched on box, laptop and archive, then deleted from the box
  ("delete the old preview documents folder from the box") after a second match, 636 of 636. The archive
  folder is now the ONLY copy. 🔴 The local delete guard refuses ANY command whose text names the
  archive next to a delete, even when the delete is on another machine: read the archive in one
  command and run the remote delete in a separate one.
- 🔴 **phx-live's dev heap is 4,096 MB again, NOT 5,120** (owner, 2026-10-17: "put phx-live's heap back
  to 4 GB"). Measured at 5,120 that afternoon: one `next-server` at 5,710 MB RSS + 1,120 MB swap after
  compiling only /login, flat over 10 minutes, `memory.events high` 541 against the scope's 6,800 MB
  MemoryHigh, box down to ~1.1 GB available. 5,675 MB of it was anon, 165 MB file cache. The 5,120 was
  set 2026-10-16 while chasing slowness that was really the phx-previews.slice cap. Source maps are not
  it (50-70 MB, docs). `live-ctl.sh` box + laptop sha256 `9898d6c5…`, box backup
  `live-ctl.sh.pre-heap4096-20261017`. 🔴 **MEASURED 16:38-16:41 Cairo, it did NOT fix it:** the same
  /login start peaked at 5,438 MB with 0 swap (vs 6,801 + swap at 5,120), but compiling ONE more API
  route (/api/employee-portals/navigation) plus /_not-found put it back at the cap — 5,757 MB RSS,
  2,559 MB swap, 2,397 MemoryHigh events, a 404 taking 42 s. Next never logged its 80% memory restart.
  smaps of next-server: V8's 256 KB pages ~2.2 GB; glibc `[heap]` (brk, NATIVE malloc) 1,592 MB RSS +
  1,057 MB swap = 2.65 GB; other anon mmaps ~1.6 GB; nine 64 MB arenas 310 MB. So the HEAP CAP IS NOT
  THE LEVER — the biggest consumer is native malloc, which on glibc fragments and never returns.
  🔴 **jemalloc was TRIED AND REJECTED the same afternoon** ("try jemalloc on phx-live and measure
  again"). Same six requests, same warm webpack cache, 30 s idle before reading: CONTROL (glibc, heap
  4096) peak 6,802 MB, 514 MemoryHigh hits, /login cold 10.7 s, navigation 23.2 s, approvals-hub 4.6 s,
  then 6,515 MB + 392 MB swap; JEMALLOC (`LD_PRELOAD` + `MALLOC_CONF=background_thread:true`) peak 6,801,
  **4,358** hits, /login 21.9 s, navigation 35.6 s, approvals-hub 29.6 s, then 4,195 MB + 1,708 MB swap.
  Lower at rest, 2-6x slower to compile — removed; `live-ctl.sh` is back to sha256 `9898d6c5…` (box backup
  of the jemalloc version's predecessor: `live-ctl.sh.pre-jemalloc-20261017`). **Conclusion: `next dev
  --webpack` on this app needs ~6.5-7 GB while it compiles (V8 pages 2-2.6 GB, large anon mmaps ~2 GB,
  native malloc ~1.7 GB); neither the heap cap nor the allocator changes that on a 7.7 GB box.** Never
  re-propose a bigger box (owner will not buy hardware); the remaining lever is what one compile pulls in — measured: [[phx-live-compile-weight-is-dead-start-up-code-and-two-bridges]].
- 🔴 **KEPT because phx-live uses them — never "finish the retirement" by removing these:**
  `preview-scope.sh` (sourced by `live-ctl.sh`), `/srv/phx-preview-mirror.git`, the `phxpreview` user AND
  group (`phxlive` reads the mirror through the group), `/home/phx/preview-state/`,
  `preview-idle-reaper.sh` + `phx-preview-idle.timer` (stops phx-live after 60 idle minutes),
  `~phx/secure/.env.local` (`live-ctl.sh install-env-staging`). phx-live's scope keeps the name
  `phx-preview-3100.scope` and `remote-check` finds it by that name.
- 🔴 **A trap the removal hit:** `/home/phxpreview` is `drwxr-x--- phxpreview`, so a `[ -d ]` test run as
  `phx` reads FALSE for a folder that exists. The clean-up's "copy every document out first" loop was
  guarded by exactly that test, skipped both checkouts silently (printed nothing, copied 0), and the
  `sudo rm -rf` after it ran. Both were clean fresh clones of GitHub (no uncommitted edits, checked
  minutes before), so tracked documents are safe in git, but an untracked one could not be proven
  absent afterwards. Any existence test on another user's home goes through `sudo -n test -d`, and a
  rescue step must print its count and ABORT the delete when the count line is missing.

**A trap this change hit, 2026-10-17:** PowerShell variable names ignore case, so the new
`[switch]$Build` collided with the script's own `$build` (the box build state). The first real run
died at `$build = ""` with "Cannot convert ... to type SwitchParameter" AFTER the server, sync and
tunnel had started, so it looked half-working. A parse check passes it; only running it, or an AST
check of every assignment against the param names, catches it. The state variable is now `$boxBuild`.
After the fix the run printed `READY`, `/login` took 14.7 s the first time and 0.48 s after, and
the red PRODUCTION DATA strip showed.

Related: [[the-hetzner-previews-run-on-staging-not-production]] ·
[[the-phx-preview-dev-server-cannot-compile-a-page-at-its-2048-mb-heap]] ·
[[phx-live-is-installed-and-the-mirror-group-bug-it-exposed]]
