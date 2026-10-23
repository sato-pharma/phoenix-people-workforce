---
name: launcher-6-48-combined-shipped-to-the-fleet
description: "launcher 6.48 (code 15480) is the live fleet version — the superset of periodic location (6.46) + RustDesk-pump-on-open + the Sato Pharma lock-screen label; shipped via Fly to version row 10045 on 23 Oct 2026, superseding 6.46 and the never-shipped 6.47"
metadata:
  node_type: memory
  type: project
  originSessionId: 2f36184d-33ad-4be5-95f6-3094cc22a443
  modified: 2026-10-23T02:13:24.835Z
---

**Launcher 6.48 / versionCode 15480** is the live fleet launcher as of 23 Oct 2026 (Cairo), fork
`Gawish-1997/hmdm-android`, branch `phoenix/launcher-6.48-combined` (built green by `phoenix-build.yml`
run 39887245317, signed APK 6,290,217 bytes, Phoenix cert `7b48e751…1c49` — the installed key, so no
re-enroll). It is the **superset** of three disjoint launcher lines that were racing on one version row:

- **periodic location sampling** (6.46, `5cb4363`, base = 6.45 `59383bb` register-providers) — already live
  when this shipped;
- **RustDesk pump on tablet-open** (my 6.47, `695b9b6`) — a runtime receiver in `PushLongPollingService`
  for `ACTION_USER_PRESENT`/`ACTION_SCREEN_ON`, re-launches RustDesk when the tablet is opened, throttled
  to once per 30 min so it never flashes mid-use; inert if RustDesk absent or `remote_access_package`="off";
- **owner-info label** (`aa14e5f`, from `2de0853`) — `Utils.applyOwnerInfo` sets `setOrganizationName`
  ("Sato Pharma") + `setDeviceOwnerLockScreenInfo` ("This device belongs to Sato Pharma") each sync.

🔴 **Why combined, not 6.47:** 6.47 was built on 6.45 and did NOT contain 6.46's periodic location, so
shipping 6.47 to row 10045 would have REGRESSED location. Owner chose "ship combined 6.48" (MCQ, 23 Oct).
6.47 was never hosted on Fly and is superseded — do not ship it.

**How it was shipped (the proven Fly route, Railway still paused):**
1. Fly host `phoenix-tablet-apps` (app, region fra) rebuilt from a plain `nginx:1.27-alpine` image that
   `COPY html/` — serving 6.44, 6.45, 6.46 (preserved) **and** 6.48 at root. `flyctl deploy -a
   phoenix-tablet-apps --remote-only`. Served `hmdm-phoenix-6.48.apk` sha256 verified byte-identical to the
   CI artifact (`f7e1304c…b5e9f`).
2. Version row **10045** edited **in place** via `PUT /rest/private/applications/versions` with the live
   `ApplicationVersion` object (id 10045 kept ⇒ update not insert), changing only version→"6.48",
   versionCode→15480, url→the Fly 6.48 URL. PUT 200; read-back: still ONE version row, app 46 shows
   6.48/15480, `latestVersion`=`usedVersionId`=10045. **NOT a config-3 PUT**, so the six rep-app links were
   untouched (the carry-the-app-links trap avoided).

**The private API is reached only on `mdm-console.satopharma.com`** (not `mdm.`), JWT via
`POST /rest/public/jwt/login` (UPPER-hex MD5 password) **plus** `CF-Access-Client-Id/Secret` headers on
every call — all from Railway secrets, run via `railway run --service phoenix-people-workforce -- node …`
from the primary checkout. h-mdm's `updateApplicationVersion`: id==0 inserts, else updates — keep id 10045
to edit in place. Read versions at `GET /rest/private/applications/46/versions`.

**Pre-ship manifest check honoured:** 6.48 carries `MY_PACKAGE_REPLACED` (the self-update restart receiver
from 6.42), so a tablet self-updating to 6.48 restarts cleanly, not stranded ([[a-launcher-self-update-leaves-the-agent-dead-until-a-reboot]]).

PHX-TAB-0007 (Ganna) and 0008 (Ahmed) install 6.48 at next check-in. Location still needs a first GPS fix
proven under open sky ([[tablet-location-goes-periodic-after-6-45-reports]], [[headwind-location-never-registered-gps-provider]]).
Related: [[phoenix-launcher-6-41-built-completes-location-and-unattended-rustdesk]], [[all-deployments-through-fly-until-railway-is-back]].
