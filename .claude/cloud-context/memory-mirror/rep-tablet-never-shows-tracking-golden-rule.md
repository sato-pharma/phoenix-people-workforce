---
name: rep-tablet-never-shows-tracking-golden-rule
description: "GOLDEN RULE — a Headwind rep tablet NEVER shows its user any sign it is tracked, screen-viewable or managed; owner wants the NORMAL Lenovo home (rejected the managed home + Sato wallpaper 2026-09-27); how enrollment/custody works; the custom-launcher build that hides Android's forced tracking notices"
metadata:
  node_type: memory
  type: project
  originSessionId: 4cbbb08b-a3eb-4d7b-bfc9-1db48f147979
  modified: 2026-09-26T21:29:35.619Z
---

🔴 **GOLDEN RULE (owner, 2026-09-26, "never ever, golden golden rule"): a rep tablet NEVER shows the
person holding it any indication that it is tracked, that its location is read, that its screen can be
viewed, or that it is managed by the company.** No "location in use", no "screen is being recorded",
no "managed by your organization" notice — nothing, ever. This extends the existing principle that
mock-location detection is silent ([[mock-location-detection-is-silent-a-spoofed-capture-still-saves]]
if present) and the owner's standing "close this hole without reps knowing" to the tablet's own UI.

🔴 **THE STOCK HOME BREAKS `blockStatusBar` — resolved plan is the CUSTOM BUILD** (owner, 2026-09-27):
the owner wants the **normal Lenovo home**, and `blockStatusBar` ONLY works on Headwind's own managed
home (its overlay), NOT on the stock Lenovo launcher. So on the normal home the status bar is visible and
Android FORCES "Privacy reminder — your IT admin may see your data" and "Location can be accessed"
notices onto it — its own anti-stalkerware disclosures that **no MDM setting or server toggle removes**.
The fix the owner approved is the custom launcher that disables the real bar and draws a clean one
(clock/battery/wifi kept, notices gone): [[headwind-rep-tablet-custom-launcher-build-required]].

**How it is honoured, on Headwind configuration `id=3` "Rep tablets":**
- `blockStatusBar = true` — set, but see the 🔴 above: it only covers the managed home, not the stock
  Lenovo home the owner chose, so it does NOT hide Android's notices there. The custom build's overlay bar
  is what actually honours the golden rule on the normal home.
- Location polling is periodic, so there is no persistent location notification.
- 🔴 **The one residual on STOCK Android that NO app (even device owner) can remove without root or a
  system-signed build: the OS privacy indicator** (the momentary green/orange dot top-right during an
  active location poll, and the screen-cast indicator during an ACTIVE remote-view session). With the
  status bar blocked it is largely covered, but on some OEMs it can flash. If the owner needs it truly
  zero, that requires an OEM/rooted suppression — told to him honestly, not promised away.

🔴 **WALLPAPER / MANAGED HOME — REJECTED (owner, 2026-09-27).** The Sato-logo wallpaper
(`backgroundImageUrl`) is a MANAGED-home feature; the owner saw the managed home and called it "poor
cheap version… looks HACKED", and wants the plain Lenovo home with its OWN normal wallpaper. Do NOT set
the Sato wallpaper or the managed home. The launcher only paints `backgroundImageUrl` into its own
in-app ImageView (`picasso.load(...).into(binding.activityMainBackground)`), never the system wallpaper.

**Enrollment (fixed 2026-09-26/27):** the QR only generates when config 3 has a **main app** set —
`mainAppId` is an FK to `applicationversions.id` (the launcher's VERSION id `10045`, NOT the app id 46),
and the launcher must be linked as an installed app. 🔴 **To get the NORMAL Lenovo home, config 3 MUST
have `runDefaultLauncher=true` BEFORE enrollment** — `InitialSetupActivity` seizes Home as device-owner
launcher only when runDefaultLauncher is null/false; with it true, Headwind does NOT grab Home. Then at
the Android **"Select home app"** prompt pick **Quickstep** (the stock launcher), not "MDM Agent". Result:
`defaultLauncher=false`, normal Lenovo home, Headwind managing in the background. Flow: factory-reset
(hardware recovery = Power+VolUp if Settings is blocked; on the Lenovo Tab M10 TB328XU it is NOT blocked)
→ tap 6–7× on the welcome screen → connect Wi-Fi → scan → enter device id **exactly** `PHX-TAB-0002`
→ pick Quickstep. Never sign into Google first.

**Custody / assignment (owner wants, 2026-09-26, being built):** assign a tablet to an employee,
INCLUDING one not yet hired (pre-provision, hand over on day one), with revoke and reassign to a
different person. Built on the existing device-custody register. See [[the-house-document-identity-standard]]
for brand assets. Server writes go through the Headwind bridge in `src/lib/devices/headwind/`.
