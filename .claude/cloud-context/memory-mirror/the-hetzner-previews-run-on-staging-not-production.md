---
name: the-hetzner-previews-run-on-staging-not-production
description: "phx-preview was RETIRED 2026-10-17 (phx-live is the one dev server) — what follows is its record, and the phx-live half still holds. Since 2026-10-08 14:30 Cairo the Hetzner box previews (`phx-preview`, :3000 and :3001) read STAGING `cifwmndunmlxjhyjugxa` with APP_ENV=staging and PHOENIX_EMAIL_FORCE_TESTING=true (owner-approved) — never put production keys back in `~phx/secure/.env.local`; a preview showing staging data is correct. They RUN AS `phxpreview` (no sudo) from a read-only mirror — never run a preview or its install as phx again. PRODUCTION data on the box is ONLY `phx-live` (port 3100, user `phxlive`, its own allowlisted env, port firewalled to `phxtunnel`+`phxlive`, owner's plan 2026-10-12) — never widen phx-preview to production instead."
metadata:
  node_type: memory
  type: project
  originSessionId: ddbd6fd7-8a24-45e4-b9cc-5c709ace3bd5
  modified: 2026-10-17T12:58:50.094Z
---

On 2026-10-08 the owner approved "move the box previews to staging and restart preview-b" (security
follow-up FUP-002). `~phx/secure/.env.local` — symlinked into `~/preview` and `~/preview-b` by
`preview-start.sh` / `preview-b.sh` — previously held the PRODUCTION service-role key, production URL,
`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` and no APP_ENV or email fail-safe. It now holds:
- the staging Supabase URL, ref, anon, publishable and service-role keys, plus staging's Google Maps keys,
  copied from Railway `staging` without being displayed;
- `APP_ENV=staging`, `PHOENIX_EMAIL_FORCE_TESTING=true` and `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`;
- a fresh random `PHOENIX_AUTH_SECRET` that belongs to no environment.

No copy of the production keys was kept on the box. Proof: the restarted preview-b read **110** active
employees, which matches staging (110), not production (115).

**Why:** branch code runs on that box as `phx`, and `phx` has passwordless sudo. Mode 600 cannot protect
a file from code running as its owner, so any remote-check run could read a production service-role key.

**Caps and idle stop (installed 2026-10-08 14:41 Cairo, owner-approved, DRY-RUN first):**
- The setup:
  - Linger is on for `phx`.
  - `~/preview-scope.sh` starts each preview as `phx-preview-<port>.scope` in `phx-previews.slice`.
  - Each preview is capped at 4 GB RAM (reclaim from 3.5 GB) + 1 GB swap; both together at 5 GB RAM + 2 GB swap (raised from 3 GB / 4 GB on 2026-10-08 ~16:00 Cairo, owner-approved, applied live with no restart; backups `*.pre-4g`).
  - `phx-preview-idle.timer` runs `~/preview-idle-reaper.sh` every 5 minutes. It stops a preview after
    60 minutes with no request and no connection (4 hours if a tab sits open with no request).
- ARMED 2026-10-08 ~16:05 Cairo on the owner's word ("arm the box preview idle reaper"), before the 24 h trial ended; the dry run had logged no real "would stop" line. It now really stops an idle preview, writes `~/preview-state/<port>.stopped`, and logs to `~/preview-idle.log`. Disarm: put `Environment=PHX_PREVIEW_REAPER_DRY=1` back in
  `~/.config/systemd/user/phx-preview-idle.service` (backup `.pre-arm`), then run `daemon-reload`.
- 🔴 **SUPERSEDED ~16:10 Cairo the same day — the owner then chose "back to trial, arm 14:41"** (asked as
  multiple choice). It is back in TRIAL (logs only; the early-armed file kept as
  `.armed-early-20261008`), and box `at` job 1 runs `~/preview-reaper-arm.sh` at 2026-10-09 11:41 UTC
  (14:41 Cairo), which arms it, backs up `.pre-arm-20261009` and logs `ARMED` in `~/preview-idle.log`.
  Do not arm it by hand before then.
- ARMED AGAIN 2026-10-08 16:19 Cairo on the owner's typed "arm the preview idle reaper on the box" —
  given in a session that suggested it without having read the 16:10 trial decision above. Live
  self-test: a dummy `phx-preview-3001` sleep scope was stopped and logged. No real preview was running.
  The `at` job 1 is still queued and only logs "already live" if it stays armed.
- 🔴 **BACK TO TRIAL 2026-10-08 16:20 Cairo** — he answered "put the preview reaper back on trial until
  tomorrow 14:41". The service file was restored from `.pre-arm-20261008` (dry-run line present, which is
  what the `at` job's grep needs), and `at` job 1 (2026-10-09 11:41 UTC) still arms it. Do not arm it by
  hand before then.
- `vm.swappiness` is **10** (was the default 60) since 2026-10-08 16:44 Cairo, owner-approved, live and
  persistent via `/etc/sysctl.d/99-phx-swappiness.conf`; undo by deleting that file and
  `sudo sysctl -w vm.swappiness=60`.
- Backups: `~/preview-*.sh.pre-caps` on the box and `~/.claude/scripts/phx-preview.ps1.pre-caps` on the
  laptop.

**The previews run as `phxpreview`, a user with NO sudo, since 2026-10-08 ~17:50 Cairo** (owner: "run
the box previews as their own user without sudo"):
- `phx` keeps the GitHub deploy key and fetches into `/srv/phx-preview-mirror.git` (owner phx, group
  phxpreview READ-only, `core.sharedRepository=0640` — never make it group-writable: a planted
  reference-transaction hook would run as phx on the next fetch).
- `phxpreview` owns `/home/phxpreview/preview` (3000) and `/home/phxpreview/preview-b` (3001), clones and
  installs from that mirror (`~/preview-sync.sh`, fed on stdin), and reads its own env copy
  `/home/phxpreview/secure/.env.local`, refreshed from `~phx/secure/.env.local` at every start.
- Each preview is now a SYSTEM scope `phx-preview-<port>.scope` in `/etc/systemd/system/phx-previews.slice`
  (same caps), started with `sudo systemd-run --scope --uid=phxpreview`; the reaper (still a phx user
  timer, still in trial until the 9 Oct 14:41 `at` job) lists the system manager and stops through sudo.
- Proven live: the listener runs as phxpreview; from it sudo, `/home/phx` (secret, deploy key, runner
  credentials), `/home/phxci` and the mirror are all refused; DIRTY_TREE refusal, the laptop's start
  and -Stop paths and a live reaper stop all worked.
- The OLD checkouts `/home/phx/preview` (+ `-b`, 15 GB) were REMOVED 2026-10-08 ~18:05 Cairo on the
  owner's word. Their 634 document-type files (all git copies or package/build output) were moved aside
  first, with the old main checkout's 20 uncommitted rep-ranks edits (an earlier draft of #5351: 12 files
  identical to it, 8 smaller) as `preview-uncommitted.patch` + `preview-untracked.tar.gz` — all in
  `/home/phx/_old-preview-docs-20261008` (26 MB). Script rollback: `~/preview-*.sh.pre-phxpreview-20261008`
  (those expect the old checkouts, so a rollback would re-clone into `/home/phx/preview`).

**phx-live — the ONE production-data server on the box (owner's plan, approved 2026-10-12):** the owner
wanted his old `pnpm run dev` back — edit in a folder, see it live before the merge, `/admin/dev-preview`
on real data — without the laptop carrying it. It is a separate thing from phx-preview: user `phxlive`
(no sudo), `/home/phxlive/live`, `phx-preview-3100.scope` capped 5.5 GB, an ALLOWLISTED env with no
email/Telegram/OneSignal/DB-URL keys and a box-only `PHOENIX_AUTH_SECRET`, port 3100 firewalled to uids
`phxtunnel` + `phxlive` (because `/api/dev-auth` gives Super Admin to any loopback request), and
`remote-check` counts it as BUSY. All 15 drawbacks and their handling:
`docs/agents-worktree-and-machine-limits.md`, "phx-live".

**How to apply:**
- Never run a preview, its `pnpm install` or any branch code as `phx` again.
- Never "fix" a phx-preview back to production data — production data on the box is phx-live only,
  never phx-preview, because branch code from any session runs there as `phxpreview`.
- Still open (each needs the owner's approval):
  - DONE 2026-10-08 15:55 Cairo: production moved to a new secret key `phoenix_server_2026_10` and the
    publishable key (Railway, GitHub secrets + variable, six laptop .env.local files), and the legacy
    JWT keys (anon + service_role) were DISABLED — the old key answers 401. Re-enabling is one switch
    in the Supabase dashboard (API keys → legacy). Staging also runs the new key types; its legacy keys
    stay ON because the box previews use them;
  - CHECKED 2026-10-08 16:00 Cairo, old box `PHOENIX_AUTH_SECRET` vs production: NOT provable directly —
    the old file was overwritten at 14:40 with no fingerprint taken. Circumstantial answer NO: all 30
    laptop env copies back to 10 Aug carry ONE auth secret, and its fingerprint differs from production's
    (and staging's); the box file was a 13-key subset of the laptop's, with the same service key. So
    production's session secret was most likely never on the box — rotating it (signs every user out,
    voids reset codes and app tickets) is not recommended on this evidence;
  - DONE 2026-10-08 15:55 Cairo (owner-approved): `phx` is in `systemd-journal`, so it reads every log
    (kernel OOM kills included) without sudo; undo with `sudo gpasswd -d phx systemd-journal`;
  - DONE 2026-10-08 ~16:40 Cairo (owner-approved): remote-check runs as `phxci` (no sudo, cannot
    read /home/phx); the box lock is shared with `phx` through `/var/lib/phx-locks` + root-owned
    `/tmp` links (`/etc/tmpfiles.d/phx-locks.conf`). The code default changes in PR #5513; until it
    merges, older sessions still run as `phx`;
  - IDENTIFIED 2026-10-08 16:05 Cairo — the "unlabelled" SSH key is NOT unknown: it is the laptop's own
    `~/.ssh/id_ed25519` (fingerprint `SHA256:YTblKT…`), the SAME key as the `omar` line, written twice
    (once without a comment) into both `phx` and `root` authorized_keys when the server was created on
    30 Sep 00:40 UTC. It has never been used to log in since boot; every login (phx AND root) uses
    `railway_phoenix_ed25519` (`phx-automation`, `SHA256:qPdc0j…`) from Egyptian ISP addresses.
    The comment-less duplicate line was REMOVED 2026-10-08 ~16:15 Cairo (owner-approved) from both files;
    backups `authorized_keys.pre-dedup-20261008`. The personal key is passphrase-protected, so a
    `BatchMode=yes` ssh with it fails client-side — that is not a server refusal ("Server accepts key").
