# Moving 100 tablets to Headwind — the brief for the session that automates it

**This file exists to be handed to a fresh session.** It carries every fact that took a night to
establish, so that session starts where 2026-09-26 finished instead of rediscovering it. Read it, then
build what §3 asks for.

---

## 1. Where things stand (verified 2026-09-26, not remembered)

- **The bridge works.** Phoenix signs in to Headwind and a private call answers: `GET
  /rest/private/users/roles` → HTTP 200, roles `Admin · User · Observer`.
- **The server is set up.** Configuration `id=3 "Rep tablets"` — `gps=true`, `disableLocation=false`,
  `kioskMode=false`, `appPermissions=GRANTALL`, enrollment QR key minted.
- **RustDesk is loaded.** Repository `id=79`, version **1.4.9**, `arch=arm64`, `runAfterInstall=true`,
  `runAtBoot=true`, linked to configuration 3 with `action=1` (install). Its bytes serve from
  `urlArm64`, 26,871,021 bytes, sha256 `285b4f07…2102` — byte-identical to RustDesk's own published
  digest for release 1.4.9.
- **One device row is pre-created**: `PHX-TAB-0002`, configuration 3, `lastUpdate=0` (never checked in).
- **Nothing has been enrolled yet.** The pilot is blocked on the tablet being wiped, not on the server.

## 2. The two facts that cost the most, so nobody pays for them twice

🔴 **The JWT comes back as `id_token` at the TOP LEVEL, with no envelope.** `POST
/rest/public/jwt/login` answers `HTTP 200, {"id_token": "<195 chars>"}` — no `status`, no `message`, no
`data`. Reading only the envelope shapes made a SUCCESSFUL sign-in look like a refusal for a whole
night, while the server's own audit log recorded `errorCode=0`.

🔴 **The password goes on the wire as UPPER-CASE MD5.** Read from the console the live server serves
(`login.controller.js` sends `md5(pw).toUpperCase()`). Lower-case gets a correct password refused.

🔴 **`errorCode=2` on `jwt.login` means "refused" — NOT "no such login".** A wrong password and a
missing account answer the same code. Read the `update.user` audit line instead: it carries the whole
user record as JSON.

🔴 **Read an endpoint's real path from the console's own JavaScript** — `app/shared/service/*.js` and
`app/components/main/service/main.service.js`, served publicly by the console. Guessing cost three
wrong paths. The ones already established:

| what | path |
| --- | --- |
| sign in | `POST /rest/public/jwt/login` |
| roles | `GET /rest/private/users/roles` |
| users list | `GET /rest/private/users/all` |
| create/update user | `PUT /rest/private/users` |
| devices | `POST /rest/private/devices/search` · `PUT /rest/private/devices` |
| configurations | `GET /rest/private/configurations/list` · `/{id}` · `PUT /rest/private/configurations` |
| applications | `GET /rest/private/applications/search/:q` · `PUT /rest/private/applications/android` |
| app versions | `PUT /rest/private/applications/versions` |
| app ↔ configuration | `GET|POST /rest/private/applications/configurations[/:id]` |
| file upload | `POST /rest/private/web-ui-files` (multipart, field `file`) |

🔴 **`runAfterInstall` and `runAtBoot` are fields of the APPLICATION record, not of the configuration
link.** Set on the link they vanish silently.

🔴 **An aarch64-only APK is stored as a SPLIT app**: the download link is `urlArm64`, and `url` is
legitimately null. Do not "fix" that — setting `split:false` breaks the download.

## 3. What to build

**The goal: move ninety-nine more tablets with the fewest human touches, and never a silent failure.**

A runner (`scripts/headwind-migrate.mjs`, run with `railway run --service phoenix-people-workforce` so
it gets the real credentials) that, for a list of tablet numbers:

1. **Pre-creates the Headwind device row** on configuration 3, named, if it does not exist.
2. **Wipes the tablet from ManageEngine** — ⚠️ moot since 2026-10-23: every tablet had moved and the
   ManageEngine bridge was deleted from the repo; a tablet still on ManageEngine is wiped in its own
   console (`docs/devices/headwind-rustdesk.md`, "Wiping it off ManageEngine first"). As first written: 🔴 this is the piece that must be worked out first. Every
   ManageEngine action answers *"Insufficient Data for Processing Request"*, which is its own error for
   a missing required field; Phoenix posts an empty body to
   `POST /api/v1/mdm/devices/{id}/actions/{action}`. The probe to finish is in the session transcript of
   2026-09-26: exchange `MANAGEENGINE_MDM_REFRESH_TOKEN` at `accounts.zoho.com` for an access token,
   then try the same action with `{"devices":[id]}` and against the collection endpoint
   `/api/v1/mdm/devices/actions/{action}`. Use the SAFEST action (`scan`) to find the right shape before
   ever sending a wipe. **The UI is not being repaired — this is a migration tool, and it is deleted
   when the fleet has moved.**
3. **Waits for the check-in** — poll `POST /rest/private/devices/search` until that number's
   `lastUpdate` is non-zero, then report model, Android version and whether RustDesk appears in its app
   list.
4. **Writes a line per tablet** to a run log: wiped at, enrolled at, RustDesk version, or the step it
   stopped on. A tablet that never checks in must read as *stopped at step N*, never as done.

**What stays human, and cannot be automated:** the six taps on the welcome screen, the Wi-Fi join, the
QR scan, and reading RustDesk's ID off the screen into the device's first custom field. Android gives
device-owner rights only to a person standing in front of a factory-fresh device.

🔴 **Never put the owner's own click in the `Next step:` box.** That is now blocked mechanically by
`~/.claude/hooks/next-step-capture.mjs`, and it is worth knowing why: on 2026-09-26 six turns were spent
on suggestions he sent straight back because they named work only he could do.

## 4. The starting prompt

> Read `docs/devices/headwind-migration-runner.md` and build what §3 asks for. Work out the ManageEngine
> action payload with the `scan` action first, prove it on PHX-TAB-0002, and do not touch the
> ManageEngine UI — it is being retired.
