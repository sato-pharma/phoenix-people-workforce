---
name: search-direct-order-customer-code-trgm-live-on-prod-2026-08-14
description: "phx_search_direct_order_customers sped up by a GIN trigram index on customer_code — index LIVE on prod, do not redo/undo/drop"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-14T19:31:16.601Z
---

The direct-order customer search (`phx_search_direct_order_customers`) was ~1.3–1.4 s per keystroke
because it ORs three predicates on `source_of_sales_customer_map` (52,614 active rows):
`customer_code ILIKE 'q%'`, `customer_code ILIKE '%q%'`, and
`phx_normalize_arabic(customer_name) ILIKE '%q%'`. Postgres only builds a BitmapOr when EVERY
disjunct is indexable; `customer_code` had only a btree `text_pattern_ops` index (cannot serve a
case-insensitive ILIKE), so the planner scanned a covering index and applied the whole OR as a
per-row filter — recomputing `phx_normalize_arabic` over all 52k rows every search.

**Fix = ONE additive index, no function-body change:**
`create index source_of_sales_customer_map_code_trgm_idx on public.source_of_sales_customer_map
using gin (customer_code gin_trgm_ops) where active`. Sibling of the existing
`source_of_sales_customer_map_name_trgm_idx`; same `WHERE active` predicate. All three disjuncts
become indexable → plan flips to BitmapOr. Index is 1.4 MB, valid+ready.

**Proven on prod, byte-identical output** (an index can't change a result set, verified anyway):
`محمد` 1350 ms → **316 ms**, `100` → 19 ms; four ordered-result md5 digests identical before/after
(`bf65c69c` / `fa69d3c3` / `67db7617` / `b483d3fe`, n=30 each).

**LIVE on prod 2026-08-14:** index applied BY HAND first (Railway deploys apply no migrations —
[[railway-deploy-applies-no-migrations]]), so the fast search was serving before the merge. Then
PR #2145 merged squash `df58e3d2`. Migration file
`supabase/migrations/20260814200000_search_direct_order_customers_code_trgm.sql`. **Do NOT redo/undo
— do not drop the index, do not "restore" a btree, do not touch the function body.** Regression guard
`tests/direct-orders-arabic-search.test.ts` pins the index name + `gin_trgm_ops` operator class on
raw `customer_code` + `WHERE active` (break-the-fix confirmed: `text_pattern_ops` fails it).

Same performance campaign as [[vacation-report-cross-request-cache-live-on-prod-2026-08-14]] and
[[attribution-rollup-applied-to-prod-2026-08-14]]. pg_stat_statements was reset on prod
2026-08-14 ~18:52 UTC just before this, so the next profiling pass reads a clean post-fix baseline.
