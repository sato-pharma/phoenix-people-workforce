---
name: headwind-host-split-merged-but-not-built-railway-paused
description: "22 Oct 2026 — #6250 (mdm host split + Access-pass gate) merged 05:24 Cairo but phoenix-headwind cannot rebuild while Railway builds are paused; Phoenix's Fly apps already use mdm-console; remaining steps are the owner's Access app, then PHX_ACCESS_* vars."
metadata:
  node_type: memory
  type: project
  originSessionId: 4517aa1b-96df-4e8e-9ead-20e2a37a7de8
  modified: 2026-10-22T03:49:18.101Z
---

#6250 merged at 05:24 Cairo on 22 Oct 2026 (commit 601b6373): `mdm.satopharma.com` will serve only the tablet agent's paths, the console/token/private API only on `mdm-console`, and the add-on checks Cloudflare's Access pass there once `PHX_ACCESS_TEAM_DOMAIN` + `PHX_ACCESS_AUD` are set on `phoenix-headwind`.

**Why it is not live:** Railway has paused all builds platform-wide (status.railway.com, still on at 05:32 Cairo), so `phoenix-headwind` has no deployment row for the merge. Until it rebuilds, both hostnames still serve everything (old image).

**Already done (the only prerequisite):** `HEADWIND_MDM_BASE_URL=https://mdm-console.satopharma.com` on both Fly apps (`phoenix-hr-standby`, `phoenix-worker-standby`) and on Railway's idle web service; both signed in and listed 2 tablets afterwards.

**How to apply:** when Railway resumes, confirm the new `phoenix-headwind` deployment, then verify per `docs/devices/headwind-rustdesk.md` §8.10 step 2 (on `mdm`: sync 200, `/files/` 200, `/` + `/rest/public/jwt/login` + `/rest/private/*` 403; on `mdm-console`: console + Phoenix work; uploads 403 everywhere; a tablet's lastUpdate moves). Deploying needs his word. **He gave it on 22 Oct ~06:58 Cairo, choosing "Deploy on resume" (session 11f490fa).** Its `headwind-resume.mjs` deploys main HEAD to `phoenix-headwind` once a Railway deploy succeeds, which ships #6232, #6243, #6250 and #6254 (the 6.40 launcher). It then runs the step-2 checks and Phoenix's sign-in through mdm-console. Baseline before the deploy: every path answered 200 (or 405 for POST-only) on both hosts. The last tablet syncs were PHX-TAB-0007 on 19 Oct 13:24 and 0002 on 12 Oct, so "a tablet's lastUpdate moves" needs a tablet switched on. Then he creates the Access application + service token (steps 3-4), `mdm-console` goes orange (5), and `PHX_ACCESS_*` are set (6). Related: [[the-background-worker-runs-on-fly-while-railway-is-down]].
