---
name: the-release-gate-lets-railway-build-while-ci-runs
description: "Release gate (built 19 Oct 2026, docs/deployment.md \"The release gate\") - Railway builds at the merge, /api/readyz answers 503 until CI's release-gate job records the commit in release_gates; Wait for CI stays ON until he says off, never both gates off"
metadata:
  node_type: memory
  type: project
  originSessionId: 972237fc-5fa0-4625-9335-4116607ef38b
  modified: 2026-10-19T17:51:14.125Z
---

On 19 Oct 2026 the owner asked to "speed up the Railway deploy" and, to my question, answered "WHICH IS FASTER AND COST LESS". Measured on the merge of PR 6163: checks done 19:46 Cairo, Railway's build scheduled 19:46:28, app serving from the new commit about 19:57 - 16 minutes, because Wait for CI made the checks and the build add up (the build was 10 min on a slow Railway day, 4 min on a good one).

I chose a **release gate** over building the image in CI: Railway builds the moment a commit lands, `app/api/readyz` (Railway's deploy healthcheck) answers 503 until `public.release_gates` has a row for the container's own `RAILWAY_GIT_COMMIT_SHA`, and the last job of `ci.yml` (`release-gate`, push to `main` only, after `validate` and `checks`) writes that row. The old version keeps serving until the probe passes. Image-in-CI was refused: it needs a read:packages token from him, moves the live service off its GitHub source, and is slower and dearer on a normal day.

**Why:** the build is Railway's shared builder, not ours, so the only lever is overlapping it with CI instead of queuing behind it.

**State at 20:49 Cairo, 19 Oct 2026:** PR 6166 merged (e0e2b9bc9) and proven live: readyz showed releaseGate recorded and the build log printed `Retry window: 15m0s` + `Healthcheck succeeded`. He then chose "switch off on both"; I switched Wait for CI OFF on the APP trigger only (d0cc31dc, one `deploymentTriggerUpdate`, `railway api`). 🔴 **The WORKER (phoenix-workforce-worker) has `healthcheckPath: null` live — its build log has no healthcheck section — so the gate cannot hold it; its trigger (47c42ce8) stays ON.** He then chose "Add the probe, then switch off": at 20:53 Cairo I set the worker's service-level `healthcheckPath` `/api/readyz` and `healthcheckTimeout` 900 (`serviceInstanceUpdate`, read back). 🔴 **PENDING: no worker deploy has run with it yet — the next merge to main builds one (after CI, the worker trigger is still ON); read its `railway logs --build` for `Path: /api/readyz` + `Retry window: 15m0s` + `Healthcheck succeeded`, and ONLY THEN flip trigger 47c42ce8 `checkSuites` false (already approved, no re-ask). Never `railway redeploy` to force it.** The docs and the .railway/railway.ts comment saying the worker is held are true only after that; a one-line docs note (service-level probe set 19 Oct, why) is parked for the next PR that touches deploy docs, never a PR of its own.

**How to apply:**
- Wait for CI is OFF on `phoenix-people-workforce` (the app) and still ON on `phoenix-workforce-worker`; the worker changes only on his word and only after it has a healthcheck (or he accepts it ungated). Switching it back on for the app is the same `deploymentTriggerUpdate` with `checkSuites: true` (trigger d0cc31dc). The gate is proven: live `/api/readyz` showed `checks.releaseGate` required true, passed true, reason `recorded`, and the build log printed `Retry window: 15m0s`.
- 🔴 Never have both gates off: `PHOENIX_RELEASE_GATE=off` (only the exact word `off`) AND Wait for CI off puts every merge live the moment it builds.
- A red check leaves no row, so the deploy is marked failed and the old version keeps serving; the next green merge carries it. Never `railway redeploy`.
- The `release_gates` migration is applied to production BEFORE the merge (the deploy applies none). The table is never pruned.
- The urgent route (`urgent-deploy.mjs`) is never held by the gate.
- Railway DOES honour `healthcheckTimeout = 900` from `railway.toml` for the app (build log: `Retry window: 15m0s`); the service-level setting still reads 300.

Related: [[the-hetzner-ci-box-is-retired-ci-is-github-hosted-and-parallel]], [[github-actions-status-can-freeze-while-the-jobs-actually-run]].
