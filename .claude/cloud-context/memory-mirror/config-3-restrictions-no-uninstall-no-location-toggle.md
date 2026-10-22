---
name: config-3-restrictions-no-uninstall-no-location-toggle
description: "Config 3 (Rep tablets) restrictions were extended 22 Oct 2026 to no_config_location + no_uninstall_apps so a rep can no longer uninstall apps or toggle location; the deeper control (RustDesk kept alive, location forced on, continuous reporting) still needs the custom launcher, and all tablet-FILE changes are blocked while Railway is paused."
metadata:
  node_type: memory
  type: project
  originSessionId: c29197d2-a532-44ff-a422-13b4f76de2d7
  modified: 2026-10-22T04:45:47.089Z
---

**What the Headwind rep tablets can and cannot do, read live 22 Oct 2026 07:0x Cairo on PHX-TAB-0008.**

Push commands all WORK (server→tablet in ~3 s, verified on 0008): Apply settings (`configUpdated`),
Wake remote app (`runApp`), Restart, Pause/Resume kiosk (`exitKiosk`/`configUpdated`), Lock/Unlock
(add-on `lock`/`lock:false`). Factory reset proven once on 0002 (26 Sep).

The owner's four real complaints and their cause — the tablet runs the **stock Android launcher with
kiosk off and the free agent**, so the rep has the whole device:
1. **RustDesk stops after a reboot** — `runAtBoot=true` is set on config 3, but under the stock home the
   agent does not keep RustDesk alive. Fix = the custom launcher (auto-start + keep-alive + un-killable).
2. **The apps are on the tablet now, served from Fly, Railway untouched** (owner, 22 Oct: "use
   fly.io donot wait railway"). A tiny always-on Fly box `phoenix-tablet-apps.fly.dev` serves six
   `.xapk` (Outlook, LinkedIn, Facebook, Waze, ChatGPT, TapScanner); config 3 lists all six as
   `action=1` install pointing at that host. **Proven installing on PHX-TAB-0008 22 Oct 07:33–07:38
   Cairo**, read from the device log — no Railway. The three old Play-only apps that used to 404 and
   stall the loop (Telegram/WPS/WhatsApp) are set `action=2` remove, so the install loop completes
   cleanly every run (which is also what lets `lockRestrictions` re-apply at the end). **Rollout is
   FLEET-WIDE including Ganna's 0007** (owner chose "Let it get the apps" over keeping hers app-free,
   22 Oct) — config 3 is shared, so 0002 and Ganna's 0007 install the six when they next check in.
   Script: scratchpad `hw-apps-fly.mjs` (modes probe/list/create/delete/link/show). The Railway
   durable-volume route for a console/Phoenix APK upload is still wanted but no longer blocks the reps.
3. **Rep can turn location off** — partly fixed below; forcing location ON needs the custom launcher.
4. **Rep can uninstall RustDesk** — FIXED below.

**Applied 22 Oct 2026 ~07:14 Cairo (owner chose "full fix"):** config 3 `restrictions` extended from
`no_factory_reset,no_safe_boot,no_debugging_features,no_add_user` to add **`no_config_location`**
(rep can no longer change the location switch) and **`no_uninstall_apps`** (rep can no longer uninstall
any app, RustDesk included). Written with the app links rebuilt from
`/rest/private/configurations/applications/3` so the PUT could not strip them (the
[[headwind-whole-config-put-must-carry-app-links]] trap). `no_uninstall_apps` does NOT block the device
owner's own silent removals, so the MDM can still push app removals. Reaches **config 3, the shared rep
ruleset** — only 0008 was online; 0002 (12 Oct) and Ganna's 0007 (19 Oct) pick it up when they next
check in. Script: scratchpad `hw-lock-restrictions.mjs`.

**Still needed for real see/know/control**, all gated on Railway resuming (another session holds the
owner's word to deploy phoenix-headwind on resume): the **custom launcher** (keeps RustDesk alive,
forces location on, draws the lock, hides the tracking notices, reports location + foreground app +
RustDesk state every 15 min) — the HIGH task [[headwind-rep-tablet-custom-launcher-build-required]] —
and the six apps onto the durable volume. Physical confirmation of the two restrictions (location
toggle greyed, uninstall refused) needs eyes on 0008.

**Claude cannot watch a tablet's live SCREEN — only the owner can, via the RustDesk desktop app.**
View/Take control open a `rustdesk://` link in the RustDesk app on a computer; there is no web viewer
(relay is native-client only), and Claude never drives his screen. What Claude sees is everything the
server records (apps, rules, battery, full action/audit history, location if any) — read live, no
tablet help needed. **Owner's decision 22 Oct: RustDesk UNATTENDED access** (fixed password +
start-at-boot + the capture/accessibility permission pre-granted by the device-owner launcher) so he
opens any tablet's screen without the rep. Honest Android caveat: MediaProjection screen capture needs
ONE on-device grant, done once at provisioning (by us), then it reconnects silently — the rep in the
field never taps anything. This is part of the custom launcher build, so it ships when Railway is back.

**TRACKING ON, 22 Oct 2026 08:30:29 Cairo (owner: "turn location tracking on for the rep tablets"; via the fork, GPS + network, always on, rep can never turn it off):** config 3 `requestUpdates` DONOTTRACK → **`GPS`** — the admin ENUM (Headwind `RequestUpdatesType`: DONOTTRACK(null) / GPS("gps") / WIFI("network")); the tablet receives "gps", and the agent then requests NETWORK always plus GPS every 60 s, falling back to network with no GPS signal. Never PUT lowercase "gps" — it is not an enum value. Only that field changed (11 active links, polling, six restrictions re-read intact); pre-image in the audit scratchpad. "Never off" = `no_config_location` + 6.41/6.42 `forceLocationOn`. Phoenix reads the check-in `info.location` + deviceinfo dynamic `gpsLat`; the devicelocations plugin is NOT on the box (404). See [[a-launcher-self-update-leaves-the-agent-dead-until-a-reboot]], [[rep-tablet-never-shows-tracking-golden-rule]].
