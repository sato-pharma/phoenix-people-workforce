---
name: gcp-p95-latency-alert-storm-min-instances-zero
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — GCP is DEAD, billing closed, so this alert can no longer fire. The min-instances=0 change produced a recurring GCP \"p95 latency > 8s\" cold-start alert storm — expected, not a bug; fires per-revision."
metadata: 
  node_type: memory
  type: project
  originSessionId: 29fed5cf-2286-426c-8dd9-d19a40c8920a
---

Since prod Cloud Run `phoenix-hr` was set to **min-instances=0** on 2026-07-16 (owner-approved ~$68/mo cost tradeoff, see [[prod-min-instances-dropped-to-zero-2026-07-16]] / [[gcp-hardening-2026-07-16]]), the GCP alert policy **"Cloud Run p95 latency (phoenix-hr)"** (id `11963834330078859894`, condition `p95 latency > 8s`) fires a recurring **storm** of `[ALERT]`/`[RESOLVED]` emails from `alerting-noreply@google.com`. Observed values ~19.7s on `response_code: 200` = pure cold-start latency on idle→request. Service is healthy (all revisions `STATUS: True`), **no code bug** — this is the *expected consequence* of the cost tradeoff.

Non-obvious details:
- The policy fires **per-revision** (revision_name is a metric label), so even non-serving **sha-tagged preview revisions** cold-start when probed and each trips its own incident → high alert volume across many revision names, not just the live one. Stale-tag pruning ([[cloud-run-stale-tag-cpu-quota-exhaustion]], PR #1066) reduces this.
- New deploys now come up min=0 by default (durable via PR #1071); older revisions still carry minScale=1.

**RESOLVED 2026-07-17 (owner chose "keep saving money").** Kept min-instances=0; relaxed the alert policy `Cloud Run p95 latency (phoenix-hr)` (id `11963834330078859894`) from **>8s / 300s** to **>30s / 600s** (threshold 8000→30000ms, duration 300s→600s, condition displayName "p95 latency > 30s sustained 10m"; aligner/channels/enabled unchanged). 30s sits clearly above the ~20s cold-start latency, so wake-ups no longer page; only a genuinely hung service (>30s sustained 10 min) alerts. Applied via Monitoring REST API PATCH (`gcloud alpha` not installed; `gcloud auth print-access-token` + curl PATCH `updateMask=conditions`). Backup of the original policy: `scratchpad/p95-policy-backup.json` (revert = PATCH that file back). Alternative not taken: `gcloud run services update phoenix-hr --min-instances 1` (would revert the ~$68/mo saving).

The `gcp-cloud-run-alert-autofix` scheduled task triages these; its Gmail "handled" label is **`GCP-Alert-Handled` (Label_2)**. On 2026-07-17 that task labeled a 95-thread backlog (all p95-latency + self-resolved scheduler-errored + informational secret-rotation-reminder — nothing else) and notified the owner once. `scheduler job errored` and `rotation reminder published to topic` alerts are self-resolving noise.
