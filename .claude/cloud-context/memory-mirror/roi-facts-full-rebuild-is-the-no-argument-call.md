---
name: roi-facts-full-rebuild-is-the-no-argument-call
description: "phx_refresh_marketing_roi_facts(<any uuid>) rebuilds NOTHING and reports success — the full rebuild is the bare no-argument call, and passing a batch id also mislabels the run as sos_import"
metadata:
  node_type: memory
  type: project
  originSessionId: fdc61139-f675-4568-a97b-58356ad4027f
  modified: 2026-10-09T01:16:11.352Z
---

`public.phx_refresh_marketing_roi_facts(p_batch_id uuid default null)` has two branches, and the
argument you pass decides which — a success with `affectedRequests: 0` is the usual sign you picked
the wrong one.

- **`p_batch_id is not null`** → it reads `source_of_sales_import_rows where batch_id = p_batch_id
  and validation_state = 'valid'` to derive the affected periods. A uuid that is not a real
  validated import batch (for example `gen_random_uuid()`) finds no rows, leaves `v_affected_ids`
  empty, and takes the early return: it writes a `success` run row and
  `{"affectedRequests": 0}` **before any delete**, so nothing is rebuilt and nothing is harmed.
- **`p_batch_id is null`** (the bare call, `select public.phx_refresh_marketing_roi_facts();`) →
  `v_affected_ids` becomes **every** `marketing_requests` row with a `pay_date`, and the facts are
  deleted and rebuilt wholesale. Measured on staging 2026-10-09: 21 requests, 10 products,
  4 regions, 4 lines, 6 distributors, 7 customers, 2 trends.

**Why it matters beyond the wasted call:** `triggered_by` is derived from the same argument —
`case when p_batch_id is not null then 'sos_import' else 'admin_manual' end`. So a hand-run with a
made-up batch id lands in `marketing_roi_refresh_runs` labelled **`sos_import`**, a false record
that a later reader takes for a real import, and it becomes the newest run — which is what the
dashboard's `freshness.lastRefreshedAt` reports, so staging read "fresh" while its facts were from
19 August. Related: [[the-roi-fast-rpc-needs-its-own-defaults-not-nulls]].

**How to apply:** to rebuild the ROI facts by hand, call it with **no argument**. Pass a batch id
only when you have a real validated `source_of_sales_import_batches` row and mean to simulate that
import. Read `affectedRequests` before believing a `success`, and read the newest run's
`triggered_by` before reporting that an import refreshed anything.
