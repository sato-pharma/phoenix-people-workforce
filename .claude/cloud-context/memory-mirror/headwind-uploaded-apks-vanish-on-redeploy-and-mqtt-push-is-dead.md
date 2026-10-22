---
name: headwind-uploaded-apks-vanish-on-redeploy-and-mqtt-push-is-dead
description: "Measured 2026-10-22: Headwind serves /files from Tomcat's work dir, wiped on every phoenix-headwind redeploy; only RustDesk and the launcher are re-provisioned, so Telegram, WPS and WhatsApp answer 404. MQTT push (TCP 31000) never arrived; config 3 was switched to polling over 443 at 04:10 Cairo the same day on the owner's word, with the three 404 apps set to remove."
metadata:
  node_type: memory
  type: project
  originSessionId: c29197d2-a532-44ff-a422-13b4f76de2d7
  modified: 2026-10-22T01:11:22.276Z
---

Measured 2026-10-22 ~01:00 Cairo.

- **Files.** `infra/headwind-phoenix-actions/phoenix-entrypoint.sh` explains `/files/<name>` lives
  under `/usr/local/tomcat/work`, recreated bare on each redeploy; it re-downloads only
  `rustdesk-1.4.9-aarch64-signed.apk` and `hmdm-phoenix-6.39.apk` (both 200). Config 3 still lists
  Telegram 13.0.1, WPS Office 18.25.2 and WhatsApp 2.26.40.72 at `/files/...` — **all three 404**. A
  tablet that lacks one retries the download at every sync; a newly enrolled tablet never gets them.
  Any APK uploaded through the console or Phoenix's upload dies at the next redeploy unless it gets a
  volume or an entrypoint re-provision.
- **Push.** Config 3 `pushOptions = "mqttAlarm"` (MQTT on TCP 31000). `docs/devices/headwind-rustdesk.md`
  §4.4 says 31000 is not published on Railway. In MQTT mode the agent's `PushNotificationWorker` never
  fetches push messages over HTTP — it only forces a config update once an hour. So `/rest/private/push`
  messages (Phoenix's "locate" sends `configUpdated`) do not wake the tablet; the hourly sync is the only
  channel. Headwind's "HTTP polling" option (`polling`, `PushLongPollingService`) needs only 443.
  🔴 **SWITCHED 2026-10-22 04:10 Cairo, on the owner's word ("Apply all of it")**: config 3 is now
  `pushOptions=polling`, `restrictions=no_factory_reset,no_safe_boot,no_debugging_features,no_add_user`,
  and Telegram (84), WPS (85), WhatsApp (86) are `action 2` (remove) so the install queue completes and
  the agent re-applies `no_factory_reset`. Pre-image in the session scratchpad `config3-pre-image.json`;
  audit row `headwind_configuration` 3 at 04:10:26. Polling shows the same foreground notice MQTT mode
  already showed (same channel and text), so no new visible sign. Not yet seen on a tablet — 0007 is
  offline. Re-add the three apps (action 1) only once their `/files` answer 200.
- **Launcher version mismatch is harmless.** Version row 10045 says 6.37 while serving the 6.39 file; a
  6.39 tablet reads that as a downgrade with no matching remove entry and ignores it
  (`InstallUtils.generateApplicationsForInstallList`) — no reinstall loop.

🔴 **WhatsApp fix MERGED but NOT YET LIVE (2026-10-22 01:32 Cairo): PR #6232** (squash commit
`3ab1cc2`) adds a `phoenix-entrypoint.sh` block that fetches the OFFICIAL current WhatsApp from
`whatsapp.com/android/current/WhatsApp.apk` on every start (checked by an 80 MiB minimum + zip magic,
a floating source, not a pinned-size asset). The owner approved "host the official WhatsApp." Verified
the live APK is **2.26.41.78** (newer than config 3's 2.26.40.72), so after install the agent leaves it
(benign "Ignoring downgrade request") and nothing loops — no Headwind record change. The PR pins it in
`tests/headwind-bridge.test.ts` (runServerImageTests) and documents the redeploy survivors in
`docs/devices/headwind-rustdesk.md` §6.3. Worktree + branch retired after merge.
🔴 **It cannot ship until Railway's platform-wide deploy pause lifts.** Measured 22 Oct ~01:35 Cairo:
`phoenix-headwind` last deployed **2026-10-14**, so `/files/WhatsApp.apk` is still **404** (the launcher
APK is 200, so the server is up — it just has not rebuilt); the main app serves `f39baf072` from Oct 20
21:29, with three merges unserved. status.railway.com shows an OPEN Major Outage: builds paused all
plans, plus a 22:10 UTC security notice advising customers to revoke Railway-stored env vars and review
logs, and Railway rotating its bucket credentials. **Re-probe `/files/WhatsApp.apk` for 200 once builds
resume and phoenix-headwind redeploys; only then is this shipped.** See inbox notes
[[a-railway-build-outage-leaves-no-deployment-row]] and
[[zero-deployment-rows-means-a-railway-build-outage-not-a-withheld-deploy]].

🔴 **WPS and Telegram are NOT fixed by that PR, and a console re-add of them is WIPED by the very next
phoenix-headwind redeploy** (same ephemeral `/files`). They have no official direct URL (Telegram's is
`org.telegram.messenger`, not the `.web` Play build; WPS has none), so the durable path is: the owner
uploads each once in the console → a session grabs the bytes from `/files` immediately → mirrors them to
a public release (like the launcher on the hmdm-android fork) → wires an entrypoint block pinned to that
exact size. Until then they stay 404.

Related: [[headwind-sync-endpoint-is-public-and-feeds-the-custody-register]],
[[headwind-rep-tablet-custom-launcher-build-required]], [[phx-tab-0007-is-the-first-rep-held-tablet]].
