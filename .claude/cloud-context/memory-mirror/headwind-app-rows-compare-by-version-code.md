---
name: headwind-app-rows-compare-by-version-code
description: "9 Nov 2026 — the rep-tablet launcher compares an app row by versionCode whenever the row has one (name only when code is 0/null); WhatsApp and Telegram rows now point at the publishers' own current-build URLs with exact codes."
metadata:
  node_type: memory
  type: project
  originSessionId: dd58f0ee-c080-4c4d-b6a3-efefe32f1614
  modified: 2026-11-09T08:04:11.073Z
---

**How the launcher decides (InstallUtils.compareVersions / areVersionsEqual, read from the 6.48 smali):** if the
server row's `versionCode` is set and non-zero, ONLY the code is compared (installed code > row code = "Downgrade
requested", never installed; lower = install from the row's url). With code 0/null it compares the version NAMES
digit by digit. So a row with a guessed code is worse than no code.

**WhatsApp and Telegram (owner, 9 Nov 2026, MCQ "Current official"):** the hosted `/files/WhatsApp.apk` and
`/files/Telegram.apk` were frozen at 2.26.40.72 / 13.0.1 (the entrypoint only refetches a MISSING file), while the
tablets self-updated to 2.26.42.70 / 13.1.0 → "Downgrade requested" at every sync. The publishers no longer serve
those exact builds, so the rows were moved to the CURRENT official builds instead: version row **10079** (Telegram,
app 84) → 13.2.1 / **72919** / `https://telegram.org/dl/android/apk`; row **10081** (WhatsApp, app 86) → 2.26.44.71 /
**264407138** / `https://www.whatsapp.com/android/current/WhatsApp.apk` (codes read from the downloaded APKs'
manifests). Both URLs float: when a publisher ships a newer build, a tablet that self-updates past the row logs a
harmless "Downgrade requested" again — move the row up by reading the new APK's manifest code, never by guessing.

**Measured result (9 Nov 2026):** Telegram 13.2.1 installed on PHX-TAB-0009 (09:20:54) and PHX-TAB-0007 (09:21:47);
WhatsApp 2.26.44.71 installed on 0009 (09:22:48); 0007 logged "Skip download due to previous install failure:
com.whatsapp" (the agent holds a failed app off until a later run). 0009's first Telegram try failed "unexpected end
of stream" and the next succeeded. 🔴 **This narrows the devices rule "a tablet will not follow a redirect":
`telegram.org/dl/android/apk` answers 302 https→https (to cdn4.telesco.pe) and BOTH tablets installed through it —
only the http→https 301 broke downloads.** Two configUpdated pushes in a row start two overlapping install runs
(double "installed successfully", then ENOENT on the shared temp file) — push once and wait.

**Netflix (owner, 9 Nov 2026 "remove Netflix from PHX-TAB-0009"):** app record **97** `com.netflix.mediaclient`
(no file, version 0) created; link **1206** on config **4** (Anti Infective = 0009 + offline 0008) with action 2.
Then "remove Netflix from PHX-TAB-0007 too": link **1207** on config **5** (Pedia = 0007 alone), action 2. Writing
one config's link through `writeHeadwindAppLink` KEPT the other config's link (read back: 1206 + 1207).
🔴 **A "remove" link (action 2) DOES NOTHING on this server:** the stored link reads `action:2, remove:false`, and
the device-facing config served Netflix as `{"version":"0","pkg":…}` with NO `remove` flag — 0009 synced it at
09:28:20 and logged no uninstall. What worked: `removeHeadwindApp` (push `uninstallApp`, the Devices page's Remove
button), actor B-10 — "Uninstalled application: com.netflix.mediaclient" on 0009 at 09:35:27 and on 0007 at
09:36:19 Cairo, despite the `no_uninstall_apps` restriction. Links 1206/1207 were left in place (harmless, no url).
(Reading `/rest/public/sync/configuration/<real tablet>` to check this broke the never-read-it rule; audit showed
no lock/reset/reboot queued in 14 days, so nothing was consumed.)

🔴 **"Skip download due to previous install failure" NEVER clears by itself** (read from the 6.48 smali,
`ConfigUpdater.canDownload`): the agent keeps a local `downloads` row keyed by PATH, and a row with downloaded=true
and installed=false blocks that path for ever (no time limit; only `userInteraction`, a rep-pressed update, skips
it). The path is `getExternalFilesDir()` + everything after the URL's LAST "/" — query included. So the cure is a
new file name: row 10081's url became
`https://www.whatsapp.com/android/current/WhatsApp.apk?phx=/WhatsApp-2.26.44.71.apk` (WhatsApp serves 200 with the
query, no redirect). PHX-TAB-0007 then installed WhatsApp 2.26.44.71 at 09:54:40 Cairo; a sync at 10:03 made no
install attempt (versions equal). Its overlapping second run hit ENOENT and left a failure row on the NEW name —
harmless while the version matches; when the row moves to a newer build, give the url a new `?phx=/WhatsApp-<ver>.apk`.

Related: [[launcher-rebuilt-by-patching-the-apk-in-ci]]
