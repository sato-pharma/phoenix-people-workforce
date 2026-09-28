---
name: new-hire-medical-reps-get-company-tablets
description: "New-hire medical reps get a company tablet the owner wants CONTROLLED, not just recorded. TWO CONSOLES EXIST: Phoenix's own Android Management API enterprise (enterprises/LC017auv4o, project phoenix-hr-2026) is LIVE but has a ZERO device quota - Google refuses quota for in-house-only use, so no quota form, no DUNS, and /devices/tablets + /devices/managed-play always read '0 tablets'. The FLEET IS CONTROLLED FROM MANAGEENGINE MDM Plus Cloud (free up to 25 devices): login mdm.manageengine.com -> Sign in with Google -> it.satopharma@gmail.com (Super Admin, User ID 939781760); hr@satopharma.com is a SEPARATE account with NO MDM, do not chase it. Managed Google Play in ME is bound to hr@satopharma.com. First tablet enrolled = Lenovo Tab M10 3rd Gen (TB328XU, IMEI 865569071549107, serial HA251XLS), Fully managed, Chrome silent-installed, in Phoenix Device Custody as PHX-TAB-0002 (PHX-TAB-0001 is a TCL TAB 10, in stock). Phoenix's role is Device Custody ONLY (/hr/devices, permission company_devices) - copy IMEI+serial from ME into it; Action1 is Windows/macOS only and never reaches Android. Never re-run the Phoenix AMAPI signup (a 2nd enterprise = a 2nd fleet); never propose a self-built DPC (Play Protect's 2025 allowlist blocks it); the US$25 Play Console fee and DUNS are unnecessary on the iframe route. Owner chose managed Play over sideloading - settled. Console runs in the Chrome he picks via switch_browser ('o')."
metadata: 
  node_type: memory
  type: project
  originSessionId: 550d992f-bbc7-4a1b-98e6-6861df800cf0
  modified: 2026-09-25T22:41:32.538Z
---

Newly hired medical reps are issued a company **tablet** the owner wants **controlled** from a
console, not merely recorded. This is the settled state as of 2026-09-23.

## Two consoles exist — only ManageEngine holds a tablet

- **Phoenix's own Android Management API enterprise** (`enterprises/LC017auv4o`, project
  `phoenix-hr-2026`, bound 2026-09-18) is LIVE — its pages `/devices/tablets` and
  `/devices/managed-play` (both **Super Admin only**, `company_devices:approve`) render the rules,
  catalog and QR/USB enrollment. **But it has a ZERO device quota:** Google's Permissible-Usage
  policy grants AMAPI quota only to EMMs/OEMs selling outward and **refuses in-house-only use**,
  which is exactly Phoenix. So no quota will ever come — **never tell him to file the quota form,
  he needs no DUNS**, and this console will never hold a device. Those pages always read
  **"0 tablets."** A future session must not read that empty page as "nothing enrolled."
  **Never re-run the Phoenix signup — a second enterprise is a second fleet.** `LC017auv4o` sits
  idle; deleting it is irreversible and nobody asked.
- **The fleet is controlled from ManageEngine MDM Plus Cloud** (free up to 25 devices). Login:
  **mdm.manageengine.com → "Sign in with Google" → `it.satopharma@gmail.com`** (a Gmail, via Zoho
  "Sign in with Google"; profile: Omar Gawish · Super Admin · User ID 939781760).
  🔴 **`hr@satopharma.com` is a SEPARATE account with NO MDM** — its doors land on "MDM Account
  Creation" as "Omar Anwar". Do not chase it for the fleet. The account was on a **trial expiring
  ~2026-10-17** — confirm it landed on the free-up-to-25 tier rather than lapsing.
  Managed Google Play *inside* ManageEngine is bound to **hr@satopharma.com** (domain "Sato Pharma").
  The console runs in the Chrome the owner picks via `switch_browser` (he chose **"o"**).

## What is configured in ManageEngine (all read back live)

- Profile **"Rep tablet rules"** (v2): passcode low/pattern; **Restore Factory Settings = Restrict**,
  **Developer Mode = Restrict** (closes the FRP-bypass on Android 12); Play Protect on; approved apps
  only; no personal Play; **location always on; camera allowed** (invoice capture hands off to the
  built-in camera). **EFRP published**: recovery account `it.satopharma@gmail.com` + 21-digit Google
  Account (Gaia) id **107849983349318614848** (read from People API, not typed — a wrong pair bricks a
  hard-reset device). To change it: Device Mgmt → Profiles → Rep tablet rules → EFRP (view shows only
  the email; the id is entered on Modify).
- OS update policy **"Rep tablets night updates"** — daily 02:00–05:00, notifications off.
- Static group **"Rep tablets"** carrying both; QR template **"Rep tablets"** auto-assigns to that
  group and **keeps built-in system apps** (`PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED`, so the
  camera survives). **Geo-Tracking ON** (Inventory → Geo-Tracking → Always Track, All devices).
- **First tablet enrolled** (`it.satopharma_TB328XU`): **Lenovo Tab M10 3rd Gen**, model TB328XU,
  IMEI **865569071549107**, serial **HA251XLS**, **Fully managed** (reset-from-Settings blocked),
  Chrome silent-installed. Per-device Actions include Remote Lock, Locate, Enable Lost Mode,
  Clear/Reset Passcode, and **Deprovision (Wipe)**.

## Phoenix's role is Device Custody only

`/hr/devices` — "Device Custody" (permission `company_devices`, tables `company_devices` +
`device_assignments`). `"tablet"` is a first-class `DeviceCategory` with `imei`/`sim_number`/
`line_number` and an Arabic handover receipt; headline flag `isHeldByLeaver`. **Copy each tablet's
IMEI and serial from ManageEngine's inventory into this register.** The enrolled Lenovo is registered
here as **PHX-TAB-0002**; the TCL TAB 10 is **PHX-TAB-0001** (in stock). 🔴 **Never answer a
tablet-control question from this register — it records custody, it controls nothing**, and
`src/lib/devices/action1.ts` is a **Windows/macOS RMM with no Android agent**. Do not send him to
"Make the QR code" on the Phoenix page.

## Cost cap and the routes not to re-propose

Owner cap: ~$25/yr with full control. **ManageEngine Free is $0 up to 25 tablets** and covers the
whole rule set with nothing to host — so it stays the start. **Tablet 26 is his decision:** pay
ManageEngine (Standard **$645/yr per 50**, his click on their store — never a chat "yes") or move to
**Fleet Free** (open source; wipe each tablet remotely, rep re-scans a new QR, ~20 min each). Every
other MDM checked (Headwind, AirDroid, TinyMDM, Scalefusion, Hexnode, Miradore) costs more for the
rule set.

- 🔴 **Never propose a self-built DPC** — Play Protect's 2025 allowlist blocks any non-listed DPC at
  enrollment ("App blocked to protect your device"); appeals run months. Only adb per-cable slips past.
- 🔴 **Owner chose managed Play over sideloading — settled, do not re-open or re-propose sideloading.**
  The honest case against sideloading was the unknown-sources hole (`untrustedAppsPolicy` allowing
  untrusted installs opens *every* app), never the update burden.
- 🔴 **The US$25 Play Console fee and a DUNS number are UNNECESSARY on the iframe route** — Managed
  Google Play auto-creates a Play Developer account and waives the $25 when publishing a private app
  through the EMM iframe. Those belong only to a standalone Play Console account (a public listing or
  the Custom App Publishing API), which Phoenix does not need.

A native APK **does** exist (package `com.satopharma.phoenixworkforce`, Expo/React Native under
`mobile/`, built with EAS, in a separate session); the Next.js web app itself has no APK. Continuous
GPS can only live in that native app — AMAPI gives location from Lost Mode alone.

**Why this memory exists:** the device register looks like device management from its name, so a
session can wrongly answer "Phoenix already does this." It does not — the fleet is ManageEngine. The
owner is [[b-10-is-the-owner-himself]].
