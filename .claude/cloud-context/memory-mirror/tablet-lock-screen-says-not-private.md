---
name: tablet-lock-screen-says-not-private
description: "Owner decision 9 Nov 2026 — every rep tablet's lock-screen line becomes \"This device is not private. It belongs to Sato Pharma.\"; one string in the launcher fork's Utils.applyOwnerInfo."
metadata:
  node_type: memory
  type: project
  originSessionId: dd58f0ee-c080-4c4d-b6a3-efefe32f1614
  modified: 2026-11-09T02:46:04.177Z
---

9 Nov 2026 (~04:45 Cairo) the owner asked that the tablet's managed notices be REWORDED rather than
hidden: "CHANGE THEM TO THIS DEVICE IS NOT PRIVATE AND IT THE COMPANY DEVICE". Offered three wordings,
he chose **"This device is not private. It belongs to Sato Pharma."**

**Where it lives:** launcher 6.48's `Utils.applyOwnerInfo` already calls `setOrganizationName("Sato
Pharma")` + `setDeviceOwnerLockScreenInfo("This device belongs to Sato Pharma")` on EVERY sync
([[launcher-6-48-combined-shipped-to-the-fleet]]). So this is ONE STRING, then the established
pipeline: fork CI build + sign → host at `/files/` via the entrypoint → repoint version row 10045.
Because the launcher rewrites it each sync, an `adb settings put secure lock_screen_owner_info` poke is
the WRONG channel and is overwritten — tried 9 Nov, reverted the same turn.

🔴 **BLOCKED 9 Nov 2026:** the fork `it-gawish-hr/hmdm-android` is PRIVATE and `gh` is signed in as
`Omar-3-xx`; the `it-gawish-hr` account shows "Failed to log in … (keyring)". The rebuild cannot start
until that account is re-authenticated (`gh auth login` as it-gawish-hr).

**What CANNOT be reworded:** Android's own "Privacy reminder" and "Location can be accessed" strings
live in the OS (permissioncontroller), not in any MDM setting. They are already off the rep's home
screen via the status-bar replacement; they surface only on the lock screen. Never defeat the OS
privacy indicator itself — [[rustdesk-does-not-start-at-boot]] sits beside this as owner fleet policy.
