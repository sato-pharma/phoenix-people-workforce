---
name: the-hetzner-previews-run-on-staging-not-production
description: "Since 2026-10-08 14:30 Cairo the Hetzner box previews (`~/preview` :3000, `~/preview-b` :3001) read STAGING `cifwmndunmlxjhyjugxa` with APP_ENV=staging and PHOENIX_EMAIL_FORCE_TESTING=true (owner-approved) — never put production keys back in `~phx/secure/.env.local`; a preview showing staging data is correct."
metadata:
  node_type: memory
  type: project
  originSessionId: ddbd6fd7-8a24-45e4-b9cc-5c709ace3bd5
  modified: 2026-10-08T13:44:35.798Z
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

**How to apply:**
- Never "fix" a preview back to production data. Production previews are not offered, because the app
  reads through the service-role client and has no safe read-only mode.
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
