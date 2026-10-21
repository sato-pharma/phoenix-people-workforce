---
name: a-railway-build-outage-leaves-no-deployment-row
description: "When main's CI and the release gate are green but `railway deployment list` shows NO row for several merges, read status.railway.com first — on 2026-10-20 Railway paused all builds 20:03 Cairo onward and five merges (#6205–#6211) made no deployment; paused deploys are not re-queued."
metadata:
  node_type: memory
  type: project
  originSessionId: 1edb9bd8-1d3f-4259-bbfc-3e835e3bebcc
  modified: 2026-10-20T19:20:28.903Z
---

On 2026-10-20 production stayed on #6204 (`081000898`, deployed 18:44 Cairo) while #6205, #6206, #6207, #6208 and #6211 merged with `validate`, `checks` and `release-gate` all green. `railway deployment list` for `phoenix-people-workforce` and `phoenix-workforce-worker` showed no row at all after 18:44 — not SKIPPED, not FAILED. status.railway.com showed "New builds are temporarily paused", a Major Outage of Builds in every region from 17:03 UTC (20:03 Cairo), with the note that deploys triggered during the pause "will need to be triggered again once builds resume".

It looks like docs/deployment.md failure mode 5 (no deployment row), but the cause is different: here the `ci.yml` push runs DO exist, so it is the CI-runs-present, no-row case.

**Why:** a session reading only GitHub and Railway's deployment list cannot see the cause, and would otherwise reach for `railway redeploy` (which repeats the OLD commit) or the urgent route.

**How to apply:** green CI + no Railway row → open status.railway.com before anything else. Owner's ruling on recovery (2026-10-20, MCQ): first "Next merge carries it" (~22:12 Cairo), then REPLACED in session 2c3d5da9 (~22:20, confirmed twice): "I deploy it on resume" — once status.railway.com shows builds back, deploy main HEAD on the app and the worker with Railway's `serviceInstanceDeployV2(serviceId, environmentId, commitSha)`; the release gate still holds it until that commit's CI is green. That was his word for that outage — ask again next time. Never `railway redeploy` (it repeats the OLD commit), never `railway up` without his "live in five minutes". Related: [[a-main-build-step-can-be-cancelled-with-no-code-fault]].
