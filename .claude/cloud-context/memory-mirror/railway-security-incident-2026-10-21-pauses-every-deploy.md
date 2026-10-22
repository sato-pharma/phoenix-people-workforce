---
name: railway-security-incident-2026-10-21-pauses-every-deploy
description: "The worker's 'Deploy failed' (deployment c4ca37f2, 21 Oct 10:17 Cairo) has NO build — it is Railway's security-incident deploy pause. SUPERSEDED 22 Oct 03:38 Cairo: the jobs moved to the Fly worker and Railway's worker is stopped ON PURPOSE (role web) — never deploy or restart it as a 'fix'; going back is the ordered move in the Fly-worker note."
metadata:
  node_type: memory
  type: project
  originSessionId: 479dc077-eacb-4676-b9a7-2179ddbd4820
  modified: 2026-10-22T02:38:39.549Z
---

Read 22 Oct 2026 01:45 Cairo: `phoenix-workforce-worker` was Online on `2c725ad1` (ed7797a85); its newest row `c4ca37f2` FAILED with "Deployment does not have an associated build", refused by the pause. Service settings were clean (rootDirectory null, source = repo), unlike [[an-image-ref-in-root-directory-kills-every-production-build]]. status.railway.com: builds paused for a security incident; Railway advised revoking every variable stored in Railway.

The owner said "deploy main HEAD to the worker when Railway builds resume" (22 Oct ~01:50 Cairo). A watcher tried six times, 03:33–05:25 Cairo, and Railway answered "Paused temporarily" every time, with no deployment row left behind. Meanwhile the old database key was switched off (~02:35), the Railway worker began failing with "Unregistered API key", and the owner chose "Separate worker on Fly". So the Railway worker is now stopped and set to role web on purpose, and its URL answers 502 for that reason.

**Why:** the red "Deploy failed" and the 502 both look like faults, but they are the intended state. Deploying the Railway worker would undo the plan.

**How to apply:** do not deploy or restart Railway's worker. The background jobs live on `phoenix-worker-standby` (Fly). Moving back to Railway is the ordered change in [[the-background-worker-runs-on-fly-while-railway-is-down]], and it starts only on the owner's word once Railway builds again. Note: a status-page phrase like "available again" also appears in "working to make builds available again", so a deploy attempt (it leaves no row while paused) is the only reliable probe.

**A waiting script must re-read the Railway CLI login on every call.** `~/.railway/config.json` `user.accessToken` lasts about an hour (`tokenExpiresAt`), and the CLI rewrites it when it renews. A watcher that read it once at 05:16 got `Not Authorized` at 05:37 Cairo on 22 Oct (the CLI had renewed it at 05:25); a fresh read worked at once. Re-read it per call, and run `railway whoami` within 5 minutes of expiry, which renews it. The owner's "move production back to Railway once it serves main HEAD" (22 Oct ~05:30 Cairo) is that word for the ordered move: a scratchpad `move-back.mjs` in session 11f490fa runs it after the website deploy succeeds.
