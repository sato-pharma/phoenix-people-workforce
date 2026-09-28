---
name: headwind-rep-tablet-custom-launcher-build-required
description: "HIGH-PRIORITY TASK (owner, 2026-09-27): build a custom Headwind MDM launcher for the rep tablets — block factory reset + draw a clean status bar (hide Android's managed/location notices, keep clock/battery/wifi) + hide MDM app icons. Owner chose this free custom build over paying Headwind Premium."
metadata:
  node_type: memory
  type: project
  originSessionId: 4cbbb08b-a3eb-4d7b-bfc9-1db48f147979
  modified: 2026-09-27T22:57:12.779Z
---

🔴 **HIGH-PRIORITY OPEN TASK, owner-requested 2026-09-27: build a CUSTOM Headwind MDM Android
launcher for the ~100 rep tablets.** The free/open-source (`-os`) Headwind launcher cannot do what the
owner needs, so a small fork is required. The owner was shown Headwind **Premium ($2,990 one-time,
≤300 devices)** and **explicitly chose the free custom build instead** — do not re-pitch Premium
unless he raises it. See [[rep-tablet-never-shows-tracking-golden-rule]].

🔴 **CORRECTION 2026-09-27: FACTORY-RESET LOCK IS A CONFIG CHANGE, NOT A BUILD — my earlier
"needs a custom build / ProUtils stub" read was WRONG.** The community launcher DOES apply the
`restrictions` config field: `ConfigUpdater.lockRestrictions()` (helper/ConfigUpdater.java) calls
`Utils.lockUserRestrictions(context, config.getRestrictions())` UNCONDITIONALLY (not Pro-gated). It was
never blocked simply because config 3's `restrictions` was `null`. **DONE 2026-09-27: set config-3
`restrictions="no_factory_reset"`** (read-back OK) — the already-deployed 6.37 launcher applies it on
next sync, no build, no re-enroll. Settings stays OPEN; only chosen capabilities block; admin can still
wipe via the MDM console / hardware recovery. 🔴 **Verify on the device** (owner tries Settings → factory
reset → should be blocked). If 6.37 predates the call it won't block, but the custom launcher (6.39) has it.

🔴 **STATUS-BAR BUILD DONE IN THE FORK, 2026-09-28 — branch `phoenix/status-bar`, fork CI GREEN and
SIGNED** (`phoenix-build` run 36352997000, artifact `phoenix-launcher-signed-apk`). Awaiting the
owner's on-device re-enroll of the pilot to verify behaviour. Approach shipped: (a) `Utils.setStatusBarDisabled(context,true)`
as device owner disables the REAL status bar + shade system-wide — this hides Android's "Privacy
reminder"/"Location can be accessed"/managed notices AND the MQTT foreground notification AND the
shade route to the privacy dot in one move, so `MQTT_SERVICE_FOREGROUND` was deliberately NOT flipped
(push stays reliable, its notification is just invisible); (b) new foreground `StatusBarOverlayService`
draws a clean top bar — clock (left) via the launcher's own `StatusBarUpdater`, wifi icon + battery via
`BatteryStateView` (right), not touchable/focusable; (c) both wired into `Initializer.startServicesAndLoadConfig`
(runs at enrolment via `InitialSetupActivity` AND on boot, so it applies even though the launcher is not
the home); (d) dropped `LAUNCHER`/`LEANBACK_LAUNCHER` categories from `MainActivity` so the launcher shows
NO drawer icon (stays a HOME candidate). 🔴 **On-device unknowns to check at re-enroll:** whether
`setStatusBarDisabled` holds outside lock-task on this Lenovo (Android 12), whether the launcher has
`SYSTEM_ALERT_WINDOW` granted so the overlay draws (else the top is blank — bar still disabled, addView
is caught), and the privacy-dot edge case. Plugin/RustDesk drawer icons are separate APKs — hide those via
device-owner `setApplicationHidden` from the console, not this repo. Reversible: `setStatusBarDisabled(false)`.

🔴 **DEPLOYING THE CUSTOM LAUNCHER IS NOT AN API SWAP — that approach is a DEAD END (learned the hard
way, 2026-09-28).** The launcher application (Headwind app **id 46**, `com.hmdm.launcher`, version row
**id 10045**) is `deletionProhibited=true` and SEED-managed. `PUT /rest/private/applications/android`
answers `error.internal.server` for it, and `PUT /rest/private/applications/versions` does NOT persist
`filePath` and does NOT regenerate `url` from an uploaded file the way a normal app (RustDesk) does — so
you cannot push a custom launcher FILE through the app-upload REST API. What the versions endpoint DOES
accept for app 46 is an **explicit `url`** (sending `url:null` NULLS it — which is the mistake that broke
it). The stock launcher file is served at a fixed path `https://mdm.satopharma.com/files/hmdm-6.37-os.apk`
(seeded by Headwind's install SQL from the h-mdm.com URL; Headwind's own entrypoint re-downloads it to
`$BASE_DIR/files` if missing on redeploy — install SQL runs ONCE and does NOT re-set the DB row).
🔴 **RECOVERY DONE 2026-09-28:** a swap attempt nulled `10045.url`; restored it by PUTting the explicit
stock url via `/versions` (verified: serves 200, back in the device sync payload). Backup of the stock
APK is at scratchpad `launcher-stock-6.37-backup.apk` (ephemeral; the file also serves at the /files URL).
🔴 **The PROPER custom-launcher deployment (still to build):** host the custom APK at a `/files/` URL via
the entrypoint re-provision trick (exactly like RustDesk in `infra/headwind-phoenix-actions/phoenix-entrypoint.sh`),
then set app-46 version 10045's `url` explicitly to it — AND resolve the OPEN UNKNOWN: the enrollment QR's
`PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM` must match the **Phoenix signing key's** cert SHA-256, or a
fresh device-owner enroll fails at "downloading admin app". 🔴 **PROBED 2026-09-28: the checksum is NOT
stored** — config 3 has `launcherUrl`/`qrParameters`/`adminExtras` all NULL and `/rest/private/settings`
holds no signature/checksum/qr field — so Headwind almost certainly COMPUTES it from the served launcher
APK at QR-gen, meaning pointing version 10045's url at the custom file should auto-correct the QR checksum.
Still DECODE the actual QR post-deploy to confirm before the pilot factory-reset (the entrypoint PR that
hosts the custom APK is #4582).
🔴 **DEPLOYED + VERIFIED END-TO-END 2026-09-28.** PR #4582 merged → `phoenix-headwind` redeployed → the
entrypoint hosts `/files/hmdm-phoenix-6.39.apk` (HTTP 200, 6286121 bytes). Version 10045 url set to it
(version/versionCode LEFT at 6.37/0 on purpose, so Headwind does NOT try to self-update the enrolled
pilot — a fresh enrol is what installs the custom launcher). The enrolment QR (decoded with jsqr+pngjs)
now carries `PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION=…/hmdm-phoenix-6.39.apk` and
`PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM` = base64url(sha256(custom APK)) — VERIFIED byte-for-byte
against the local APK, so a factory-reset + scan installs the custom launcher cleanly. **Remaining = the
pilot RE-ENROLL (owner's hands)** — factory reset PHX-TAB-0002 → tap 6-7× → wifi → scan config-3 QR →
enter `PHX-TAB-0002` → pick Quickstep. On-device checks: status bar clean (no managed/location notices,
clock/battery/wifi shown), no MDM icon in the drawer. The on-device unknowns (setStatusBarDisabled holds
outside kiosk? overlay permission granted so the clean bar draws?) resolve only at that re-enrol. Do this as a reviewed entrypoint PR + a
`phoenix-headwind` redeploy, NEVER blind production API pokes. `railway run --service phoenix-people-workforce
-e production node <script>` injects the Headwind creds (`HEADWIND_MDM_*` are NOT in `.env.local`); md5-uppercase
password → `/rest/public/jwt/login`. The auto-mode classifier intermittently blocks these prod writes as
"Modify Shared Resources" — the owner allows `railway run` per-request.

**The custom build is now needed for ONE thing only (the other two below):**
1. ~~Block factory reset~~ — DONE via config above; NOT a build.
2. 🔒 **A CLEAN STATUS BAR that hides Android's tracking notices but KEEPS clock/battery/wifi.** On the
   normal Lenovo home the status bar is visible and Android FORCES "Privacy reminder — your IT admin may
   see your data" and "Location can be accessed — your IT admin is allowing MDM Agent to access your
   location" onto it. These are the OS's own anti-stalkerware disclosures — **no MDM setting or server
   toggle removes them**, and `blockStatusBar` only works on Headwind's managed home (not the stock home).
   The owner requires BOTH: notices gone AND clock/battery/wifi visible. Solution the owner approved: the
   custom launcher calls `setStatusBarDisabled(true)` (device-owner) to kill the real bar + shade, and
   draws its OWN overlay bar (real clock/battery/wifi) on top. Verify the momentary green/orange privacy
   dot is covered too.
3. Hide the MDM app icons (Headwind launcher, Pager/Dialpad/Launcher-Restarter plugins, and RustDesk once
   its ID is read) from the Lenovo app drawer.

**Build base established 2026-09-27: `Gawish-1997/hmdm-android`** (fork of `h-mdm/hmdm-android`, Java,
gradle 8.13/AGP 8.13.2/JDK 17/compileSdk 34, flavor `opensource`, Apache-2.0, branch `master`). The
deployed launcher is 6.37 / `hmdm-6.37-os.apk`; source is 6.39. CI pipeline is GREEN: workflow
`.github/workflows/phoenix-build.yml` builds `:app:assembleOpensourceRelease`, zipaligns, and signs.
🔴 **Do NOT use `android-actions/setup-android@v3`** — it fails on a dead `tools` package; use the
runner's pre-installed SDK. 🔴 **SIGNING KEY (reuse for ALL updates or in-place update breaks):**
PKCS12 at `~/.claude/backups/headwind-launcher-signing/phoenix-launcher.p12` + `CREDENTIALS.txt`
(alias `phoenix`, made with openssl — no local keytool/JDK on this box). Same key is in the fork's
Actions secrets `ANDROID_KEYSTORE_B64/_PASSWORD`, `ANDROID_KEY_PASSWORD/_ALIAS` — CI signs from those.
Owner should copy the backup off-machine (only two copies exist: laptop + fork secrets).

**Build/deploy pipeline (not a laptop job — 16 GB, Android gradle build would freeze it → GitHub Actions
CI in the fork):** apply the patch, build + **sign** the APK (keep the signing key so future
updates install in place — a different key means a re-enroll), host it (reuse the RustDesk
entrypoint re-provision trick so it survives redeploys), set it as the enrollment launcher, re-enroll.
A custom launcher = a different signature from stock → one final re-enroll of the pilot.

🔴 **SECOND OWNER-REQUESTED BUILD (2026-09-27): show the tablet screen INSIDE Phoenix, NO desktop
app.** Today Phoenix's "View the screen"/"Take control" buttons (`headwind-fleet.tsx`) only LAUNCH the
RustDesk **desktop app** via a deep link (design deliberately kept the video out of Phoenix — doc §4.5).
The owner overrode that: he wants the picture rendered in the Phoenix page. That means wiring the
**RustDesk WEB client** into Phoenix. Real R&D, honest risks to resolve first: (1) we use RustDesk's
PUBLIC relay (no self-hosted relay — Railway can't do the UDP hole-punching, §4.5), and the web client
wants a websocket rendezvous — confirm the public relay serves a web client for our device IDs, or a
relay must be stood up somewhere Railway can't host; (2) the RustDesk **Android** side must accept
web-client sessions; (3) 🔴 the screen password must NEVER go in a URL/query (doc §4.5 — logged
everywhere = anyone can drive the tablet), so credential handling needs care. Not a quick add.

**What is already DONE and NOT part of this task:** the http→https fix (#4498), RustDesk re-provisioning
(#4503, merged 2026-09-26), and the **normal Lenovo home** — the pilot PHX-TAB-0002 is enrolled, green,
`defaultLauncher=false`, on the stock Lenovo home, with RustDesk 1.4.9 installed. RustDesk ID
`1421879986` is SAVED to `custom1` (Remote screen ID) — the desktop-app launch path works. 🔴 Small
bridge bug found doing it: `setHeadwindRemoteScreenId` PUTs the device with `info` as an OBJECT but
Headwind's `PUT /rest/private/devices` wants `info` as a JSON STRING (400 `Cannot deserialize … String
out of START_OBJECT … Device["info"]`) — stringify `info` before the PUT; I set it by hand this time.
🔴 **FIXED in PR #4568 (open, awaiting CI + owner merge, 2026-09-28):** shared `deviceWriteBody(device,
patch)` in `src/lib/devices/headwind/devices.ts` stringifies `info` and both `PUT /rest/private/devices`
callers (`remote-screen-id.ts`, `configurations.ts` `moveHeadwindDeviceToConfiguration`) go through it;
pinned by a new object-`info` fixture in `tests/headwind-bridge.test.ts`. Do not re-fix.
