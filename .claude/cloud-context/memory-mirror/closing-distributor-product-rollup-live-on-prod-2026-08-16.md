---
name: closing-distributor-product-rollup-live-on-prod-2026-08-16
description: "phx_closing_distributor_product reads a precomputed units-only rollup — LIVE prod 08-16 (#2171), do NOT undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 56d8ba62-21a5-4519-b4c2-78f60217eeee
  modified: 2026-08-16T02:57:40.625Z
---

`phx_closing_distributor_product(p_line, p_period)` — the Monthly-Closing "Calc" engine that feeds
the Closing Comparison report AND, since [[closing-matrix-fold-live-on-prod-2026-08-15]], the WHOLE
Monthly-Closing matrix — now reads `public.source_of_sales_distributor_product_rollup` instead of
re-scanning the 134k-row `source_of_sales_fact_rollup` every call. **LIVE on prod
(`ozucdzovmcqvepbozvqf`) 2026-08-16, PR #2171, merge SHA `d57e9170`. Do NOT undo.**

**Why:** the old function was a full-fact scan + HashAggregate (~166ms all-cached), and `rpcAll`
re-runs the whole aggregate ONCE PER 1000-row page, so a report cost ~330–590ms. None of the scan
depends on the owner's vocab/price — only on validated fact rows — so it precomputes once per batch.
This is the same pattern as [[closing-channel-rollup-applied-to-prod-2026-08-14]] and the attribution rollup.

**How to apply:**
- The rollup bakes **UNITS ONLY**: `units_qty = Σ total_qty`, `eff_units = Σ effective_units`, per
  `(batch_id, line_key, period, distributor, region, area, product)`. **`factory_price` stays JOINED
  LIVE in the read** (`value = Σ(eff_units × factory_price)`), so editing a factory price still
  reprices all history. **NEVER bake a value/price column** — that is the inverse of the channel
  rollup and the one invariant the equivalence test's headline assertion pins. Math holds because
  every row in a `(distributor,region,area,product)` group shares one product_code, so
  `Σ(eff_units×price) = price×Σ(eff_units)` = the live `Σ(effective_units×price)` to the piastre.
- Keyed per batch (`batch_id` + `on delete cascade`); refresh = delete-by-batch + reinsert; the read
  re-aggregates across a slice's batches. Refreshed AFTER the fact rollup at every "trio" site: the
  DB fns `phx_finalize_sos_batch` / `phx_sync_sos_run` / `phx_backfill_sos_fact_rollup` (all
  CREATE-OR-REPLACEd to add `phx_refresh_sos_distributor_product_rollup`) AND the 4 TS normalizer/
  import call-sites. Do NOT remove any of those refresh calls — a fact-only refresh would leave the
  DP rollup stale.
- Excludes direct orders + restricted codes `LA003/LA004/SS001` at build time (same as the old fn).
- 3 statement-level `phx_reject_write_to_locked_closing('period','official_line')` triggers guard
  ins/upd/del; the backfill runs BEFORE the triggers attach so a locked slice does not block it.
- Read is `stable parallel safe security definer`, EXECUTE revoked from anon/authenticated, granted
  to service_role. Reads go through the SECURITY DEFINER fn only, never the browser.

**Proof (prod, before merge):** old fn vs new fn EXCEPT-diff both directions across all 28 (line,
period) slices = **0 rows different, exact AND to-the-piastre**; 15,373 = 15,373 = 15,373 rows.
Read plan: **166ms full-fact scan → 14.6ms Index Scan** using
`source_of_sales_distributor_product_rollup_line_period_idx` on `(line_key, period)`. Smoke: CNS
2026-05 = 1,950 rows / EGP 8,362,730.04. `check:harden` green; break-the-fix confirmed (adding a
baked `value` column fires the test).
