---
name: rustdesk-does-not-start-at-boot
description: "Owner order 9 Nov 2026 — RustDesk must NOT start by itself when a tablet restarts; Run at boot is OFF on the Headwind app (id 79), never switch it back on."
metadata:
  node_type: memory
  type: project
  originSessionId: dd58f0ee-c080-4c4d-b6a3-efefe32f1614
  modified: 2026-11-09T02:29:00.022Z
---

On 9 Nov 2026 (~04:25 Cairo) the owner said: "I DONOT WANT RUSTDESK TO START EVERYTIME TABLET IS RESTTARTED".
Done 04:28 Cairo: Headwind application 79 (RustDesk 1.4.9, `com.carriez.flutter_hbb`) `runAtBoot` set to
false through `PUT /rest/private/applications/android` (same object round-tripped; one version 10077 kept,
install link unchanged). The flag lives on the APP, so Rep tablets (3), Anti Infective (4) and Pedia (5)
all read false. `runAfterInstall` stays true (it opens once after install). Audit row actor B-10.

**Why:** his decision; the consequence is that remote screen is available after a restart only once
someone opens RustDesk on the tablet.

**How to apply:** never re-enable Run at boot or add a launcher/boot hook that starts RustDesk.
Runbook `docs/devices/headwind-rustdesk.md` line ~1061 ("Run at boot both set") is stale — fix it in the
next devices PR. Related: [[the-mobile-app-is-frozen-until-he-lifts-it]] does not apply (this is the
Headwind fleet, not the mobile app).
