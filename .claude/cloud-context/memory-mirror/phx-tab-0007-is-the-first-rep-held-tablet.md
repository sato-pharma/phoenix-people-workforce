---
name: phx-tab-0007-is-the-first-rep-held-tablet
description: "PHX-TAB-0007 (Lenovo TB328XU, serial HA255LN1) enrolled on Headwind config 3 and was issued 2026-10-11 to Gannatullah Amer (Medical Representative, Imbaba), declaration DEC-2026-0001 — the first tablet in a rep's hands, which is the trigger the owner set on 2026-09-29 for the clean-status-bar launcher to matter. PHX-TAB-0003..0006 (Samsung Galaxy Tab A9+, serials R9ABC00001-4) are FAKE rows written by a dev.preview run on 2026-09-25."
metadata:
  node_type: memory
  type: project
  originSessionId: c29197d2-a532-44ff-a422-13b4f76de2d7
  modified: 2026-10-21T22:23:24.038Z
---

Read from production `company_devices` / `device_assignments` / `audit_logs` on 2026-10-22.

- **PHX-TAB-0007** — Lenovo TB328XU, serial `HA255LN1`, IMEI `865569071495400`, registered by the
  Headwind auto-register 2026-10-11 14:31 Cairo, issued 14:44 Cairo to **Gannatullah Amer** (Medical
  Representative, Giza / Imbaba), Head office handover, declaration `DEC-2026-0001`. Headwind device
  number is `PHX-TAB-0007`, config 3. Only one Phoenix action since: "Located" 2026-10-13 04:14 Cairo.
  Enrolled after 2026-09-28, so the config-3 QR installed the Phoenix 6.39 launcher, whose on-device
  unknowns (clean bar draws? Android's "IT admin" notices gone?) were never checked on a rep's tablet.
  The 2026-09-29 deferral in [[headwind-rep-tablet-custom-launcher-build-required]] ended here.
- **PHX-TAB-0003 … 0006** are not real: Samsung "Galaxy Tab A9+", serials `R9ABC00001`–`R9ABC00004`,
  14-digit IMEIs `351123456789xx`…, `created_by = dev.preview`, 2026-09-25 19:59 Cairo, note "Added
  automatically when the tablet enrolled on the company's own Headwind server". A local preview wrote
  test devices into production (`.env.local` is production). **RETIRED 2026-10-22 01:17 Cairo on the
  owner's choice** ("Retire them") — status `retired`, reason "Test data written by a local preview run
  on 25 September 2026 - never a real tablet.", four `audit_logs` rows; rows kept, never delete them.
- PHX-TAB-0001 (TCL, in stock) and PHX-TAB-0002 (Lenovo pilot, in stock) are real.

🔴 **STATE on 2026-10-22 (read from Headwind devicelog, 2265 rows):** PHX-TAB-0007 last checked in
**19 Oct 13:24 Cairo — silent ~3 days since**, battery 36% at last contact, status red. It checked in
hourly from 11–19 Oct, then stopped mid-afternoon (off, or no connectivity). Device owner = true,
kioskMode false, defaultLauncher false (normal Lenovo home), launcher 6.39 (the Phoenix custom build).

🔴 **The Phoenix Workforce app is NOT installed on the rep's tablet.** On 11 Oct the agent logged
`Downloading app: com.satopharma.phoenixworkforce` → `Failed to download … Bad server response` (the
`phoenix-workforce-0.4.0-versionCode4-mdm.apk` 404s — redeploy wiped it,
[[headwind-uploaded-apks-vanish-on-redeploy-and-mqtt-push-is-dead]]). The device's reported installed
apps are only RustDesk 1.4.9 + the launcher. So the business app the tablet exists for has never run on it.

Related: [[new-hire-medical-reps-get-company-tablets]], [[headwind-sync-endpoint-is-public-and-feeds-the-custody-register]].
