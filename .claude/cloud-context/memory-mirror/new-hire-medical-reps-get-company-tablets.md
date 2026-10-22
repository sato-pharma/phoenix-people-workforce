---
name: new-hire-medical-reps-get-company-tablets
description: "New-hire medical reps get a company tablet the owner wants CONTROLLED, not just recorded. The fleet is controlled from the company's self-hosted Headwind MDM (mdm.satopharma.com, configuration id=3 'Rep tablets'); the Lenovo TB328XU is enrolled there as PHX-TAB-0002, device owner, no Google account. The 2026-09-23 ManageEngine setup is superseded. Phoenix's AMAPI enterprise LC017auv4o holds ZERO devices — never re-run its signup; the managed Play upload was DROPPED 2026-09-28. Phoenix's own register is Device Custody (/hr/devices). Never propose a self-built DPC."
metadata: 
  node_type: memory
  type: project
  originSessionId: 550d992f-bbc7-4a1b-98e6-6861df800cf0
  modified: 2026-10-22T05:23:01.816Z
---

Newly hired medical reps are issued a company **tablet** the owner wants **controlled** from a
console, not merely recorded. The text below was the settled state as of 2026-09-23; the console has
since moved to Headwind — read the current state first.

## Current state — the fleet is on Headwind MDM

- **The rep fleet is controlled from the company's own self-hosted Headwind MDM**
  (`mdm.satopharma.com`), configuration **`id=3` "Rep tablets"**. The Lenovo Tab M10 TB328XU is
  enrolled there as device id **`PHX-TAB-0002`** — device owner, **no Google account by design**
  ("never sign into Google first" at enrolment), normal Lenovo home via `runDefaultLauncher=true`.
  How enrolment, custody and the never-shows-tracking golden rule work:
  [[rep-tablet-never-shows-tracking-golden-rule]]; the custom launcher:
  [[headwind-rep-tablet-custom-launcher-build-required]].
- **Managed Google Play is DROPPED as a delivery route** (owner, 2026-09-28: *"drop the managed play
  upload since it cannot reach the fleet"*) — Headwind installs an APK it hosts and links to
  configuration 3 ([[managed-play-cannot-reach-the-rep-tablets]]).
- Phoenix talks to Headwind through `src/lib/devices/headwind/` (custody and assignment server writes
  go through that bridge); the ManageEngine sections below are the 2026-09-23/25 setup, kept as
  history — do not treat ManageEngine as the fleet console.
**Superseded 2026-10-02:** previously "the fleet is controlled from ManageEngine MDM Plus Cloud and PHX-TAB-0002 is enrolled there" — the later Headwind notes (golden rule 2026-09-26, launcher build 2026-09-27/28, `rep-tablet-never-shows-tracking-golden-rule`, `managed-play-cannot-reach-the-rep-tablets`).

## Two consoles existed on 2026-09-23 — then only ManageEngine held a tablet

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
- **On 2026-09-23 the fleet was controlled from ManageEngine MDM Plus Cloud** (free up to 25 devices) —
  superseded by Headwind, see above. Login:
  **mdm.manageengine.com → "Sign in with Google" → `it.satopharma@gmail.com`** (a Gmail, via Zoho
  "Sign in with Google"; profile: Omar Gawish · Super Admin · User ID 939781760).
  🔴 **`hr@satopharma.com` is a SEPARATE account with NO MDM** — its doors land on "MDM Account
  Creation" as "Omar Anwar". Do not chase it for the fleet. The account was on a **trial expiring
  ~2026-10-17** — confirm it landed on the free-up-to-25 tier rather than lapsing.
  Managed Google Play *inside* ManageEngine is bound to **hr@satopharma.com** (domain "Sato Pharma").
  The console runs in the Chrome the owner picks via `switch_browser` (he chose **"o"**).

## What was configured in ManageEngine (read back live 2026-09-23/25 — history, not the live fleet)

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
  Clear/Reset Passcode, and **Deprovision (Wipe)**. **That same tablet (`PHX-TAB-0002`) is now
  enrolled in Headwind configuration 3**, not ManageEngine.
  **Superseded 2026-10-02:** previously "first tablet enrolled in ManageEngine" as the live state — its Headwind enrolment (`rep-tablet-never-shows-tracking-golden-rule`, `managed-play-cannot-reach-the-rep-tablets`).

## Phoenix's role is Device Custody only

`/hr/devices` — "Device Custody" (permission `company_devices`, tables `company_devices` +
`device_assignments`). `"tablet"` is a first-class `DeviceCategory` with `imei`/`sim_number`/
`line_number` and an Arabic handover receipt; headline flag `isHeldByLeaver`. **Each tablet's IMEI
and serial belong in this register** (on 2026-09-23 they were copied from ManageEngine's inventory;
the fleet is now Headwind's, and the register syncs through `src/lib/devices/headwind/`). The enrolled Lenovo is registered
here as **PHX-TAB-0002**; the TCL TAB 10 is **PHX-TAB-0001** (in stock). 🔴 **Never answer a
tablet-control question from this register — it records custody, it controls nothing**, and
`src/lib/devices/action1.ts` is a **Windows/macOS RMM with no Android agent**. Do not send him to
"Make the QR code" on the Phoenix page.

## Cost cap and the routes not to re-propose

Owner cap: ~$25/yr with full control. **Today the fleet runs on the free, open-source Headwind MDM,
self-hosted**, and the owner chose a free custom launcher build over Headwind Premium ($2,990
one-time, ≤300 devices) — do not re-pitch Premium unless he raises it
([[headwind-rep-tablet-custom-launcher-build-required]]). The 2026-09-23 comparison, kept as history:
ManageEngine Free was $0 up to 25 tablets; tablet 26 would have meant ManageEngine Standard
($645/yr per 50) or Fleet Free; AirDroid, TinyMDM, Scalefusion, Hexnode and Miradore all cost more
for the rule set.
**Superseded 2026-10-02:** previously "ManageEngine Free stays the start; every other MDM checked (Headwind …) costs more" — the move to self-hosted Headwind with the free custom launcher (`headwind-rep-tablet-custom-launcher-build-required`, `rep-tablet-never-shows-tracking-golden-rule`).

- 🔴 **Free-MDM bake-off CLOSED 2026-10-22 — Headwind kept, AirDroid + ManageEngine + LocalDroid all
  REJECTED; never re-pitch them.** On 0008 Headwind was shown to give control AND the live screen
  (RustDesk, free) in one place. AirDroid is a 14-day trial then paid; ManageEngine free omits the
  screen (paid) and shows the managed notices (no custom launcher, breaks the golden rule) — its only
  extras are BYOD work-profile / conditional-email, useless on a company-owned tablet; LocalDroid is
  unverified self-hosted with no published feature list. The owner trialled none — he kept Headwind
  on 0008 by decision. Headwind + the custom launcher ([[phoenix-launcher-6-41-built-completes-location-and-unattended-rustdesk]])
  is the whole fleet answer.
- 🔴 **Never propose a self-built DPC** — Play Protect's 2025 allowlist blocks any non-listed DPC at
  enrollment ("App blocked to protect your device"); appeals run months. Only adb per-cable slips past.
- 🔴 **Managed Google Play is NOT how apps reach the rep tablets — owner decision 2026-09-28 dropped
  the managed Play upload** because the enterprise has zero enrolled devices and the tablets are
  Headwind-enrolled; Headwind installs an APK it hosts and links to configuration 3
  ([[managed-play-cannot-reach-the-rep-tablets]]). Never re-propose the Play upload as the route to
  the fleet. (The 2026-09-23 case against sideloading on the AMAPI route was the unknown-sources hole —
  `untrustedAppsPolicy` allowing untrusted installs opens *every* app — never the update burden.)
  **Superseded 2026-10-02:** previously "owner chose managed Play over sideloading — settled" — the owner's 2026-09-28 decision to drop the managed Play upload (`managed-play-cannot-reach-the-rep-tablets`).
- 🔴 **The US$25 Play Console fee and a DUNS number are UNNECESSARY on the iframe route** — Managed
  Google Play auto-creates a Play Developer account and waives the $25 when publishing a private app
  through the EMM iframe. Those belong only to a standalone Play Console account (a public listing or
  the Custom App Publishing API), which Phoenix does not need.

A native APK **does** exist (package `com.satopharma.phoenixworkforce`, Expo/React Native under
`mobile/`, built with EAS, in a separate session); the Next.js web app itself has no APK. Continuous
GPS can only live in that native app — AMAPI gives location from Lost Mode alone.

**Why this memory exists:** the device register looks like device management from its name, so a
session can wrongly answer "Phoenix already does this." It does not — the fleet is Headwind MDM
(it was ManageEngine until the Headwind move; superseded 2026-10-02). The
owner is [[b-10-is-the-owner-himself]].
