---
name: cloud-run-stale-tag-cpu-quota-exhaustion
description: "Cloud Run deploys can fail with CPU quota exceeded because old SHA-tagged revisions with --min-instances=1 pile up and never get cleaned up."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2af55ae2-fc65-4cf8-9dd1-dd8575e265e0
  modified: 2026-08-22T22:26:46.592Z
---

> 🔴 **SUPERSEDED 2026-08-23 — history only, do NOT act on the "How to apply" below.** This entire
> file describes the **GCP Cloud Run** era. Production moved to **Railway** on 2026-08-01 and GCP
> billing is closed: every API in project `phoenix-workforce-498619` returns `BILLING_DISABLED`, so
> the `gcloud run revisions list` / `update-traffic --remove-tags` recovery it prescribes cannot run
> at all, and there is no Cloud Run deploy left to fail this way. `deploy-cloud-run.yml` is
> trigger-disabled but intact. Current truth: AGENTS.md §3,
> [[railway-is-prod-cloud-run-workflow-is-dead]].
>
> **What still transfers:** the shape of the bug — *a per-deploy artifact that is created
> automatically, reserves a quota'd resource even while serving no traffic, and is never
> auto-cleaned* — is platform-independent and worth recognising again on Railway or anywhere else.
> That, and the handling rule: a quota failure at the deploy step is **not** a production outage
> (traffic never cut over), so diagnose before escalating.

Phoenix's `phoenix-hr` Cloud Run service deploys with a SHA-tagged revision per push (deploy-then-promote pattern, see [[gcp-cloud-run-migration-2026-07]]). Each tagged revision is created with `--min-instances 1`, which reserves 1 vCPU **even at 0% traffic** — old tags are never auto-cleaned, so they accumulate silently across many deploys.

**Incident (2026-07-13):** after merging PR #1039 to `main`, the "Deploy to Google Cloud Run" GitHub Actions run failed at the "Deploy new revision (no traffic)" step with `ERROR: (gcloud.run.deploy) Quota exceeded for total allowable CPU per project per region.` 20 stale SHA-tagged revisions had piled up (only 1 was actually live/serving traffic), together exhausting the region's CPU quota so the new revision couldn't even be created.

**Why:** the failure occurs before traffic cutover, so production itself is never at risk — but the deploy pipeline is blocked until quota is freed.

**Fix:** `gcloud run services update-traffic phoenix-hr --region=us-central1 --project=phoenix-workforce-498619 --remove-tags=<comma-separated-stale-tags>` — removing a tag releases that revision's reserved `min-instances` CPU. Kept only the live revision + 2 most recent (for rollback), removed 17 others. Verified via `gcloud run services describe` that live traffic stayed 100% on the serving revision throughout. Re-triggered the deploy via `gh run rerun <run-id>` and it succeeded end-to-end (new revision created → smoke-tested → promoted to 100%).

**How to apply:** if a future Cloud Run deploy fails with a CPU quota error at the deploy step, check `gcloud run revisions list --service=phoenix-hr --region=us-central1` for a large number of tagged revisions — that's almost certainly the cause, not a code problem. Get explicit user approval before removing tags (destructive-adjacent, touches live infra), confirm live traffic is unaffected before and after, then retry the deploy. Consider proposing a periodic (e.g. keep-last-3) tag-cleanup step in the deploy workflow itself to stop this recurring.

**Automated fix (2026-07-16): SHIPPED and confirmed working in production.** [PR #1066](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1066) merged to `main` (squash, commit `71900581`), adding `scripts/cleanup-stale-cloud-run-tags.py` as a best-effort (`continue-on-error: true`) final step in both `deploy-cloud-run.yml` and `deploy-cloud-run-staging.yml`, run after each successful promote. Keeps the newest 3 `sha-*` tags, never touches the live (100%-traffic) tag or any manually-created tag (e.g. staging's `drill-detail`), always logs keep/remove before mutating.

The merge triggered a real prod + staging deploy and the cleanup step ran for real on both:
- `phoenix-hr`: removed 1 stale tag (`sha-78d9acb2`), now sits at 4 tags total (3 kept + new live `sha-71900581`) — matches the keep-3 design exactly.
- `phoenix-hr-staging`: removed 11 stale tags in one pass, now sits at 5 tags (3 kept + `drill-detail` manual tag preserved + new live `sha-71900581`) — down from the 16 that had accumulated.

Confirmed both via a post-deploy `gcloud run services describe --format="value(status.traffic[].tag)"` read. This closes the recurring-incident loop from 2026-07-13/2026-07-14 — going forward, tag count should stay bounded automatically on every deploy instead of requiring the manual `update-traffic --remove-tags` recovery described above.
