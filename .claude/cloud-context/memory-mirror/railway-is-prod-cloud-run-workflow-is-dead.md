---
name: railway-is-prod-cloud-run-workflow-is-dead
description: "Production deploys via Railway auto-deploy on push to main; deploy-cloud-run.yml is a dead path whose GCP-billing failure is noise"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8a14a10d-0b9a-45f3-9367-3ca2598ceb0e
  modified: 2026-08-04T15:33:33.633Z
---

Production is **Railway**, and it **auto-deploys on every push to `main`** — no dispatch, no
approval step, no waiting. Confirmed 2026-08-02: merge `522262b2` landed 05:43:08Z and the Railway
deployment started 05:43:12Z (4 seconds later), success at 05:45:25Z.

Verify a deploy through the **GitHub deployments API**, not gcloud:
`gh api repos/it-gawish-hr/phoenix-people-workforce/deployments` — rows read
`Phoenix-HR-Workforce / production … "Deployed to Railway"`, and
`/deployments/<id>/statuses` gives in_progress → success.

**`.github/workflows/deploy-cloud-run.yml` IS A DEAD PATH.** It still exists and can still be
dispatched, and it will fail with:
`403 … billing account for the owning project is disabled in state delinquent`
(GCP project `phoenix-workforce-498619`). That failure says **nothing** about production — the app
is not on Cloud Run any more. Do not chase it, and do not report it as a production blocker.

I made exactly that mistake: dispatched the Cloud Run workflow after a merge, watched it fail on
billing, and told the owner production was blocked. Production had already shipped 3 minutes
earlier via Railway.

The `gcloud run revisions list --service phoenix-hr --region europe-west3` verification step in
AGENTS.md is stale for the same reason. To prove production actually has a change, hit the public
domain and assert on behaviour — e.g. a retired route returning 404 while a live one returns 200.

Related: [[railway-migration-live-topology-and-cli]] (project `Phoenix-HR-Workforce`, two services),
[[cron-job-org-is-the-real-production-scheduler]], [[prod-deploy-scheduled-not-on-push]] (now
superseded — that described the Cloud Run era).
