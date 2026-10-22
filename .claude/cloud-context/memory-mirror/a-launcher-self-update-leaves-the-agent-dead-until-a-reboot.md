---
name: a-launcher-self-update-leaves-the-agent-dead-until-a-reboot
description: "Under the stock Lenovo home the Headwind launcher is not HOME, so a self-update (6.39→6.41, 22 Oct 07:59 Cairo) killed PHX-TAB-0008's agent — no long-poll, no sync — until a reboot; 6.42 (fork branch phoenix/restart-after-self-update) adds a MY_PACKAGE_REPLACED receiver. Never ship a launcher without it."
metadata:
  node_type: memory
  type: project
  originSessionId: c29197d2-a532-44ff-a422-13b4f76de2d7
  modified: 2026-10-22T05:15:32.979Z
---

**What happened (22 Oct 2026, Cairo):** version row 10045 moved to 6.41 on Fly; PHX-TAB-0008 got
`configUpdated` 07:59:25, logged "Downloading app: com.hmdm.launcher" and "Silently installing app
com.hmdm.launcher 6.41" at 07:59:28, one last "Push long polling inquiry" at 07:59:30 — then silence
(it had polled every ~66 s). Last sync 07:54; installed launcher still read 6.39 because the new
process never ran to report.

**Why:** upstream relies on Android relaunching the HOME app after its package is replaced (and on the
EMUI restarter helper, `com.hmdm.emuilauncherrestarter`, only when that app is installed). Phoenix runs
the launcher under the stock Lenovo home, so nothing relaunches it. 6.41's manifest has only
`BOOT_COMPLETED`; `PushLongPollingService` starts only from `Initializer.startServicesAndLoadConfig`.
So EVERY self-update leaves the tablet unmanaged (no commands, no sync, no location) until a reboot.

**Fix:** fork `Gawish-1997/hmdm-android`, branch `phoenix/restart-after-self-update`, commit
`9776c84`, **6.42 / versionCode 15420**: `PackageReplacedReceiver` on `MY_PACKAGE_REPLACED` (delivered
to the NEW version; exempt from the Android 8 implicit-broadcast limits) re-runs `Initializer.init` +
`startServicesAndLoadConfig(ctx, false)` — the `false` skips launching RustDesk so nothing flashes on
the rep's screen mid-day. Because the receiver lives in the NEW version, 6.39→6.42 and 6.41→6.42 both
restart themselves; a tablet already dead on the 6.41 install needs ONE physical restart.

**How to apply:** every future launcher build keeps this receiver; before moving row 10045 to a new
version, check the APK's manifest has `MY_PACKAGE_REPLACED` (scratchpad check: inflate
AndroidManifest.xml and search its UTF-16 string pool). A tablet silent right after "Silently
installing app com.hmdm.launcher" is this, not a network fault — a push cannot reach it.

**Owner's decision, 22 Oct 08:14 Cairo:** shown in plain words that 0008 went silent on 6.41 and that
Ganna's 0007 and 0002 would take the same version from config 3 when they next connect, he chose
**"Leave the new version"** over pinning config 3 back to 6.39. Never pin it back on your own
reading. Moving row 10045 forward to 6.42 is the fix, not a rollback.

**SHIPPED + PROVEN LIVE, 22 Oct 2026 Cairo:** 6.42 hosted at `https://phoenix-tablet-apps.fly.dev/hmdm-phoenix-6.42.apk` (sha256 `26e63e05…b537`, 6,286,121 bytes, same Phoenix cert `7b48e751…1c49`, built by fork run 39726534040); version row **10045** edited in place to 6.42/15420 (config 3 still 11 active links; 6.41 row pre-image in the audit scratchpad). On PHX-TAB-0008 (back on 6.41 after its 08:15 restart): push 08:24:33 → "Silently installing … 6.42" 08:24:37 → "phoenix: launcher updated to 6.42, restarting its services" + "MDM Launcher 6.42-opensource started" 08:24:40 → long-poll resumed 08:24:41 → "Update flow completed" 08:24:42, device record 6.42. **Five seconds, no restart.**

**Location is a SEPARATE blocker, not this one:** config 3 `requestUpdates=DONOTTRACK` stops `LocationService` (fork `Initializer.startLocationService` returns on a null mode), 0008’s check-in carries no `info.location`, deviceinfo dynamic holds 0 rows (sendData=true, 15 min), and `devicelocations/public/update` answers **404** — that plugin is not on this box, so 6.41/6.42’s `SendLocationsTask` uploads to nothing. Phoenix reads the check-in position + deviceinfo dynamic. Turning tracking on is his call (golden rule [[rep-tablet-never-shows-tracking-golden-rule]]).

**6.43 (code 15430), 22 Oct ~08:45 Cairo — the SECOND gap, found the same morning:** turning tracking on (config 3 `requestUpdates=GPS`, 08:30) reached 0008 at its 08:30/08:32 syncs and started NOTHING — `Initializer.startLocationService` ran only from `startServicesAndLoadConfig` (boot, enrolment, self-update), never from a sync (`ConfigUpdater.forceConfigUpdate`). 6.43 (fork branch `phoenix/location-follows-the-rules`, commit `ce391a3`, built by run 39728710062, sha256 `ea408cae…0f85`, same cert) calls it from `ConfigUpdater.lockRestrictions` at EVERY sync, stops a running service for DONOTTRACK with `stopService`, and has `LocationService` re-post its foreground notice on every start so repeated `startForegroundService()` calls cannot time out. Hosted at `https://phoenix-tablet-apps.fly.dev/hmdm-phoenix-6.43.apk`; row 10045 → 6.43 (6.42 pre-image kept). The local position queue is pruned at 24 h (`LocationTable.deleteOldItems`), so the dead devicelocations upload cannot fill a tablet.

Related: [[phoenix-launcher-6-41-built-completes-location-and-unattended-rustdesk]],
[[headwind-rep-tablet-custom-launcher-build-required]], [[a-stalled-enrolment-run-never-sends-the-tablets-hardware-report]].
