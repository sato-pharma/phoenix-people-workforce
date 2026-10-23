---
name: all-deployments-through-fly-until-railway-is-back
description: "RETIRED 23 Oct 2026 ~04:33 Cairo on the owner's word \"Railway is back — retire the all-deployments-through-Fly rule\": deployments go through Railway again (website and worker back on Railway). History only: from 22 Oct the rule sent every deployment through Fly.io while Railway was paused."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d36b05eb-2113-46dd-a685-dfc52e3baf52
  modified: 2026-10-23T01:33:10.946Z
---

✅ **RETIRED — owner, 23 Oct 2026 ~04:33 Cairo: "Railway is back — retire the all-deployments-through-Fly rule".**
Production deploys through Railway again: the domain answers from Railway since 22 Oct 10:29 Cairo, and the
background worker moved back to Railway on 23 Oct. The Fly website standby `phoenix-hr-standby` stays at zero
machines as the Emergency host button's app. Everything below is history — never act on it.

🔴 **GOLDEN RULE — owner's own words, 22 Oct 2026 Cairo: "ship 6.41 instead of 6.40 TO FLY.IO AND
PUT A GOLDEN RULE UNTIL RAILWAY IS BACK ALL DEPLOYMENTS THROUGH FLY.IO".**

**Why:** Railway builds are paused workspace-wide (since ~20:03 Cairo 20 Oct; still paused 22 Oct),
so anything that waits for Railway does not ship. The owner's standing answer during the outage is
NOT to wait — route every deployment through Fly.io instead.

**How to apply:**
- **Until the owner says Railway is back, deploy through Fly.io, never Railway, and never "wait for
  Railway to resume" as the plan.** A deploy that would sit until Railway builds return is the wrong
  answer now; find the Fly route.
- Known Fly targets already live in this outage: the **background worker** runs on Fly
  (`phoenix-worker-standby`, see [[the-background-worker-runs-on-fly-while-railway-is-down]]); the
  **six rep apps** are hosted on `phoenix-tablet-apps.fly.dev` and registered in Headwind config 3
  (another session's track); and now the **6.41 custom launcher** ships to Fly too.
- The **custom launcher** 6.41 is built + signed ([[phoenix-launcher-6-41-built-completes-location-and-unattended-rustdesk]]):
  host the signed APK on Fly at a stable URL and point the Headwind launcher application (app-46,
  version 10045) at that URL so the tablets pull 6.41 from Fly. The Headwind MDM server itself is on
  Railway and SERVING fine (only builds are paused), so its config API still answers.
- For **production (the web app)**, "via Fly" means the Fly fallback other sessions are standing up
  (account token / `serviceInstanceDeployV2` work), NOT an ad-hoc migration invented in one session.
  Scope was not pinned in his message — if a production deploy comes up, confirm the Fly route with
  him rather than deploying to Railway or inventing a new path.
- **This rule RETIRES when the owner says Railway is back** — at which point the earlier standing word
  "point production back at Railway when its deploys resume" takes over
  ([[back-to-railway-checks-only-that-railway-answers-not-its-revision]]). Never retire it on your own
  reading that Railway looks healthy.

Related: [[a-railway-build-outage-leaves-no-deployment-row]],
[[zero-deployment-rows-means-a-railway-build-outage-not-a-withheld-deploy]],
[[the-fallback-route-is-unproven-railway-pauses-deploys-too]] (a.k.a.
[[the-repo-railway-token-is-dead-and-the-fallback-needs-an-account-token]]).
