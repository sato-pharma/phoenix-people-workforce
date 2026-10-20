---
name: the-release-gate-lets-railway-build-while-ci-runs
description: Release gate (PR 6166, live 19 Oct 2026, docs/deployment.md "The release gate") - /api/readyz answers 503 until ci.yml's release-gate job records the commit in release_gates; Wait for CI is OFF on BOTH the app and the worker since 20 Oct 02:2x Cairo; never both gates off
metadata:
  node_type: memory
  type: project
  originSessionId: 972237fc-5fa0-4625-9335-4116607ef38b
  modified: 2026-10-19T17:51:14.125Z
---

On 19 Oct 2026 the owner asked to "speed up the Railway deploy" and, to my question, answered "WHICH IS FASTER AND COST LESS". Measured on the merge of PR 6163: checks done 19:46 Cairo, Railway's build scheduled 19:46:28, app serving from the new commit about 19:57 - 16 minutes, because Wait for CI made the checks and the build add up (the build was 10 min on a slow Railway day, 4 min on a good one).

I chose a **release gate** over building the image in CI: Railway builds the moment a commit lands, `app/api/readyz` (Railway's deploy healthcheck) answers 503 until `public.release_gates` has a row for the container's own `RAILWAY_GIT_COMMIT_SHA`, and the last job of `ci.yml` (`release-gate`, push to `main` only, after `validate` and `checks`) writes that row. The old version keeps serving until the probe passes. Image-in-CI was refused: it needs a read:packages token from him, moves the live service off its GitHub source, and is slower and dearer on a normal day.

**Why:** the build is Railway's shared builder, not ours, so the only lever is overlapping it with CI instead of queuing behind it.

**FINAL STATE, 20 Oct 2026 (after the 19 Oct cutover):** PR 6166 merged (e0e2b9bc9). Wait for CI is OFF on the APP trigger (d0cc31dc, flipped 19 Oct ~20:40 Cairo) and on the WORKER trigger (47c42ce8, flipped 20 Oct after its build logs showed `Path: /api/readyz`, `Retry window: 15m0s`, `Healthcheck succeeded` on deployments 8800310d and ba75ac83). The worker had `healthcheckPath: null` live until I set `/api/readyz` + 900 s through `serviceInstanceUpdate` at 20:53 Cairo on 19 Oct (he chose "add the probe, then switch off"). Both services answer /api/readyz with the same releaseGate decision for the same commit. Measured: merges 3f207be29 and 085d869d1 went live 6m06s and 7m51s after the push, each 10-18 s after CI's last job (the build finishes first and the gate holds it); under Wait for CI the same merges took 8.5-9.8 min on a normal day and 16 min on 19 Oct. The worktree, local and remote branch of the gate PR were already gone on 20 Oct.

**How to apply:**
- Wait for CI is OFF on both `phoenix-people-workforce` and `phoenix-workforce-worker`. Switching one back on is `deploymentTriggerUpdate` with `checkSuites: true` (app d0cc31dc, worker 47c42ce8) — only on his word, and a trigger switched ON again means that service waits for every check suite as before.
- 🔴 Never have both gates off: `PHOENIX_RELEASE_GATE=off` (only the exact word `off`) AND Wait for CI off puts every merge live the moment it builds.
- A red check leaves no row, so the deploy is marked failed and the old version keeps serving; the next green merge carries it. Never `railway redeploy`.
- The `release_gates` migration is applied to production BEFORE the merge (the deploy applies none). The table is never pruned.
- The urgent route (`urgent-deploy.mjs`) is never held by the gate.
- Railway DOES honour `healthcheckTimeout = 900` from `railway.toml` for the app (build log: `Retry window: 15m0s`); the service-level setting still reads 300.

Related: [[the-hetzner-ci-box-is-retired-ci-is-github-hosted-and-parallel]], [[github-actions-status-can-freeze-while-the-jobs-actually-run]].
