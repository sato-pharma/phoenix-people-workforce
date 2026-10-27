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

**Build base established 2026-09-27: `it-gawish-hr/hmdm-android`** (fork of `h-mdm/hmdm-android`, Java,
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

🔴 **MEASURED 2026-09-28 — THE TWO LAUNCHERS HAVE DIFFERENT SIGNING CERTIFICATES, SO NO IN-PLACE SWAP
IS POSSIBLE AND THE RE-ENROL IS THE ONLY PATH.** Read out of the APKs themselves (scan the whole file
for X.509 DER, not just `META-INF` — the stock APK has **no v1 block at all**, it is v2/v3-signed, so a
`META-INF` read alone answers "cannot tell" and looks like a broken probe):

- stock `hmdm-6.37-os.apk` — `C=RU, O=Headwind Solutions LLC, CN=Vsevolod Mayorov`, cert from 2017-02-22,
  sha256 `09:57:61:E0:…:97:57`
- fork `hmdm-phoenix-6.39.apk` — `CN=Phoenix Workforce Rep Tablets, O=Sato Pharma, C=EG`, cert from
  2026-09-26, sha256 `7B:48:E7:51:…:1C:49`

Android refuses an update signed by a different key (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). 🔴 **The
obvious-looking move is to bump version row 10045's `version`/`versionCode` to 6.39 so Headwind pushes
the update — DO NOT.** That makes the enrolled 6.37 launcher attempt the install on every check-in and
fail every time, forever, with nothing on screen to say why; leaving them at 6.37/0 is deliberate.
Uninstalling `com.hmdm.launcher` first is not an escape either — `removeHeadwindApp` refuses it by name
because it cuts the tablet off the company server for good.

🔴 **OWNER DECISION, 2026-09-29: the pilot PHX-TAB-0002 STAYS on the stock launcher 6.37 for now — do NOT push the re-enrol.** After being shown that the only thing the 6.39 fork buys is the clean status bar, and that PHX-TAB-0002 is a company-held pilot ("Pilot tablet - clean enrollment"), not in a rep's hands, he chose to leave it as it is. Everything else on it already works: Phoenix Workforce 0.4.0 installed and confirmed by the tablet's own app list (check-in 2026-09-29 00:10), config 3 rules applied and confirmed, normal Lenovo home (`defaultLauncher=false`), RustDesk live, ~20-min check-in cadence. The custom-launcher work is not cancelled — it is deferred until a tablet actually goes to a rep, because that is when Android's forced "your IT admin may see your data" / "location can be accessed" notices on the stock status bar start to matter against Golden Rule #1. Do not re-raise the reset for the pilot; the RustDesk-id-goes-stale concern only applies IF a reset happens, so it too is moot while this stands.

🔴 **DELIVERING NEW APP CODE TO A TABLET NEEDS A versionCode BUMP — Headwind AND Android both refuse a same-code replacement.** A tablet already on `com.satopharma.phoenixworkforce` code 4 will NOT take a fresh code-4 mdm APK however new its JS: Headwind compares versionCode to decide whether to push and sees the device up to date, and Android will not replace an equal-versionCode install. So a JS-only change (e.g. the web-shell #4701 + web-login #4702, both on main by 2026-09-29) reaches the fleet only after `mobile/app.json` `versionCode` is bumped (4 → 5) and a fresh `mdm` APK is built from that. The install then lands on the tablet's next ~20-min check-in.

🔴 **THE EAS FREE PLAN HAS A HARD MONTHLY ANDROID-BUILD CAP, AND WHEN IT IS SPENT A `mdm`/`preview`/`production` build FAILS at the "Build on EAS" step** with "This account has used its Android builds from the Free plan this month, which will reset in …". No APK is produced. It reset on 2026-10-01 (~02:05 Cairo, measured 2026-09-29). Options when capped: wait for the monthly reset, or upgrade the plan at expo.dev/accounts/phoenix-sato-crm/settings/billing (owner's billing click — a money move, never Claude's and never a chat "OK"). On 2026-09-29 the tablet delivery of the web-shell was blocked exactly here (code-5 branch `codex/mobile-tablet-code5`, PR #4703) and armed as scheduled task `ship-web-shell-to-tablets` (fireAt Oct 1 04:00 Cairo) to re-dispatch → host on Headwind config 3 → verify PHX-TAB-0002 takes v0.4.1/code 5. See [[the-mobile-app-is-a-shell-over-the-web-portal]].

🔴 **6.40 BUILT 2026-10-22 — THE LAST THREE PIECES ARE DONE (branch `phoenix/location-relock-frp`, fork CI green + apksigner-verified, release `launcher-6.40-r1`, `hmdm-phoenix-6.40.apk` 6286121 bytes, same Phoenix key).** On top of 6.39's clean status bar: (1) **location under the stock home** — `Initializer.startServicesAndLoadConfig` now starts `LocationService` (not only `MainActivity`), foreground-first so a background start cannot crash; inert while config 3 is `DONOTTRACK`, so flip `requestUpdates=network` AFTER the pilot confirms the bar hides the notice; (2) **re-lock after a failed app download** — the four protective restrictions (`no_factory_reset,no_safe_boot,no_debugging_features,no_add_user`) stay locked for the whole sync via `Utils.withoutProtectiveRestrictions`, so a 404 app can no longer leave reset open; (3) **factory-reset protection** — `Utils.applyFactoryResetProtection` on every sync, driven by the launcher's own `frp_accounts` **application setting** (comma-separated numeric **Google** account IDs; `off` removes; empty leaves alone; Android 11+ device owner only). Owner chose **it.satopharma@gmail.com** (22 Oct) for the FRP account — needs the account created and its **numeric** ID handed over (not the email). Phoenix-workforce PR hosts 6.40 in the entrypoint (`hmdm-phoenix-6.40.apk` from `launcher-6.40-r1`); docs §8.6/§8.8/§8.12. **Deploy is GATED on Railway** (builds paused 22 Oct). After the redeploy: point app-46 version 10045's `url` at `/files/hmdm-phoenix-6.40.apk` so NEW enrollments (today's 2–3 tablets) get it; 0007/0002 unchanged. The same key means an in-place update to 0007 IS possible later (versionCode 15390→15400), but 0007 is "leave as is" until the owner says. FRP honoured by the OEM — prove on the Lenovo TB328XU at the pilot.

🔴 **FRP ACCOUNT ID RETRIEVED 2026-10-22 (owner, via People API people/me).** it.satopharma@gmail.com → PROFILE/GOOGLE_USER id **107849983349318614848** (the Gaia profile id `setFactoryResetProtectionAccounts` wants, not the email). Set it in config 3's launcher `frp_accounts` application setting (pkg `com.hmdm.launcher`) at the 6.40 deploy — through `configurationWriteBody` so config 3's live app links and files are preserved (a bare whole-config PUT strips them). It is inert on 6.37/6.39 (they don't read `frp_accounts`), so it was NOT pre-set on the live config while 6.40 is undeployed. Also in session scratchpad `frp-account-id.txt`.

**22 Oct ~05:50 Cairo — apps and mail (PR #6248, head 3d99820a1).** Entrypoint re-fetches Telegram (telegram.org, floor 40 MiB) and WPS (WPS CDN, pinned 171366058) in a BACKGROUND subshell with WhatsApp; every fetch bounded (wget -T 30 -t 2); 6.39 still served beside 6.40 until version 10045 moves. Owner REFUSED K-9 ("so poor"), chose **Microsoft Outlook** (over Spark/FairEmail), knowing Copilot needs a Microsoft 365 mailbox. Outlook/LinkedIn/Facebook/Maps/Waze/ChatGPT (com.openai.chatgpt) and TapScanner (pdf.tap.scanner), both added by the owner 22 Oct, have no official APK: route = copy split APKs once from an Android phone that has them from Play (adb pm path + pull; adb not on the laptop), zip as `.xapk` (launcher's XapkUtils installs root `.apk` entries), upload onto the durable Railway volume (§8.4, waits for Railway). Merge of #6248 is owned by the session "Osama UE 1 DM Pedia outstation expenses issue" (owner's word there); this session does the post-deploy config 3 steps.

🔴 **FRP ID CORRECTED 22 Oct ~06:15 Cairo: it.satopharma@gmail.com (profile name "Sato IT") is 107849983349318614848.** Proven in the in-app browser signed in as that account: google.com/maps/contrib/107849983349318614848 opens its OWN profile ("Sato IT", "Edit profile"); also myaccount WIZ_global_data.S06Grb (read by the session "Osama UE 1 DM Pedia outstation expenses issue"). The earlier 105546929736523499344 (from the owner's People API paste) is a DIFFERENT account — its contrib page reads "Looking for your own reviews?" — most likely the People API panel was signed into his own account. Never use 105546929736523499344 for frp_accounts.

**22 Oct ~06:25 Cairo — Play-only apps: copy from a TB328XU, not a new phone.** Play delivers a per-Android-version variant: copies from the owner's Android 14 Galaxy A13 (SM-A137F, 32-bit armeabi-v7a only) came back minSdk=32 for LinkedIn, ChatGPT and TapScanner (Maps too), which the tablets (TB328XU, Android 12 = API 31, abilist arm64-v8a,armeabi-v7a,armeabi) refuse. Outlook 5.2641.1 from the phone is minSdk 30 → usable (`F:\Phoenix Workforce\tablet-apps\apps\outlook-5.2641.1.xapk`, 87,847,206 bytes, sha256 986e3de8…). The rest are copied from a NEW, not-yet-enrolled TB328XU (serial HA255RTX) with a personal Gmail signed in during setup; he removes the account and factory-resets it before QR enrolment. Tool: `F:\Phoenix Workforce\tablet-apps\copy-play-apps.mjs` (refuses Samsung stubs and anything with minSdk > 31). Google Maps dropped (phone build needs 12L).
**Copied 22 Oct 06:24 Cairo** (all in `F:\Phoenix Workforce\tablet-apps\apps\`, `copied.json` + `copied-phone.json` hold versions and sha256): LinkedIn 4.1.1263 (minSdk 29, 46,518,155 B), Facebook 583.0.0.39.55 (30, 114,708,198 B), Waze 5.25.5.0 (29, 88,163,704 B), ChatGPT 1.2026.286 (29, 59,514,954 B), TapScanner 3.1.23 (29, 41,419,427 B) from tablet HA255RTX; Outlook 5.2641.1 from the phone — `adb install-multiple` of its splits on HA255RTX answered **Success** (runs as armeabi-v7a). Next: durable volume on phoenix-headwind (§8.4) → upload the six `.xapk` → config 3 app rows set to install. Waits for Railway.
