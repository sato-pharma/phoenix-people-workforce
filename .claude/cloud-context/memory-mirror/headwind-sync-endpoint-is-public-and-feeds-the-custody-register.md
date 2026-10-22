---
name: headwind-sync-endpoint-is-public-and-feeds-the-custody-register
description: "Measured 2026-10-22: mdm.satopharma.com answers GET /rest/public/sync/configuration/<number|IMEI|serial> to anyone (secure enrollment OFF) with the whole config incl. the device-admin password MD5 — the real exposure. CORRECTION: createNewDevices=false on this server, so an unknown number does NOT create a device; only the enrollment flow with the config's qrCodeKey does. The custody auto-register that copied every Headwind device into Device Custody is being removed in the tablet-lockdown PR — a person now confirms each tablet. Still never GET sync/configuration or /notifications for a REAL device: the add-on markConsumed eats queued actions."
metadata:
  node_type: memory
  type: project
  originSessionId: c29197d2-a532-44ff-a422-13b4f76de2d7
  modified: 2026-10-21T23:52:30.030Z
---

Measured 2026-10-22 ~01:00 Cairo, read-only, against production.

- `GET https://mdm.satopharma.com/rest/public/sync/configuration/PHX-TAB-0002` (and `PHX-TAB-0007`)
  answered **HTTP 200 with no credential**: the full configuration-3 payload — app list and URLs,
  `restrictions`, `pushOptions`, `newServerUrl`, and `password` (32-char MD5 of the on-device admin
  password, same for every tablet on config 3). Headwind's `SyncResource` only checks a signature when
  `secure.enrollment` is on, so it is OFF on this server. Lookup also matches by IMEI or serial. **This
  is the real exposure — anyone who knows a device number reads its config and the admin-password MD5.**
- 🔴 **CORRECTION to the earlier note: an unknown number does NOT create a device.** The live settings
  read shows `createNewDevices=false`, so the sync endpoints do not auto-create on demand; a device is
  created only by the enrollment flow carrying the configuration's `qrCodeKey`. The earlier
  "createNewDeviceOnDemand" / "a GET for an unknown number creates a device" claim was wrong.
- 🔴 **The custody auto-register is being removed (tablet-lockdown PR, 22 Oct).** `getHeadwindFleet` used
  to copy every Headwind device with a serial/IMEI into `company_devices` as the next `PHX-TAB-nnnn` on
  every fleet load; the owner's decision (22 Oct) is that a person confirms each new tablet, via
  `POST /api/devices/headwind/register`. Until that PR is live, the auto-register is still on `main`.
- 🔴 **Still never GET `/rest/public/sync/configuration/*` or `/notifications/*` for a REAL device** — the
  add-on's `markConsumed` closes queued actions (and the config leaks the password MD5). An unknown
  number is harmless to probe (no creation), but there is no reason to.
- The public **upload** write (`/rest/public/applications/upload`, published-default hash) is the other
  hole — closed by the lockdown rewrite rule (runbook §8.3), to apply when Railway is healthy.
- Turning on secure enrollment is not a one-switch fix: the stock 6.37 agent signs with Headwind's
  public default secret, so a new server secret cuts PHX-TAB-0002 off, and `/info` stays unsigned anyway.

Related: [[new-hire-medical-reps-get-company-tablets]], [[rep-tablet-never-shows-tracking-golden-rule]],
[[headwind-uploaded-apks-vanish-on-redeploy-and-mqtt-push-is-dead]].
