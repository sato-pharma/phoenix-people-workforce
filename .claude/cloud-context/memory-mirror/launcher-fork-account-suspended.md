---
name: launcher-fork-account-suspended
description: "9 Nov 2026 — the GitHub account it-gawish-hr is SUSPENDED, so the private launcher fork (the only copy of the Phoenix launcher source) is unreachable; the signing key on this laptop is now the only copy."
metadata:
  node_type: memory
  type: project
  originSessionId: dd58f0ee-c080-4c4d-b6a3-efefe32f1614
  modified: 2026-11-09T03:30:53.377Z
---

9 Nov 2026 (~04:50 Cairo) the owner said the GitHub account **`it-gawish-hr` is suspended**. That
account owns the PRIVATE fork `it-gawish-hr/hmdm-android`, which held the only copy of the Phoenix
launcher source (status-bar replacement, periodic location, owner-info label, RustDesk pump, FRP).
`gh` is signed in as `Omar-3-xx` and the fork answers 404 for it. There is NO local source clone.

**Verified the same turn — what survived:**
- The fleet is UNAFFECTED: `https://mdm.satopharma.com/files/hmdm-phoenix-6.48.apk` answers **200**,
  and hosting is on the Headwind box, not GitHub. Tablets keep syncing.
- Local built APKs intact in `F:\Phoenix Workforce\launcher-backup-2026-11-03`: 6.39, 6.40 and
  **6.48 (6,290,217 bytes)**.
- 🔴 **The built APKs are ALSO backed up on GitHub** as release assets of the LIVE account's repo
  `Omar-3-xx/hmdm-android` (private, NOT a fork, source size 0 — holds only releases): tags
  `launcher-6.48-r1` (`hmdm-phoenix-6.48.apk`), `launcher-6.40-r1`, `launcher-6.39-r1`. `gh` is signed in
  as **`Omar-3-xx`** (live, scopes `repo`+`workflow` — can host a fork and run CI).
- 🔴 **THE SOURCE IS UNRECOVERABLE FROM GITHUB** (checked 9 Nov): the suspended fork 404s, `Omar-3-xx/hmdm-android`
  is 0 KB of source, and `h-mdm/hmdm-android` (master, the base) has no Phoenix change. The ONLY carrier of the
  Phoenix changes left anywhere is the **compiled 6.48 APK** — a rebuild is either reconstruction from the
  memory notes or an apktool patch of that binary, re-signed with the single-copy key. See
  [[launcher-status-bar-is-not-gated-on-blockstatusbar]]. No Android build toolchain on this laptop
  (no apktool/java/apksigner) — build+sign must run in CI.
- The signing key is intact at `~/.claude/backups/headwind-launcher-signing/` (p12 + CREDENTIALS.txt).
- The public base `h-mdm/hmdm-android` still exists (public, `master`), so a rebuild has a base.

🔴 **THE SIGNING KEY IS NOW A SINGLE COPY.** It previously existed twice — laptop plus the fork's
Actions secrets — and the fork half is gone with the account. If this laptop's copy is lost, no update
can ever install in place and EVERY tablet needs a factory reset and re-enrol. The owner must copy it
off-machine. Claude must NOT duplicate it: the copy attempt was refused as credential handling, which
is correct — it is his hands.

**Rebuild path if the account is not recovered:** fork `h-mdm/hmdm-android` fresh under a live account,
re-apply the Phoenix changes (each is described in [[headwind-rep-tablet-custom-launcher-build-required]],
[[launcher-6-48-combined-shipped-to-the-fleet]] and [[tablet-location-goes-periodic-after-6-45-reports]]),
rebuild in CI with the SAME key, host at `/files/`, repoint version row 10045. Blocks
[[tablet-lock-screen-says-not-private]].
