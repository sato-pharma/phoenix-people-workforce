---
name: maps-static-daily-cap-is-300-on-phoenix-hr-2026
description: "The Google Maps Static API is capped at 300 pictures a day on the phoenix-hr-2026 Google Cloud project (owner's choice, 14 Nov 2026); how to read the cap back from the laptop"
metadata:
  node_type: memory
  type: project
  originSessionId: 10ba1c01-8641-48a5-97e7-a15f406ecef1
  modified: 2026-11-14T01:24:18.419Z
---

**The Maps Static API has a daily cap of 300 pictures on Google Cloud project `phoenix-hr-2026`** (project number 194526343603), saved 14 Nov 2026 at 03:23 Cairo.

- **His words:** asked by multiple choice after his own console change had not landed, he chose "Set 300 a day (Recommended)". 300 a day is at most about 9,300 a month, inside Google's 10,000 free pictures, so the bill for map pictures stays at zero. Price past the free ones: 2.00 USD per 1,000.
- **What is capped:** both per-day limits of `static-maps-backend.googleapis.com`: `billable_default` ("Requests", was unlimited) and `billable_unsignedbucket` (was 25,000). They are consumer overrides, value 300.
- **Who shares the 300:** the integrity boards' street picture, the route map and the outstation map all use the server key `phoenix-server` on that project. A day that hits the cap shows maps without streets until the next day (Pacific midnight); markers and metres are the app's own, so no number changes.
- **Use when it was set:** 24 pictures in the first day (13 to 14 Nov 2026).
- **Read it back (read-only):** `gcloud` is installed and signed in on the laptop. `GET https://serviceusage.googleapis.com/v1beta1/projects/phoenix-hr-2026/services/static-maps-backend.googleapis.com/consumerQuotaMetrics?view=FULL` with `Authorization: Bearer $(gcloud auth print-access-token)` and `x-goog-user-project: phoenix-hr-2026`; the `1/d/{project}` buckets show `effectiveLimit` and `consumerOverride`. Daily use: Cloud Monitoring `serviceruntime.googleapis.com/api/request_count` for that service. The Cloud Quotas API is not enabled on the project; do not enable it just to read.

**Why:** every map picture is counted against the company's Google account, and until this cap nothing limited it.
**How to apply:** stop telling him the spend limit is his click, it is set. Changing the number is his decision (ask by multiple choice); never put a spend limit in code (`.claude/rules/phoenix-crm-boards.md`). If maps lose their streets on a busy day, read the day's count against 300 before looking for a defect.
