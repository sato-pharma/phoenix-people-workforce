---
name: the-hetzner-previews-run-on-staging-not-production
description: "Since 2026-10-08 14:30 Cairo the Hetzner box previews (`~/preview` :3000, `~/preview-b` :3001) read STAGING `cifwmndunmlxjhyjugxa` with APP_ENV=staging and PHOENIX_EMAIL_FORCE_TESTING=true (owner-approved) — never put production keys back in `~phx/secure/.env.local`; a preview showing staging data is correct."
metadata:
  node_type: memory
  type: project
  originSessionId: ddbd6fd7-8a24-45e4-b9cc-5c709ace3bd5
  modified: 2026-10-08T11:42:45.748Z
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
  - Each preview is capped at 3 GB RAM + 1 GB swap; both together at 4 GB.
  - `phx-preview-idle.timer` runs `~/preview-idle-reaper.sh` every 5 minutes. It stops a preview after
    60 minutes with no request and no connection (4 hours if a tab sits open with no request).
- Arming the reaper is the owner's word: remove `Environment=PHX_PREVIEW_REAPER_DRY=1` from
  `~/.config/systemd/user/phx-preview-idle.service`, then run `daemon-reload`.
- Backups: `~/preview-*.sh.pre-caps` on the box and `~/.claude/scripts/phx-preview.ps1.pre-caps` on the
  laptop.

**How to apply:**
- Never "fix" a preview back to production data. Production previews are not offered, because the app
  reads through the service-role client and has no safe read-only mode.
- Still open (each needs the owner's approval):
  - rotate the production service-role key, which sat on the box from about 30 Sep to 8 Oct;
  - check whether the old box `PHOENIX_AUTH_SECRET` equalled production's;
  - run remote-check as a non-sudo user;
  - identify the unlabelled SSH key on `phx`.
