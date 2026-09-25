---
name: marketing-requests-prod-wipe-restore
description: "Prod marketing requests were wiped 2026-06-24 and restored from backups/json on 2026-06-28; how to redo it."
metadata: 
  node_type: memory
  type: project
  originSessionId: aebaa85c-e5f9-4fe9-9978-a415bdad5184
---

Production marketing **requests** were wiped on **2026-06-24** (deliberate pre-go-live reset — a `backups/production-wipe-ozucdzovmcqvepbozvqf-2026-06-24T22-00-36/` snapshot was taken first). On **2026-06-28** they were restored from local JSON backups.

**What was restored (prod `ozucdzovmcqvepbozvqf`):** 218 `marketing_requests` (109 approved / 94 pending / 15 rejected, REQ-0001…, dates 2026-01-12→06-19), 318 `marketing_request_products`, 361 `marketing_request_pharmacies`, 552 `marketing_request_approval_steps`, plus 1 missing customer (`omaaar`, id `e1b3cfa3-…`) that prod had lost. Then `SELECT phx_refresh_marketing_roi_facts(NULL)` rebuilt the ROI fact tables (request 109, customer 125, product 42, line 16, region 36, distributor 17, trend 7).

**Source of truth for recovery:** `backups/json/marketing_*.json` (identical copy in the production-wipe folder). The original `ROIxx.xlsx` requests sheet is gone — `*.xlsx` is gitignored, so it only ever lived locally.

**Gotchas when restoring (cost a failed first attempt):**
- Convert empty-string `''` → NULL for every column (the JSON export wrote NULLs as `""`; FK/date/numeric cols reject `""`).
- EXCLUDE generated columns from inserts: `marketing_requests.required_roi_value`, `marketing_requests.roi_coverage_ratio`, `marketing_request_products.expected_value` (GENERATED ALWAYS — DB computes them).
- No triggers on these tables, so raw inserts are safe (no duplicate approval-step generation).
- Restore script + dry-run validator: session scratchpad `restore-prod.cjs` / `dryrun-validate.cjs` (connect via `.env.local`, which points at PROD).

Related: [[revert-2026-06-21-full-day]], [[one-prod-deploy-per-task]].
