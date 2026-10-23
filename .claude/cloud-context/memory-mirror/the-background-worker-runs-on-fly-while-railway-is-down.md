---
name: the-background-worker-runs-on-fly-while-railway-is-down
description: "ENDED 23 Oct 2026 04:35 Cairo: the background jobs are back on Railway's worker phoenix-workforce-worker (PHOENIX_PROCESS_ROLE=worker, boot lines [process-role] worker and [crm:live-poll] started at 04:33), the 4 cron-job.org jobs call phoenix-workforce-worker-production.up.railway.app again (inbound-intake still OFF), and the Fly app phoenix-worker-standby was destroyed on the owner's order. History: 22 Oct 03:38 to 23 Oct 04:31 Cairo the jobs ran on that Fly app."
metadata:
  node_type: memory
  type: project
  originSessionId: 03486b16-34ba-44b4-af4e-c44a32696de1
  modified: 2026-10-23T01:36:38.503Z
---

✅ **ENDED 23 Oct 2026 Cairo — the worker is back on Railway and `phoenix-worker-standby` no longer exists.**
04:31:56 Fly worker scaled to 0; 04:31:58 Railway worker `PHOENIX_PROCESS_ROLE=worker`, redeploy 87b89459 SUCCESS
04:32:59; boot lines `[process-role] worker` and `[crm:live-poll] started` at 04:33:30; 04:33:32 the 4 cron jobs moved
back to Railway (inbound-intake stays OFF); 04:35:33 process-notifications and recruitment-email-intake ran from
Railway with status OK; 04:35:41 `flyctl apps destroy phoenix-worker-standby`. `phoenix-hr-standby` is kept, suspended,
zero machines. An emergency-host go-live no longer has a Fly worker to update (its worker step is continue-on-error).
Everything below is history.

On 22 Oct 2026 the Railway worker was stuck on its 20 Oct deployment (ed7797a85), still holding the deleted database key, and Railway could not deploy. Every background job had stopped at about 02:35 Cairo, when the old key was switched off. The owner said "dploy thjrough fly", then chose **"Separate worker on Fly"** in a multiple-choice question.

What runs now:
- **Fly app `phoenix-worker-standby`** (fra, shared-cpu-2x, 2 GB, about US$12 a month). It runs the website's own image, `registry.fly.io/phoenix-hr-standby:<sha>`, deployed by hand with `flyctl deploy -a phoenix-worker-standby -c infra/fly-standby/fly-worker.toml --image registry.fly.io/phoenix-hr-standby:<sha> --strategy rolling` after every go-live. Its config is `infra/fly-standby/fly-worker.toml` on main (PR 6247, carried by roll-up PR 6249, merged 22 Oct 05:16 Cairo as a2c6a1752; pinned by `tests/emergency-host.test.ts` block "1b. The Fly worker"). On 22 Oct 04:58 Cairo the worker took 09077e12a this way, and at 05:44 a2c6a1752 (right after that commit's 05:43 go-live; role worker, all three loops started, one health check failed mid-boot then passing).
- The toml's `[env]` sets `PHOENIX_PROCESS_ROLE=worker`, `PHOENIX_LIVE_CRM_POLL=true`, `PHOENIX_HOST=fly-worker` and **`RAILWAY_ENVIRONMENT_NAME=production`**. The last one is deliberate: it is the CRM poller's host pin (resolveInProcessHostRefusal). With no RAILWAY_GIT_COMMIT_SHA the release gate reads "no_commit" and stays open.
- Its secrets were copied from the Railway worker through `filterVariables` in scripts/emergency-host.mjs (121 variables).
- **Railway's worker:** its running deployment (2c725ad1) was stopped with deploymentStop, and its `PHOENIX_PROCESS_ROLE` was set to **`web`**, so a Railway redeploy can never run the jobs twice.
- The 4 cron-job.org jobs that called Railway's worker address now call `phoenix-worker-standby.fly.dev` on the new CRON_SECRET: crm-contact-lists, process-notifications, recruitment-email-intake and inbound-intake.

**Why:** a second worker double-runs every job (there is no single-runner lock), and two pollers hit one iReports360 account.
**How to apply:**
- **Every secret rotation and every main deploy to the standby must ALSO reach this app.** The emergency-host workflow only updates `phoenix-hr-standby`.
- **Before a go-live after someone ran `setup`, compare digests:** `flyctl secrets list --json` on both apps; the shared names must match (22 Oct 05:20 Cairo: 121 shared, 0 differ). The go-live uses `--strategy immediate` on one machine, so a stale copied variable takes the site down.
- **Railway's website service is NOT the worker:** on the owner's "deploy main HEAD to Railway when builds resume" (22 Oct 05:13 Cairo) only `phoenix-people-workforce` is deployed; Railway's worker stays stopped. A refused `serviceInstanceDeployV2` ("Paused temporarily") leaves no deployment row, so a deploy attempt is a safe probe.
- **Moving back to Railway is one change, in this order:** stop the Fly worker (`flyctl scale count 0 -a phoenix-worker-standby`), set Railway's worker `PHOENIX_PROCESS_ROLE=worker`, deploy it, move the 4 jobs back to `phoenix-workforce-worker-production.up.railway.app`, then delete the Fly app.
- **Owner, 22 Oct ~06:15 Cairo: delete `phoenix-worker-standby` once production is back on Railway, and KEEP `phoenix-hr-standby` stopped** (he chose "Keep it, stopped" over deleting both): it is the Emergency host button's app, with its certificate and IPs in place. Never delete it as tidy-up. Session 11f490fa's `fly-cleanup.mjs` waits for the move back, re-proves it live (the domain answers from Railway, no cron job or Railway variable names fly.dev, the worker has 0 machines), then destroys only the worker app.

Related: [[railway-security-incident-2026-10-21-pauses-every-deploy]], [[the-2026-10-22-secret-rotation-keeps-old-values-until-22-nov]].
