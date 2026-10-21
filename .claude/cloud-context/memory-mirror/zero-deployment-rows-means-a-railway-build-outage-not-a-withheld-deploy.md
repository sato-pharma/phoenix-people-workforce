---
name: zero-deployment-rows-means-a-railway-build-outage-not-a-withheld-deploy
description: "Production frozen with green main CI, an open release gate and ZERO GitHub deployment rows for the merged commits is a RAILWAY-SIDE build pause - read status.railway.com before suspecting the trigger, a repointed source or the gate; a withheld or skipped deploy always leaves a row"
metadata:
  node_type: memory
  type: project
  originSessionId: 6347cf50-abe9-435e-a00f-ef98cd30cc95
  modified: 2026-10-20T19:19:47.142Z
---

🔴 **No GitHub deployment row at all is a DIFFERENT failure from a withheld or skipped deploy, and
it points outside this repo.** Measured 2026-10-20: four merges to `main` (#6205 20:15, #6206 21:21,
#6207 21:46, #6208 21:54 Cairo) all had `push` CI `completed/success`, a `release-gate` job
`completed/success`, and a `release_gates` row recorded minutes after each merge — and production
stayed on `081000898` from 18:44 Cairo. `gh api …/deployments` held **nothing newer than the 18:44
commit**: not `WITHHELD`, not `SKIPPED`, not `in_progress`. Railway had **paused all builds
workspace-wide** (incident `JUA1PC5H`, "Major Outage", 17:03 UTC / 20:03 Cairo), and the first merge
after 18:44 Cairo landed twelve minutes into that pause, so every unserved commit was inside the
window.

**Read the shapes apart before diagnosing:**
- **A deployment row that never reaches `success`** → the release gate, a red `main`, or a build
  failure. Our own problem. [[a-red-main-ci-makes-railway-skip-the-deploy-for-good]],
  [[the-release-gate-lets-railway-build-while-ci-runs]].
- **A row that reaches `success` but an older sha serving** → a race or a superseded deploy.
  [[a-superseded-deploy-reached-success-a-withheld-one-never-did]].
- **NO ROW AT ALL for a green merge** → Railway never started a build. Vendor outage, or the git
  source disconnected. **`https://status.railway.com/` answers this in one read.** The page is a
  client-rendered SPA, but its own data call is plain JSON:
  `curl -s https://status.railway.com/api/status` → `activeIncidents[]` (slug, status, title,
  `resolvedAt`, `updates[]`). Read that, not the HTML.

**How to apply:**
- 🔴 **Read status.railway.com BEFORE forming a hypothesis about the trigger.** The expensive wrong
  turn here was suspecting a repointed service source — which leads straight at
  [[railway-service-source-connect-is-not-environment-scoped]], a command that has rolled production
  back before. A vendor status page is free; the source-connect trap is not.
- **Railway's own instruction when builds resume is that the paused deploys must be triggered
  again** — they do not drain by themselves. The next merge to `main` builds its HEAD, which carries
  every queued commit, so one merge ships the whole backlog; `railway redeploy` cannot help because
  it only redeploys the LATEST deployment, which is the stale one.
- **Do not merge more work while builds are paused** — each merge pays a full `main` CI run and
  still does not ship.
- **Hold a pending production migration** until the new revision is confirmed serving by
  `/api/healthz` `revision`: the merge is no longer the deploy during an outage, so a migration
  applied "after the merge" lands in front of code that is not there yet.
- Same family as [[a-docker-hub-429-silently-stopped-four-production-deploys]] and
  [[ci-on-main-is-hosted-so-an-actions-incident-withholds-the-deploy]] — an external dependency,
  silent, and only visible by asking the dependency.
