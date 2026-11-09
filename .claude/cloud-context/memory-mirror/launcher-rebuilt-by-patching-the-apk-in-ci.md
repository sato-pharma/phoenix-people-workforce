---
name: launcher-rebuilt-by-patching-the-apk-in-ci
description: "9 Nov 2026 — with the launcher source gone, the rep-tablet launcher is now rebuilt by patching the proven 6.48 APK in GitHub Actions on Omar-3-xx/hmdm-android (public); workflow patch-launcher.yml, modes inspect/build-unsigned/build. Signing needs the owner's key in repo secrets."
metadata:
  node_type: memory
  type: project
  originSessionId: dd58f0ee-c080-4c4d-b6a3-efefe32f1614
  modified: 2026-11-09T07:07:09.571Z
---

Because the launcher SOURCE is unrecoverable ([[launcher-fork-account-suspended]]), a new launcher is
built by **patching the compiled 6.48 APK** in CI, not from source. Home: **`Omar-3-xx/hmdm-android`**
(made **public** 9 Nov so a free account gets Actions minutes — a private free repo failed every run in
2 s with no runner; the APKs in it are already public via `mdm.satopharma.com/files/`, and the signing
key is a protected secret that public visibility does not expose). gh is signed in as `Omar-3-xx`.

**Workflow `.github/workflows/patch-launcher.yml`, `workflow_dispatch` input `mode`:**
- `inspect` — decompiles 6.48 (apktool 2.9.3) and prints/uploads the smali to edit.
- `build-unsigned` — applies the edits, rebuilds, re-decompiles and asserts each edit landed, uploads the
  UNSIGNED aligned APK. **PROVEN GREEN 9 Nov** (run 42558147749) — no key needed.
- `build` — the above + signs with the Phoenix key from repo secrets, then **refuses to publish unless the
  new signing cert equals the fleet's 6.48 cert** (a wrong key = every tablet needs a factory reset), then
  makes release `launcher-<v>-r1`.

**The two edits** (`scripts/apply-patches.sh` + `scripts/patch-statusbar.sh`), on a FRESH decompile each run:
1. lock-screen line → "This device is not private. It belongs to Sato Pharma." (`Utils.smali` field + the
   `const-string` before `setDeviceOwnerLockScreenInfo`). [[tablet-lock-screen-says-not-private]]
2. restore the pull-down + Android notices: in `Utils.setStatusBarDisabled` insert `const/4 p1, 0x0`
   before the `DevicePolicyManager->setStatusBarDisabled` call (never disable the bar); in
   `Initializer.smali` insert `goto :goto_6` after the `setStatusBarDisabled` call-site to skip starting
   `StatusBarOverlayService` (the overlay that hid the notices). [[launcher-status-bar-is-not-gated-on-blockstatusbar]]
   🔴 **Never guard a smali edit with a global grep for a common opcode** (e.g. `const/4 p1, 0x0`): it
   false-trips and silently skips the edit — this exact bug cost two CI runs. Fresh decompile = no guard needed.
   🔴 **Smali comments do NOT survive a rebuild** — verify by instructions, never by an inserted `# comment`.

**Signing secrets (owner's hands — Claude never reads the key):** `SIGNING_KEYSTORE_B64` (base64 of
`~/.claude/backups/headwind-launcher-signing/phoenix-launcher.p12`), `SIGNING_KEYSTORE_PASSWORD`,
`SIGNING_KEY_ALIAS`, `SIGNING_KEY_PASSWORD` (from that folder's `CREDENTIALS.txt`). Then dispatch `build`.

**✅ SIGNED 6.49 IS BUILT (9 Nov 2026):** release `launcher-6.49-r1` → `hmdm-phoenix-6.49.apk`
(6,466,497 bytes) on `Omar-3-xx/hmdm-android`; CI verified **its cert equals the fleet's 6.48 cert**
("signing certificate matches the fleet — safe to ship"), versionCode bumped 15480→15481. Both edits
proven in the rebuilt apk. The signing secret snag was a wrong `SIGNING_KEYSTORE_PASSWORD` (a PowerShell
paste gremlin); the correct one is 48 chars and now set — verify-key mode is green.

**HOSTING ROUTE (settled 9 Nov):** `railway ssh` into phoenix-headwind is REFUSED by this laptop's
classifier, so the APK cannot be hand-copied from here. The ONLY route is the **entrypoint +
redeploy**: `phoenix-headwind` recreates `/files/` from `infra/headwind-phoenix-actions/phoenix-entrypoint.sh`
on every redeploy, and its Railway `watchPatterns: ["infra/headwind-phoenix-actions/**"]` means a merge
touching that path AUTO-redeploys the box. There is a persistent `phoenix-headwind-volume` mounted at
`/usr/local/tomcat/work/files`, so the hand-placed 6.48 has survived — BUT the entrypoint still named
only 6.39/6.40, so a redeploy without the volume (or a volume reset) would 404 the whole fleet's launcher.

**PR [#189](https://github.com/sato-pharma/phoenix-people-workforce/pull/189) OPEN (9 Nov):** entrypoint now
re-provisions **6.48 (previous, 6290217) + 6.49 (current, 6466497)** from their Omar-3-xx releases;
`tests/headwind-bridge.test.ts` updated to match (passes in isolation), check-contracts clean. Both release
assets verified downloadable at the pinned sizes. Merging #189 auto-redeploys phoenix-headwind and hosts both.

**✅ HOSTING DONE + PROVEN (9 Nov, merge `29260be32` ~06:45 Cairo):** #189 merged → phoenix-headwind
redeployed → `https://mdm.satopharma.com/files/hmdm-phoenix-6.49.apk` HEAD **200, Content-Length 6466497**
and `…/6.48.apk` **200, 6290217** (exact signed sizes). Both now re-provisioned on every future redeploy,
so the earlier redeploy landmine (entrypoint named only 6.39/6.40) is closed.

**✅ SHIPPED TO THE WHOLE FLEET (9 Nov 2026, owner's word "Ship 6.49 to all 3"):** version row **10045**
edited IN PLACE via `PUT /rest/private/applications/versions` → version `6.49`, versionCode **15481**
(> installed 15480, forward-only), url `https://mdm.satopharma.com/files/hmdm-phoenix-6.49.apk` (HEAD 200,
Content-Length 6,466,497 = the signed size). All three rep configs (`Rep tablets` 3, `— Anti Infective` 4,
`— Pedia` 5) read **current 6.49**. Same signing cert as 6.48 → installs in place, no factory reset. The
three rep tablets (PHX-TAB-0007 Gannatullah, 0008, 0009) update at next check-in.

🔴 **apkHash IS NULL ON THIS ROW AND THAT IS CORRECT — DO NOT RE-FIGHT IT.** The server refuses a
client-supplied `apkHash` (it only computes one during its own upload flow, and a url-edit carries none),
so changing the url nulled the old 6.48 hash. **Proven harmless 9 Nov:** ALL 11 apps the fleet runs
(Telegram, WhatsApp, WPS, Outlook, LinkedIn, Facebook, Waze, ChatGPT, TapScanner, RustDesk, launcher)
have a null apkHash and all install — the agent drives updates by versionCode, not hash. 6.48 having a hash
was the odd one out. Never try to "restore" the hash; it cannot be set by PUT and is not needed.

🔴 **6.49 DID NOT RESTORE THE PULL-DOWN ON PHX-TAB-0009 (owner, 9 Nov ~07:20 Cairo).** There are THREE
blockers, not two: 6.49 removed the DPM disable and StatusBarOverlayService, but `ProUtils.preventStatusBarExpansion`
(a touch-eating window at the top, drawn when the rules say `blockStatusBar`) remained. On his word ("turn off
block status bar on Rep tablets, Anti Infective and Pedia") `blockStatusBar` was set FALSE on configs 3, 4, 5 at
07:30 Cairo (links + mainAppId 10045 read back identical; 0009 logged `configUpdated` 07:30:34). RustDesk popping up
on boot = `Utils.startRemoteAccessApp` (startActivity). Branch `phx/launcher-6.50` on Omar-3-xx/hmdm-android
(commit 45a4124) adds `scripts/patch-quiet.sh`: D) startRemoteAccessApp → return-void, E) preventStatusBarExpansion
→ return null; and fixes the version-code bump (code now follows the name: 6.50 → 15482; the old +1 would have
repeated 15481). First build-unsigned run 42567059548 failed on a GitHub 504 fetching apktool — not the patches.
The launcher log's "6.48-opensource started" after 6.49 is a stale BuildConfig label, not old code.

**✅ 6.50 SIGNED (9 Nov 2026 ~08:25 Cairo, owner "Sign + hosting PR"):** release `launcher-6.50-r1`, 6,466,497 B
(same size as 6.49 by coincidence, different SHA), code 15482, cert match proven. Adds edit F: `AdminActivity.clearRestrictions`
also calls `unlockUserRestrictions(this, "no_debugging_features")` — the fork's `Utils.PROTECTIVE_RESTRICTIONS`
(factory reset, safe boot, debugging, add user) are never lifted by a config change or by Clear restrictions, which is
why Build number stayed "restricted" on 0009. Hosting PR #199 (`codex/launcher-650-host`, worktree `_wt-launcher-650-host`).
After his merge: move version row 10045 to 6.50 / 15482 / `…/files/hmdm-phoenix-6.50.apk`, on his word.
**Cable session on 0009 (08:19–08:25):** pull-down + quick settings WORK by finger; lock-screen line reads correctly;
home was the launcher's own desktop (cropped logo) → set Lenovo home with `cmd role add-role-holder --user 0
android.app.role.HOME com.tblenovo.launcher 0`. Headwind's "Push notifications are active" notice (MQTT channel,
importance 3) is visible to the rep — open item. adb lives at the session scratchpad `adb/platform-tools/adb.exe`.

**✅ 6.50 SHIPPED (9 Nov 2026, owner "ship 6.50 to all 3"):** roll-up #200 (199 + 197) merged 08:36 Cairo
(`510cd1543`), 6.50 served 200/6466497 at 08:37:22; row 10045 → 6.50 / 15482 / `…/hmdm-phoenix-6.50.apk`;
configUpdated pushed. PHX-TAB-0009 installed 08:37:52 and reports 6.50 with no "Remote access app started" after
the restart; PHX-TAB-0007 installing 08:39:16; 0008 offline since 22 Oct.

**6.51 SIGNED (9 Nov 2026, owner "hide the Push notifications are active notice in launcher 6.51" → MCQ
"Quiet it, keep instant"):** branch `phx/launcher-6.51` (commit b97a702, `scripts/patch-notice.sh`), release
`launcher-6.51-r1`, 6,466,497 B (same size again; sha256 5bc622f4… ≠ 6.50's 51bc2d11…), code 15483, cert match proven.
The notice is `PushLongPollingService.startAsForeground` (pushOptions `polling` = the instant line over 443);
Android 12 forbids a notice-less FGS, and without the service only the hourly forced config sync remains (polling
mode's worker does nothing else). Edit G: channel importance 3→2 (LOW; MIN would be bumped to LOW for an FGS) and
`mqtt_service_text` → "Sato Pharma" in all 17 locales. Hosting PR #203 (`codex/launcher-651-host`, worktree
`_wt-launcher-651-host`) serves 6.51 + keeps 6.50. After his merge: row 10045 → 6.51 / 15483 / `…/hmdm-phoenix-6.51.apk`
on his word. Tablets run **Android 12** (no POST_NOTIFICATIONS route).
**✅ 6.51 SHIPPED (9 Nov 2026, owner "merge 203 when green" + "ship 6.51 to all 3"):** #203 merged 09:02 Cairo
(`e84132392`, alone — PHX_MERGE_OK because a non-required CodeQL check was still pending); 6.51 served 200/6466497
from 09:05:51 Cairo, 6.50 still served; row 10045 → 6.51 / 15483 / `…/hmdm-phoenix-6.51.apk`; configUpdated pushed
to 0009, 0007, 0008. Worktree `_wt-launcher-651-host` removed on his word.

**ONLY REMAINING — the owner's eyes on a tablet:** on any rep tablet after its next check-in, confirm the
pull-down returns, Android's privacy notices show, and the lock screen reads "This device is not private.
It belongs to Sato Pharma." Nothing else is left in code.
