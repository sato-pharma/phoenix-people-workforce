---
name: new-hire-medical-reps-get-company-tablets
description: "SUPERSEDED 2026-09-18 (afternoon, Cairo): Phoenix's own Android Management API route is DEAD (zero device quota, and Google's permissible-usage policy refuses in-house-only use, so no quota form, no DUNS) - the owner chose ManageEngine MDM Plus Cloud (free up to 25 devices), with Managed Google Play bound to the SAME work account as Phoenix's enterprise (Google allows several EMM bindings per managed Google domain). Phoenix keeps only Device Custody. Managed Google Play bound to hr@satopharma.com the same day; by that night the profile 'Rep tablet rules', a 2-5 AM update policy, group 'Rep tablets' and QR template 'Rep tablets' (auto-assigned into that group; keeps built-in apps, VERIFIED) were live, Chrome's Play approval waiting on his window; he then called the paid plan too expensive - ManageEngine is still the cheapest (free to 25 tablets after the trial, then Standard yearly $645 per 50; every alternative checked costs more), price table inside. He then capped it at $25 a year with full control: a self-built DPC is BLOCKED by Play Protect's 2025 DPC allowlist, so the $0 route first recommended was Fleet Free (open source; Google's own agent via Fleet's proxy; wipe free, lock Premium) on an Oracle always-free server - then SUPERSEDED that evening: start on ManageEngine Free (the whole list, $0, up to 25 tablets); tablet 26 is his call (pay ManageEngine, or move to Fleet by wiping and re-scanning each tablet). History below: newly hired medical reps get company tablets (Lenovo Tab M11) the owner wanted CONTROLLED from Phoenix via Android Management API - the device register only records custody. Holds the verified force-install, sideload, untrustedAppsPolicy and Play-Console-fee facts, which of the three routes costs what, and where production stands (credential live 2026-09-18; bound to enterprises/LC017auv4o the same day - never re-run the signup; the store page crashed on a React bug until PR #4004, and opens since). Enrollment QR codes + the one rep-tablet policy are PR #4018 (/devices/tablets) - the QR must keep built-in apps (camera), the code never reaches the audit row, and pushing the policy is HIS first click."
metadata: 
  node_type: memory
  type: project
  originSessionId: 550d992f-bbc7-4a1b-98e6-6861df800cf0
  modified: 2026-09-23T20:44:05.899Z
---

🔴 **THE ROUTE CHANGED ON 2026-09-18 AFTERNOON — READ THIS BEFORE ANYTHING BELOW.** The first tablet,
PHX-TAB-0001 (a **TCL TAB 10 LTE Gen 2**, not a Lenovo), stopped mid-QR with *"Can't set up device…
Since your organization reached its usage limits"*: a new Cloud project gets an Android Management API
device quota of **0**. Raising it goes through Google's quota form, but Google's Permissible Usage
policy (updated 2026-03-30) grants quota only to EMMs selling to outside customers, device-trust
providers and OEMs, and refuses solutions "used exclusively for first party in-house" purposes. That
is exactly Phoenix, so **no quota will come. Never tell him to file that form, and he needs no DUNS.**
Google sells no paid tier for this either.

**He chose ManageEngine Mobile Device Manager Plus Cloud** (free up to 25 devices after a 30-day
unlimited trial; the 26th needs a paid plan, which is his decision on ManageEngine's store and never
a chat "yes"). The split of work: the account sign-up (terms, phone code), the Managed Google Play
sign-in and its agreement are HIS; the QR template and the rules profile are configured by Claude in
the Chrome browser he picks through switch_browser (he chose "o") once he is signed in, after his explicit OK to publish. **Bind Managed Google Play to the
SAME work account he used for `LC017auv4o`** — Google allows several EMM bindings on one managed
Google domain, and discourages a personal Gmail. 🔴 **He did not remember which account that was, and
Google will not say:** `enterprises.get` on `LC017auv4o` returns `MANAGED_GOOGLE_DOMAIN` / `TYPE_TEAM`
with NO `contactInfo`, so the admin email cannot be read from the API. The only `satopharma.com`
Google account signed in to his Chrome on 2026-09-18 was **hr@satopharma.com** (display name "Omar
Gawish"; the rest are Gmail accounts, and a Gmail sign-up would have produced a managed Google Play
Accounts enterprise instead). 🔴 **CORRECTED 2026-09-23 against the live console: the ManageEngine
login is `it.satopharma@gmail.com` (a Gmail), signed in via the Zoho "Sign in with Google" button —
NOT `it.assets@satopharma.com`, which does not exist as a Zoho or Google account anywhere.** The
profile dropdown reads: Omar Gawish · Super Admin Email `it.satopharma@gmail.com` · User ID
939781760. `hr@satopharma.com` is a SEPARATE account that has NO MDM at all (both its Zoho-password
and its Google door land on the "MDM Account Creation" page as "Omar Anwar"); do not chase it for the
fleet. To reach the fleet: mdm.manageengine.com → "Sign in with Google" → pick `it.satopharma@gmail.com`.
🔴 **The account is on a TRIAL — on 2026-09-23 the console banner read "Your Trial expires in 24
days" (~2026-10-17), so the "free after 30-day trial" downgrade had NOT yet happened; watch that it
lands on the free-up-to-25 tier rather than lapsing.** The rules profile mirrors `rep-tablet`, and the
built-in camera app must stay enabled, because invoice capture hands off to it.

🔴 **UPDATE 2026-09-23 night — THE FIRST TABLET IS ACTUALLY ENROLLED AND UNDER CONTROL, in
ManageEngine.** Device **it.satopharma_TB328XU** = a **Lenovo Tab M10 (3rd Gen)**, model TB328XU,
IMEI **865569071549107**, serial **HA251XLS**, UDID ba6e95686dc422e1, SIM Vodafone, Android 12.
ManageEngine reports **Management Type: Fully managed** (Device Owner — reset-from-Settings blocked),
"Rep tablet rules" profile applied. **Google Chrome distributed to the "Rep tablets" group with
SILENT install and confirmed Installed on the device** (the unfinished 2026-09-18 Chrome step is DONE),
so the Phoenix web-app icon opens. Registered in Phoenix Device Custody as **PHX-TAB-0002** (in stock,
no holder yet, no estimated value — same as PHX-TAB-0001 the TCL). 🔴 **Geo-Tracking is now ON:
Inventory → Geo-Tracking → Always Track, All devices** (configured by Omar Gawish 22:47 Cairo);
verified working — the tablet pinned to 6 Kamal Hassan Ali St, Heliopolis, Cairo (30.10°N 31.37°E).
"Locate device" un-greys once tracking is on. Full per-device control set (Inventory → Devices → the
tablet → **Actions**): Scan Now, Remote Lock, Remote Alarm, Remote Control/View, Clear/Reset Passcode,
Locate device, Enable Lost Mode, Restart, Request Bug Report, Clear App Data, **Deprovision (Wipe)**.
🔴 **Enterprise Factory Reset Protection is now CONFIGURED and PUBLISHED (2026-09-23, by Omar Gawish
via it.satopharma@gmail.com console).** EFRP payload on the "Rep tablet rules" profile (v2) holds
recovery account **it.satopharma@gmail.com** + 21-digit Google Account ID **107849983349318614848**
(obtained from People API `people.get people/me personFields=metadata` while signed into that account —
NOT a password, just the account's Gaia id). ME warns it does NOT validate the pair; a wrong pair
bricks a hard-reset device, so the id was read from the authoritative source, not typed from memory.
Restrictions already enforce **Restore Factory Settings = Restrict** and **Developer Mode = Restrict**
(the latter disables OEM unlocking, closing the FRP-bypass path on Android 12). Profile published v2 and
"Profile upgrade has been initiated" to the 1 enrolled tablet. EFRP is applied at enrollment, so it also
governs any future factory reset. To re-check or change it: Device Mgmt → Profiles → Rep tablet rules →
EFRP; the view screen shows only the email, the id is entered on Modify.
🔴 **TWO CONSOLES EXIST AND ONLY ManageEngine HOLDS THIS TABLET.** Phoenix's own `/devices/tablets`
and `/devices/managed-play` are LIVE and bound to Sato's own Google enterprise (rules "in force on
Google", app catalog, QR/USB enrollment) — but read **"0 tablets on Google's list"** because that
enterprise has the zero device quota (the whole reason for ManageEngine). So control THIS tablet from
ManageEngine, NOT the Phoenix page; a future session must not read the empty Phoenix page as "nothing
enrolled." The ManageEngine console runs in the Chrome the owner picks via `switch_browser` (he chose
"o", then a re-pick named "o" on 2026-09-23 when a 2nd Chrome connected).

**Where ManageEngine stood on the night of 2026-09-18 (Cairo):** Managed Google Play is bound to
**hr@satopharma.com** (domain name "Sato Pharma", non-Workspace account, first sync 4:43 PM). Configured
by Claude in the "o" browser, each read back:

- Profile **"Rep tablet rules"**, published v1 — passcode low complexity or pattern; factory reset and
  developer mode restricted; Play Protect always on; only approved apps; no personal Play accounts, no
  non-market apps; location always on; camera allowed; OS upgrade allowed.
- OS update policy **"Rep tablets night updates"** — every day 02:00–05:00, notifications off.
- Static group **"Rep tablets"** carrying both. The QR template **"Rep tablets"** now assigns
  automatically to ManageEngine's only user, **it.satopharma@gmail.com** (Zoho Directory), and to that
  group, full device management — so the rules land the moment setup ends. Who holds a tablet stays in
  Phoenix's custody register. "Add New User" was avoided: it may create a Zoho Directory account.
- 🔴 **The camera question is SETTLED:** the template API's Android 9+ QR (`adv_qr_data`) carries
  `PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED true` (read by key name only — the QR is a credential).
- **Not done:** Chrome's approval in Managed Google Play (a cross-origin play.google.com frame that
  cannot be driven while the "o" window is hidden — his to bring forward), then Chrome to the group with
  camera + location granted. Chrome is preinstalled on the TCL and stays enabled meanwhile. No EFRP
  account, matching Phoenix's baseline. No tablet enrolled at writing.
- UI traps: a zselect takes mouse events on `.zselectbox` then `LI.zdropdownlist__item` (form_input on
  the hidden select reverts); a ztimefield takes its hidden `*_zdate` input plus input/change events;
  the ME API answers 406 without `?SUBREQUEST=XMLHTTP&service=mdm`; a profile is associated from the
  GROUP (Actions → hover "Associate Profile"); javascript_tool output holding `=`/`;` pairs is blocked
  as cookie data, and an async result is not awaited — park it on `window` and read it next call.

🔴 **"Too expensive" (his words, same evening) — he had opened the store page on Professional +
Monthly ($119 a month for 50 devices = $2.38 per device), its default and dearest setting.** Official
list prices read that day: the **free edition is automatic when the 30-day trial ends (about 18
October), up to 25 devices, all features, no time limit, and enrolled tablets stay managed.** Cloud
Standard is **$645 a year** (or $64 a month) per 50 devices; Professional $1,195 a year (or $119 a
month). Standard keeps full device management, company-owned, QR enrollment, restrictions, managed
Google Play, kiosk, remote lock/wipe, lost mode and geo-tracking; it lacks automated OS-update policies
(the 2–5 AM window), remote view/control, location history and geofencing (raw matrix re-read
2026-09-18 — its columns run Standard | Professional | Free, and a WebFetch summary misread them twice,
so read the HTML). Every alternative costs more for 45 tablets a year: Headwind MDM Cloud $855, AirDroid
Business Standard $945 (its $12 Basic has no screen-lock, factory-reset or Android Enterprise
control; on Standard the rules pack — reset block, app allow-list, updates — is an $8/tablet add-on and
location $5, so about $1,530), TinyMDM €954 (fully managed mode has prevent-factory-reset, remote lock,
update DELAY), Scalefusion Essential $1,080 (OS updates only from Business, $60 a tablet = $2,700),
Hexnode Pro about $1,188 (OS updates and remote view only from Enterprise, $3.2 = $1,728). Headwind Community is free but
self-hosted (a 4 GB Linux server someone must run). **So ManageEngine stays: free to tablet 25, then
Standard yearly — and that purchase is his click on ManageEngine's store, never a chat "yes".**

🔴 **He then capped it: "maximum twenty five dollars per year… with full control… even if we build one
for ourselves" (voice, same night).** Researched and read as $25 a year for the WHOLE fleet (if he meant
per tablet, ManageEngine Professional yearly is $23.90 a tablet). Findings, 2026-09-18:

- 🔴 **A self-built device-control app (custom DPC) is BLOCKED by Google since 2025.** Play Protect lets
  only DPCs on Android Enterprise's allowlist install during enrollment — the tablet shows "App blocked
  to protect your device" and setup cannot proceed. Approval is an appeal with no SLA; community threads
  report months and repeated refusals, and Headwind MDM's own builds were blocked in December 2025. Only
  adb (`dpm set-device-owner`, a PC cable per tablet) may slip past it, and fragilely. **Never propose
  building our own DPC.** The Play EMM API is also closed to new custom DPCs, so no managed Play either.
- **Fleet (fleetdm, open source) Free is $0 per host with no host limit.** Its Android side runs on
  Google's own Android Device Policy through Fleet's fleetdm.com proxy — Fleet's Google quota, so
  Phoenix's zero quota does not matter — bound with any work email. Fully managed + QR enrollment; its
  profiles ARE Android Management API policy JSON, so the `rep-tablet` baseline drops in; managed Google
  Play apps including a private APK. 🔴 **Wipe of a company-owned tablet is Free since 4.87 (June 2026);
  lock and clear-passcode are Premium ($7 a host a month);** "enforce OS updates" is not in Free (a raw
  `systemUpdate` field inside a profile is untested). Needs MySQL 8.0.44+, Redis and a public HTTPS URL
  (Google's Pub/Sub reaches the server). A Railway one-click template exists.
- Hosting: an **Oracle Cloud Always Free** server is $0 (A1 halved to 2 OCPU / 12 GB from 2026-08-18;
  idle ones are reclaimed when CPU, network AND memory all sit under 20% for 7 days — size the VM so
  memory stays above 20%, or move the account to pay-as-you-go). Railway bills about $10 per GB of RAM a
  month, so Fleet + MySQL + Redis there is roughly $4–6 a month (an estimate) — over his cap.
- **Miradore Free still exists (≤50 devices)** but its raw plan table (a muted tick = NOT included)
  gives Free only lock, wipe, clear passcode, a passcode policy, encryption and update STATUS. Device
  restrictions (so no reset block), app allow/block, app deployment, managed Play, kiosk, location and
  update scheduling are Premium ($2.75 a device a month yearly = $1,485 for 45); remote view is Premium+
  ($3.95). Not full control. Headwind Community needs its own agent (hit by
  the same Play Protect block) and a 4 GB server.
- **"Full control" was defined to him (same night) as the `rep-tablet` rules plus remote lock, wipe,
  map and screen view**, with FRP as the only answer to a hardware-button reset (AMAPI `frpAdminEmails`;
  ManageEngine calls it Enterprise Factory Reset Protection). Fleet has no map and no screen view; FRP
  and the update window through a Fleet profile are untested.
- **First recommended: Fleet Free on an Oracle always-free server.** His steps: open the Oracle account
  (it asks for a card to verify; the always-free server is not charged) and the Google binding sign-in.
- 🔴 **Superseded the same evening, after he asked "is ManageEngine the best and $0 until 25 devices?":
  START ON MANAGEENGINE FREE.** It covers the whole list for $0 with nothing to host. Tablet 26 is his
  decision: pay ManageEngine (Standard $645 / Professional $1,195 a year, his click on their store),
  or move to Fleet Free (wipe each tablet remotely, then the rep scans a new QR; my estimate is about
  20 minutes each, with no office visit). Fleet stays the fallback, not the start.

**What still works in Phoenix is Device Custody only** (handover, receipt, serial, typed IMEI). The
Rep Tablets QR, the IMEI auto-copy (#4025) and the `rep-tablet` policy all read Phoenix's own
enterprise, which will never hold a device. **Do not send him to "Make the QR code"**. Copy each
tablet's IMEI and serial from ManageEngine's inventory into the custody register. `LC017auv4o` sits
idle; deleting it is irreversible and nobody has asked for that.

Newly hired medical reps are issued a company **tablet**. The model in hand on 2026-09-18 is a
**Lenovo Tab M11** (MediaTek SoC, Android). The owner wants these tablets **controlled** from
Phoenix — not merely recorded.

Phoenix already holds the recording half and **none** of the control half:

- `/hr/devices` — "Device Custody" (permission `company_devices`). Tables `company_devices` +
  `device_assignments`, migration `20260907220000`. `"tablet"` is a first-class `DeviceCategory`,
  with `imei`, `sim_number` and `line_number` columns, and an Arabic custody receipt (البند clauses)
  signed at handover. Its headline flag is `isHeldByLeaver`.
- `src/lib/devices/action1.ts` pulls an Action1 fleet in as `in_stock` and **never** opens a custody
  record, by design. **Action1 is a Windows/macOS RMM with no Android agent — it will never reach
  these tablets.** `ACTION1_CLIENT_ID` / `ACTION1_CLIENT_SECRET` are set in `.env.local`.
- Production `public.company_devices` held exactly **one row** on 2026-09-18 — one laptop, assigned,
  zero tablets. The register is built but effectively unused.

Controlling an Android tablet means **Android Enterprise**. Owner decided 2026-09-18: **Phoenix
itself is the console**, via Google's **Android Management API**, covering all four of lock/wipe/
locate, forced work apps, kiosk, and reporting back into Phoenix. Fleet is **20–50 tablets, some
already issued and some still in stock**.

🔴 **THE OWNER CHOSE THE MANAGED-GOOGLE-PLAY ROUTE on 2026-09-18**, in his own words, after being shown
the three routes and the trade-offs — and he accepted a fee to get it. Zero cost had been his opening
constraint and he lifted it himself once the cost of "free" was made concrete (opening unknown sources
device-wide, and no way to recall a bad **binary** on a fleet with no store behind it — read that second
reason with the OTA caveat below, which narrows it). 🔴 **The fee then turned out not to apply to this
route at all** (see below), so what he chose costs nothing and his original "all free" constraint is
satisfied after all. **What stands is the decision — managed Play over sideloading — not a willingness
to pay.** Do not re-open it and do not re-propose sideloading; [[b-10-is-the-owner-himself]] means no
one else needs to ratify it.

Verified against Google's own docs on 2026-09-18:

- **Commands:** `LOCK`, `RESET_PASSWORD`, `REBOOT`, `RELINQUISH_OWNERSHIP`, `CLEAR_APP_DATA`,
  `START_LOST_MODE`, `STOP_LOST_MODE`, `ADD_ESIM`, `REMOVE_ESIM`, `REQUEST_DEVICE_INFO`, `WIPE`.
- 🔴 **LOCATION COMES ONLY FROM LOST MODE — there is no continuous GPS tracking.** `START_LOST_MODE`
  locks and rings the device; after 5 minutes unrecovered it transmits location via the
  `LostModeLocationEvent` in the USAGE_LOGS Pub/Sub feed. On a **fully managed** device this works
  regardless of the user's own location setting. Do not promise always-on rep tracking from this.
- **Quotas:** initial grant up to 500 devices on business justification; 1,000 queries per 100
  seconds per project; 🔴 **a maximum of 2 Cloud projects per developer** — exactly enough for
  Phoenix staging + production, with none spare.
- Google publishes **no price** for the API on either the quickstart or the permissible-usage page;
  there is no per-device fee. Pub/Sub is the one component that wants billing enabled on the Cloud
  project, so prefer polling the device resource on the existing cron where live push is not needed.

🔴 **Enrolling a device as fully managed requires a FACTORY RESET** — it cannot be applied
retroactively to a tablet already set up in a rep's hands. Lost Mode needs fully managed Android 11+
(or company-owned work profile on 13+); the Tab M11 qualifies.

🔴 **A NATIVE APK IS NOW BEING BUILT — in a separate session, package `com.satopharma.phoenixworkforce`,
Expo/React Native under `mobile/`, built with EAS.** The older note that Phoenix is web-only is
superseded: what stays true is that the **Next.js app itself** has no APK, so the free route ships a
Google-generated **WebAPK** instead (`src/lib/devices/android-web-app.ts`, PR #3968) — Google compiles
it from the site, package `com.google.enterprise.webapp.*`, force-installed at no cost. 🔴 **A web-app
force-install policy MUST also carry `com.android.chrome`**, or the tablet installs a Phoenix icon that
opens nothing and the console still reports success.

🔴 **"Native app" and "free" are NOT in conflict — "native app force-installed via managed Google Play"
and "free" are.** Corrected 2026-09-18; the earlier flat "the fee rules it out" was wrong and reached the
owner once in that wrong form. Three routes, and the fee buys only the third:

| Route | Fee | Force-install | Auto-update | Unknown-sources hole |
| --- | --- | --- | --- | --- |
| WebAPK | none | yes | yes | none |
| Native, sideloaded | none | no — first install by hand | JS yes (EAS Update), native no | 🔴 opens device-wide |
| **Native via managed Play — CHOSEN 2026-09-18** | **none via the EMM iframe** (US$25 is the Play Console door only) | yes | yes | none |

🔴 **A fully managed device CAN accept a sideloaded APK, but REFUSES BY DEFAULT.** The live switch is
`advancedSecurityOverrides.untrustedAppsPolicy`, which Google states **applies only on fully managed
devices**: block device-wide (the default, `DISALLOW_INSTALL`, which `UNSPECIFIED` also resolves to) /
block in the work profile only / **allow untrusted installation device-wide**. `installAppsDisabled`
must stay false too. 🔴 **`installUnknownSourcesAllowed` is DEAD — the API reference says flatly "This
field has no effect"**, and it is the field every older tutorial reaches for. Allowing untrusted installs
opens unknown sources for **every** app, not just Phoenix — on a fleet whose whole point is that a rep
cannot install what they like, that one policy line undoes the kiosk argument.

🔴 **A SIDELOADED APK IS NOT "MANUAL FOREVER" — do not argue against it on update burden.** EAS Update
pushes JS, styling and images over the air to an **internal-distribution** APK, which is exactly what
`mobile/eas.json`'s `preview` profile builds (`buildType: apk`, `distribution: internal`). Since this app
is almost entirely JavaScript, most releases need no reinstall. Expo's docs reserve a new binary for
**native code or native dependencies, an app-permission change, an Expo SDK upgrade, or anything needing
a new binary version** — a few times a year, not per release. 🔴 **But EAS Update is NOT CONFIGURED**
(2026-09-18): no `expo-updates` dependency and no `channel` in `mobile/eas.json` — verified on
`origin/main`. It is available and ordinary to set up, never a feature in hand. 🔴 **Runtime versions are
the live hazard once it IS on** — publish a bundle to a binary whose native runtime does not match and
the app "may not work as expected, or it may crash".
**The honest case against sideloading was the unknown-sources hole, never the updates.**

🔴 **THE STORE'S RECALL PATH DOES NOT COVER OTA — true on EVERY route, including the chosen one.** An
EAS Update bundle is served straight to the installed app and **never passes through Google Play**, so
managed Play can withdraw a bad *binary* but can do nothing about a bad *bundle*. That is the channel
that reaches every tablet at once and changes most often, which makes the runtime-version policy MORE
important on the Play route, not less. **Do not tell the owner the fee buys a recall path full stop** —
it buys one for binaries only. Corrected 2026-09-18 after the mobile session caught the gap; the
original framing had been sold to him with the recall path unqualified.

🔴 **THE SIGNING-KEY RISK IS ROUTE-SPECIFIC — do not carry the sideload version of it onto the Play
route.** EAS holds a keystore either way, so "the key lives with EAS" is true of both; what differs is
WHICH key it is, and that inverts the consequence:

- **Direct-install / sideload:** the EAS key IS the app signing key. There is no reset path anywhere, so
  losing the Expo account is terminal for upgrades — a differently-signed APK cannot upgrade an
  installed one, and with no store behind it someone physically holds every handset to reinstall.
- **Managed Play (the CHOSEN route):** the EAS key is only the **upload** key. Google holds the real app
  signing key in its own KMS and re-signs what users receive. Google states plainly that if the upload
  key is lost or compromised **"you are not locked out of your app"** — reset it from Play Console under
  Manage Play app signing → Request upload key reset, which takes a few days. 🔴 The **app signing key
  itself** is Google's and cannot be changed at will, so register **Google's** fingerprint with any API
  provider, never the local upload key's.

So under the chosen route a lost Expo account is a recoverable inconvenience, not a fleet-wide
reinstall. Verified 2026-09-18 against Google's Play App Signing documentation.

🔴 **THE US$25 FEE AND THE D-U-N-S NUMBER ARE BOTH UNNECESSARY ON THIS ROUTE — verified against
Google's own documentation 2026-09-18.** Both belong to creating a **Play Console** account. Neither
applies to publishing a private app through the **managed Google Play iframe**, which is what an EMM
console does and what Phoenix is becoming. Google states it twice, plainly:

- Managed Google Play Help, "Publish private apps from managed Play in your EMM console": **"When you
  publish a private app for the first time, Managed Google Play automatically creates a Play Developer
  account on behalf of your organization. You don't need to pay a registration fee for this account."**
- Play EMM API reference, private apps: **"The iframe's Private apps page silently creates a Play
  Console account on behalf of an enterprise and waives the $25 USD registration fee."**

🔴 **AMAPI carries the same iframe** — `enterprises.webTokens` `enabledFeatures` includes
**`PRIVATE_APPS`** ("The private apps page"), alongside `PLAY_SEARCH`, `WEB_APPS`, `STORE_BUILDER`,
`MANAGED_CONFIGURATIONS` and `ZERO_TOUCH_CUSTOMER_MANAGEMENT`. The free path is therefore reachable
from the API Phoenix already chose, not only from the legacy Play EMM API the second quote sits under.

So: **no Play Console account for the owner to create, no card, no D-U-N-S, no identity-verification
wait.** Private apps are auto-approved for the organisation and "typically ready for distribution
within 10 minutes"; the ceiling is **15 private apps per day**, web apps counting toward that total.

🔴 **I SENT HIM TOWARD THE FEE AND HE ACCEPTED IT — correct that, never let it stand.** The three-route
table said "US$25 one-time" for managed Play. The fee is real for the Play Console door and does not
exist for the iframe door, and Phoenix is building the iframe door.

🔴 **The Custom App Publishing API is the PAID-account path, not the free one** — it wants a Play
Console developer account behind it, and the iframe replaces it. Publishing through the iframe is what
keeps "Phoenix is the console" true **without** the account. Do not wire the Custom App Publishing API
on the assumption it is the only programmatic route.

🔴 **The lock-in to know before the first upload:** a private app published this way is **permanently
private** ("they can't be made public") and the auto-created account is **non-transferable**. Fine for
Phoenix, which will never have a public listing — but it is one-way.

**If a Play Console account is ever genuinely needed** (a public listing, or the Custom App Publishing
API), the D-U-N-S facts still hold. An **Organization** account needs one — "You will not be able to
create a developer account for an organization without one" — while a **Personal** account needs none,
verifying instead through a linked Google Payments profile (legal name and address). 🔴 **Sato Pharma
having a D-U-N-S number was NEVER confirmed** — that wording was my own suggestion echoed back, not a
D&B answer; treat it as unknown. 🔴 **Neither self-service D&B lookup can serve Egypt**:
`my.dnb.com/lookup` demands a US ZIP code, and `dunsnumberlookup.dnb.com` has no Egypt in its country
list at all — typing "eg" returns only Bosnia and Herzegovina and Montenegro (checked 2026-09-18).
**Egypt is served by CRIF Egypt Information Technology**, a D&B Worldwide Network member, at
[dnb.com.eg](https://dnb.com.eg/duns-number/), **+202 2126 2929**; phoning is the short path, as their
web lookup needs an account first. The number would also already sit on Sato Pharma's own export,
tender or trade-finance paperwork. 🔴 A wrong or stale number costs the **non-refundable** US$25, and
Google requires the legal name and address to **match the Dun & Bradstreet record** — so it comes from
D&B or from company records, never from a third-party scraper site. 🔴 **Claude cannot create the
account or pay the fee** either way: that is account creation plus payment details, his own action.

🔴 **Continuous GPS can only live in the native app.** AMAPI gives location from Lost Mode alone, so
"locate the rep's tablet" as the owner means it is an argument for the native app existing at all — not
something the WebAPK route can ever deliver.

🔴 **THE CONSOLE IS LIVE ON PRODUCTION SINCE 2026-09-18 — and the enterprise is NOT created yet.**
PR #3982 (squash `cd27feb8d`) shipped the page at `/devices/managed-play` (and the `/hr/…` spelling),
**Super Admin only** — `company_devices:approve` is the one action on that resource no HR seat holds, which
is why the link is an admin hub card and NOT an `/hr` rail row. Verified serving on
`phoenix-hr.satopharma.com` that day: it renders the one-time **setup panel**, not the store, because
**no `ANDROID_MANAGEMENT_*` variable existed on Railway production at ship time** (88 variables, none matching). The
derived CSP (`frame-src` for `play.google.com` + `apis.google.com`) is live on that path alone.
🔴 **THE CREDENTIAL IS LIVE SINCE 2026-09-18 10:53 Cairo — the signup button WORKS.** The owner ran
the prepared script himself: service account `phoenix-amapi@phoenix-hr-2026.iam.gserviceaccount.com`, holding
`roles/androidmanagement.user` and nothing else, with ONE user-managed key (minted 10:52:58 Cairo), stored
base64 in Railway production `ANDROID_MANAGEMENT_KEY` (length 3160, no BOM) beside
`ANDROID_MANAGEMENT_PROJECT_ID=phoenix-hr-2026`. Read back the same morning: the key block is effective
`True` again on the project, no project-level override is left, and his temporary
`roles/orgpolicy.policyAdmin` is gone. **Proof:** a POST to `/api/devices/managed-play/signup` from the
signed-in page answered **200 with a signup URL on `enterprise.google.com/signup/android/email`** (the
2024+ email-first managed Google domain flow). Before the key, the same POST answered 500 "No Google
credential…", and I had first told him the page waited only on his sign-in — wrong, corrected that night.

🔴 **PHOENIX IS BOUND: `enterprises/LC017auv4o`, created 2026-09-18 11:48 Cairo** by the owner's second
signup (first try after PR #3997's hour went live; Google's `enterprises.list?projectId=phoenix-hr-2026`
answers exactly this one). Set as Railway production `ANDROID_MANAGEMENT_ENTERPRISE_NAME` at 11:49 (read
back: length 22, no BOM), which redeployed. Proof the store can open: through `railway run`, the key's
`enterprises.get` and the page's own `webTokens.create` call (parent `https://phoenix-hr.satopharma.com`,
the four PHOENIX features) both answered 200. The enterprise is his, bound to the work account he signed
up with — never re-run the signup "to fix" anything: a second enterprise is a second fleet. The stale
"PRODUCTION CREDENTIAL ROUTE IS STILL OPEN" header and the `docs/environment.md` table were already
updated in PR #3997 — no separate docs PR is owed.

🔴 **THE STORE PAGE'S FIRST REAL OPEN CRASHED — a Phoenix bug, never Google or the binding** (2026-09-18
11:54 Cairo, release `5a5f7cdc`). The owner saw the admin boundary's "This page stopped unexpectedly";
Railway showed every token POST answering 200, and `public.app_error_events` held the truth three times:
`NotFoundError: Failed to execute 'removeChild' on 'Node'`. The console called `replaceChildren()` on the
element React rendered its "Opening…" placeholder into, gapi wrote the frame there, and `setStatus("open")`
made React remove a node already gone (a 4th at 12:08:41). **Fixed by PR #4004** — a self-closing host
React never renders into, placeholder as its sibling, pinned by proof 7 in `tests/managed-play-iframe.test.ts`
(break run fired the self-closing assertion). Merged 12:11 Cairo as `19eb7c424`, served 12:14:05; verified
in the owner's connected browser the same minute: load AND "Reload the store" both answered 200, exactly one
play.google.com frame on the PRIVATE_APPS page, no console error, no new `app_error_events` row. Worktree
and branch retired the same day. 🔴 **Never let React render children into an element gapi (or any library)
writes into** — and for a page that "stopped unexpectedly", read `app_error_events` for that route before
suspecting the server. **The store now OPENS; nothing is uploaded to it yet** — the first private app is a
one-way step (permanently private) and the owner's call.

🔴 **THE TEN-MINUTE SIGNUP WINDOW BROKE THE FIRST REAL SIGNUP (2026-09-18) — fixed by PR #3997, an hour**
(merged and live 2026-09-18 11:38 Cairo; its worktree and branch retired the same minute).
The owner clicked at 11:04:24 Cairo; Google's return reached `/api/devices/managed-play/callback` at
11:17:05, **12 min 41 s** later (Google's email-first enrolment includes an inbox round trip), after the
`phx_amapi_signup` cookie had expired at 10 min → amber box, nothing created. He then sent the ghost-text
“the enterprise is created — set it on railway” believing it done, and restarted twice (11:17:14, 11:17:58),
which also ran past ten minutes. 🔴 **Do not trust "it's created" — ask Google:** `enterprises.list?projectId=`
with the Railway key (`railway run … node` a scratch script printing names only) answered 0 all morning,
and Google's own request counts (Monitoring API, `serviceruntime.googleapis.com/api/request_count`,
`resource.labels.service="androidmanagement.googleapis.com"`) showed `CreateSignupUrl` calls and no
`CreateEnterprise` at all. AMAPI writes nothing to Cloud Audit Logs. 🔴 **Railway `--http` logs are PER
DEPLOYMENT and default to the newest** — with other sessions merging every few minutes, a request from
ten minutes ago lives on a REMOVED deployment; pass its id or it reads as "never happened".

🔴 **ROTATING OR REPLACING THAT KEY NEEDS THE SAME LIFT-MINT-RESTORE, AND IT IS HIS.** Org
`omarrr-g-3003-org` (id 257848962189) ENFORCES `iam.disableServiceAccountKeyCreation`; the constraint is not
retroactive, which is the only reason the existing key keeps working. The same block forced the Master Map
onto Apps Script ([[master-map-sheet-live-on-prod-2026-08-17]]). `satopharma-prod-2026` sits OUTSIDE the org
with no parent — never route around the policy through it. His org roles include Organization Admin but NOT
`roles/orgpolicy.policyAdmin`, so a lift needs a self-grant first. Lifting the policy, creating a service
account, granting its role and minting a key are HIS actions (security settings and a credential) —
Claude prepares the script, never runs it.

🔴 **ENROLLMENT AND THE RULES ARE BUILT — PR #4018, opened 2026-09-18 13:27 Cairo, NOT merged at
writing.** Page `/devices/tablets` ("Rep Tablets", Super Admin only, same `company_devices:approve`
gate). What a later session must not get wrong:

- **One policy, `rep-tablet`, owned WHOLE by Phoenix** — `policies.patch` with NO `updateMask`, so every
  save replaces Google's copy. The owner edits only the app list; Google's copy IS that list (no Phoenix
  table). Baseline: Chrome force-installed with location+camera granted, `playStoreMode WHITELIST`,
  `untrustedAppsPolicy DISALLOW_INSTALL`, Play Protect enforced, dev settings off, `factoryResetDisabled`,
  `LOCATION_ENFORCED`, any screen lock (`SOMETHING`), `WINDOWED` updates 2:00–5:00 (Google: WINDOWED also
  holds **Play app** updates to the window).
- 🔴 **The QR payload MUST carry `PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED`** — fully managed setup
  disables non-essential system apps, the camera app usually among them, and invoice capture
  (`capture="environment"`) hands off to it. Without the extra the photo button opens nothing.
- 🔴 **Proto3 JSON drops defaults**, so Google's copy comes back missing every `false`/`_UNSPECIFIED`;
  the drift check strips defaults and sorts lists on both sides, or it reports false drift forever.
- A code made for one register tablet is `oneTimeOnly` and carries the register id in `additionalData`
  (echoed back as `enrollmentTokenData`) — that is how an enrolled tablet is matched without a typed
  serial; a serial that disagrees means it was enrolled with ANOTHER tablet's code (flagged red).
- 🔴 **The code and QR payload are credentials: never in the audit row, a log, a URL or browser
  storage.** Pinned in `tests/tablet-enrollment.test.ts`. The auto-mode classifier REFUSES even a
  temporary break that writes the code into an audit call — prove that pin with an inert comment
  naming `qrPayload` inside the audit block, restored from a copy.
- The QR encoder is Phoenix's own (`src/lib/qr/qr-code.ts`, no library installed); the test reads it
  back through an independent decoder, so never "simplify" the test by decoding with the encoder.

🔴 **As of 2026-09-18 the policy has NOT been pushed to `LC017auv4o` and no enrollment token exists.**
After merge, "Save the rules to Google" on the page is HIS first click — Claude never pushes the policy
or mints a token on the real enterprise. Lock, wipe and Lost Mode are still unbuilt, by scope.

**Why:** the owner asked whether this was remembered and nothing was recorded. The device register
looks like device management from its name and nav label, so a session can wrongly answer "Phoenix
already does this" when it does not.

**How to apply:** never answer a tablet-control question from the device register — it records
custody, it controls nothing, and Action1 does not cover Android. Confirm whether an Android
Enterprise path was actually chosen before assuming either way. The owner is [[b-10-is-the-owner-himself]].
