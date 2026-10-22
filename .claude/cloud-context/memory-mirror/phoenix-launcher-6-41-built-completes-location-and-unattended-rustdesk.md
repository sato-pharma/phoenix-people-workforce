---
name: phoenix-launcher-6-41-built-completes-location-and-unattended-rustdesk
description: "The 6.41 Phoenix Headwind launcher is built + SIGNED on the fork — it completes the location upload 6.40 left stubbed, forces location on, keeps RustDesk alive unattended, and reports status to the device log; only the deploy (Railway-gated) and a one-time on-device capture/accessibility grant remain."
metadata:
  node_type: memory
  type: project
  originSessionId: d36b05eb-2113-46dd-a685-dfc52e3baf52
  modified: 2026-10-22T05:17:40.995Z
---

**6.41 (versionCode 15410)** of the custom Headwind launcher, fork `Gawish-1997/hmdm-android`,
branch `phoenix/rustdesk-unattended-reporting` (commit `b703722`, off the 6.40 base `aa9e5e2`
`phoenix/location-relock-frp`). Built + signed green by the fork's own `phoenix-build.yml` on
22 Oct 2026 ~06:39 Cairo: `apksigner verify` → "Verifies", signed APK 6,286,121 bytes, artifact
`phoenix-launcher-signed-apk` (id 12402186991). CI = plain `assembleOpensourceRelease` → zipalign →
sign with the Phoenix key (repo secrets) → upload; no lint/test gate, `minifyEnabled false`.

**What 6.41 adds on top of 6.40 — the key fact is that 6.40 only got halfway:**
- **Location end-to-end.** 6.40 made `LocationService` run under the stock Lenovo home, but
  `ProUtils.processLocation` was still the opensource STUB, so every fix was discarded and the server
  held 0 rows (this is the real cause of "Where is it" showing nothing — not `DONOTTRACK` alone).
  6.41: `processLocation` → new `SendLocationsTask` stores each fix in the existing `locations` table
  and PUTs pending rows to the devicelocations plugin via the already-declared
  `ServerService.sendLocations`, deleting only on a 2xx.
- **Force location ON** — `Utils.forceLocationOn` (`setLocationEnabled`, API 30+) + the launcher's own
  fine/coarse/background grants. Pairs with the `no_config_location` restriction (rep can't toggle).
- **Unattended RustDesk** — `Utils.grantRemoteAccessPermissions` grants RustDesk
  (`com.carriez.flutter_hbb`, overridable via app-setting `remote_access_package`) the device-owner-
  grantable runtime perms; `Utils.startRemoteAccessApp` relaunches it on the BOOT path only (fixes
  "RustDesk stops when restarted"; boot-only so no daytime flash).
- **Reporting** — `Utils.reportPhoenixStatus` writes a per-sync device-log line
  `phoenix-status: location=on/off remoteApp=installed/absent foreground=<pkg|unknown(no usage access)>`.
- **Wiring** — `applyPhoenixDeviceState` runs from `ConfigUpdater.lockRestrictions` (boot/enrol/every
  sync, all silent); `startRemoteAccessApp` from `Initializer` (boot path). All device-owner calls
  SDK-guarded + try/catch; nothing new shows the rep a management sign (golden rule).

**SHIPPED via Fly, 22 Oct 2026 ~07:5x Cairo** (owner: "ship 6.41 fleet-wide via Fly now"). The audit
session hosted the signed APK at **`https://phoenix-tablet-apps.fly.dev/hmdm-phoenix-6.41.apk`** (baked
into the nginx image, no volume; sha256 + 6,286,121 bytes verified against the CI artifact) and pointed
the launcher at it by editing the **single version row in place** — `PUT /rest/private/applications/versions`
id **10045** → version 6.41, code 15410, Fly url — NOT a config-3 PUT, so the six apps' links were not
touched (the carry-the-app-links trap avoided). Independently verified read-only: app-46 version 10045 =
6.41/15410/Fly url, config 3 = 11 active links (launcher action=1), Fly URL 200 + correct APK. Fleet-wide
by construction (config 3 is the shared rep ruleset). **Signature-compatible, no re-enroll:** 0008 ran
6.39 (code 15390) from `hmdm-phoenix-6.39.apk`, cert sha256 `7b48e751…1c49` = the same Phoenix key
(alias PHOENIX) as 6.41, so it updates in place.

**What still remains (automatic / one-time):**
- 🔴 **CORRECTED 22 Oct ~08:10 Cairo: 6.41 has no restart-after-self-update receiver, so the pickup KILLED 0008’s agent until a reboot — superseded by 6.42, see [[a-launcher-self-update-leaves-the-agent-dead-until-a-reboot]].** Original text: **Tablet pickup is automatic on the next sync** — 0008 was still on the old launcher with 0 location
  rows at 07:54 Cairo; it installs 6.41 and starts reporting location on its next check-in. 0007
  (Ganna's) and 0002 update when they next come online.
- **0008 RUNS 6.41 SINCE 08:15 CAIRO, 22 Oct (read from its device log):** silent install 07:59:28,
  nothing until `Got the BOOT_RECEIVER broadcast` 08:15:06 (a restart), then `MDM Launcher
  6.41-opensource started`, `Remote access app started: com.carriez.flutter_hbb`, and
  `phoenix-status: location=on remoteApp=installed foreground=unknown(no usage access)`. Location rows
  NOT yet proven: `devicelocations/private/history` answered **404** with 0 rows at 08:17.
- **One-time on-device grant** — RustDesk screen-capture (MediaProjection) + accessibility are NOT
  grantable through the device-owner API on stock Android; a person taps them once at provisioning,
  then it reconnects unattended forever.
- **On-device proof** — the APK is signed + served, but UNTESTED on a tablet until 0008 runs it; the
  real proof is location rows appearing (readable via the devicelocations plugin).

Related: [[headwind-rep-tablet-custom-launcher-build-required]] (the task this delivers),
[[rep-tablet-never-shows-tracking-golden-rule]], [[config-3-restrictions-no-uninstall-no-location-toggle]],
[[a-railway-build-outage-leaves-no-deployment-row]].
