---
name: closing-channel-breakdown-rollup-applied-to-prod-2026-08-14
description: "phx_closing_channel_breakdown now reads the channel rollup for its fold — LIVE on prod 08-14, piastre-identical; population MUST stay an independent re-read"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-14T03:36:45.091Z
---

**Do NOT redo/undo.** PR #2118 (migration `20260814140000_closing_channel_breakdown_reuse_rollup`)
applied to PROD by hand 2026-08-14 and merged (squash `f9427cd9`, healthz `revision` == `f9427cd9`
confirmed the Railway deploy landed ~43s after merge). The fast-follow to #2115.

`phx_closing_channel_breakdown` used to re-derive each customer's "today's name" and run
`phx_fold_customer_name` PER ROW over ~72k customers, and fold again inside the classifier's two stem
branches (~800ms). It now reads `client_name`/`folded_name` from
`source_of_sales_channel_customer_rollup` (the table #2115 ships and keeps fresh) and the classifier
matches `u.folded_name like '%'||s||'%'` instead of re-folding. **Fold path only** — the keyword +
override lists stay applied live, so the owner's invariant (edit `customer-channel.ts` → all history
reclassifies) holds. Proven output-identical on prod: **58/58 slices, 0 differing** (whole-array
`jsonb` equality vs the preserved old body), both restricted variants, every line/period incl. July's
direct overlay, negative-total (head office 2026-05 = −168.00) and restricted-collapse slices.
Latency 1,594ms → 785ms (buffers hit=20,830). Posture kept: STABLE/PARALLEL SAFE/SECURITY DEFINER,
`search_path=public,au`, `statement_timeout=60s`, grants = postgres+service_role only.

🔴 **TRAP — never "simplify" the `population` CTE to `sum(tagged)`.** It is DELIBERATELY an
independent re-read of `source_of_sales_fact_rollup` + `source_of_sales_import_rows`.
`monthly-closing-export.ts` `breakdownSelfCheck` compares every grid TOTAL against this "Source
tables (EGP)" figure; the guard only has teeth because population does NOT reuse the retail/direct/
tagged path — it is how a missing 4.36M on CNS was once caught. `sum(tagged)` would give the identical
number today while silently neutering the guard. `tests/closing-channel-breakdown-rollup-equivalence.test.ts`
pins this (break-the-fix verified). Sibling: [[closing-channel-rollup-applied-to-prod-2026-08-14]].
Both rest on [[rule1-sos-migrations-applied-to-prod-2026-08-14]].
