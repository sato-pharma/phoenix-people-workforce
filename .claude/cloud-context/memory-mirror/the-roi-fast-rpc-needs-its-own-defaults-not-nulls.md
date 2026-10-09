---
name: the-roi-fast-rpc-needs-its-own-defaults-not-nulls
description: "Calling phx_marketing_roi_fast with explicit nulls returns an EMPTY report that reads like a broken engine — p_exclude_codes null makes `<> all(null)` drop every row, and the request list is requestReport, not requests"
metadata:
  node_type: memory
  type: project
  originSessionId: fdc61139-f675-4568-a97b-58356ad4027f
  modified: 2026-10-09T01:16:23.547Z
---

`public.phx_marketing_roi_fast` is the fact-table engine behind the Marketing ROI dashboard. Probing
it by hand with positional nulls makes it answer `0` requests and a zeroed summary — which looks
exactly like empty fact tables or a broken switch, and is neither.

Two separate traps, both hit on staging 2026-10-09:

1. **`p_exclude_codes` defaults to `ARRAY['LA003','LA004','SS001']`, not to null.** Passing null
   turns its membership test into `<> all(null)`, which evaluates to NULL — never true — so **every**
   row is filtered out. The same hazard applies to any of the array parameters, which default to
   `'{}'`, not null. Call it with named arguments and let the defaults stand:
   `select public.phx_marketing_roi_fast(p_limit => 500);`
2. **The request list is `requestReport`, not `requests`.** `j->'requests'` is absent, so
   `jsonb_array_length(coalesce(j->'requests','[]'))` answers 0 for a perfectly healthy payload. The
   top-level keys are `summary`, `requestReport`, `productRoi`, `regionRoi`, `lineRoi`,
   `distributorRoi`, `customerImpact`, `roiTrend`, `decisionSummary`, `attributionHealth`,
   `filters`, `limits`, `generatedAt`.

Both produce the *same* wrong reading — an empty dashboard — so one can mask the other. The healthy
staging answer, for comparison: 6 requests, all `awaiting_data`, cost 24,600, spend at risk 0.

**How to apply:** probe it with named arguments and the defaults in place, read `requestReport`, and
before concluding the engine is empty check `marketing_roi_request_facts` row count and which
`refresh_run_id` those facts belong to — the RPC reads the newest run's facts, so a later factless
run blanks the report. Rebuilding is
[[roi-facts-full-rebuild-is-the-no-argument-call]].
