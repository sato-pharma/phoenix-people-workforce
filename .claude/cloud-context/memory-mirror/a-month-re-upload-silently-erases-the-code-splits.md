---
name: a-month-re-upload-silently-erases-the-code-splits
description: Re-uploading a month replaces its rows, so every `-2` code split is wiped while the customer map keeps its `-2` rows; re-derive by matching the row's client_name to the split map row's customer_name, and the 24 September rows come back exactly.
metadata:
  type: project
---

His four September re-uploads on 2026-10-10 (EP-PHS 14:30, IS 14:32, EP-BK 14:34, Office 14:38
Cairo) left **0** September rows carrying a `-2` client_code while
`source_of_sales_customer_map` still held **16** active `-2` rows — the split survives in the map
and dies in the rows, with nothing anywhere reporting it.

**Re-deriving is exact, not a guess:** each split map row's `customer_name` is the intruder
pharmacy's name as the distributor sheet spells it, so
`join on left(customer_code, length(customer_code)-2) = r.client_code and customer_name = r.client_name`
reproduced yesterday's 24 rows / 15 codes / 938.25 EGP Pedia on the first attempt (code 22198955
has no September rows at all, so 16 map rows → 15 codes).

After re-stamping, `sos_reconcile_import_rows_from_customer_map('EP-PHS', '<code>-2')` re-points all
24 (one batch), and the rollup chain must be rebuilt in the order
`refreshBatchRollups` uses. 🔴 **Only `writeStoreSplitNetForBatch` has no SQL equivalent** — it is
TypeScript, `phx_write_monthly_store_split_net` takes precomputed rows — so a repair driven from SQL
alone leaves `au.monthly_store_split_net` stale and Sales vs Target out against the live closing by a
few EGP per affected area (measured Alex West Pedia: rollup 40,908.84 vs live 40,921.52). National
totals stay exactly conserved either way (Pedia 2,786,791.65 both ways).

Related: [[septembers-epda-code-splits-are-complete]] · [[epda-pharmacies-22199672-was-split-into-two-pharmacies]] ·
[[a-code-split-gives-the-new-code-to-the-unlocked-pharmacy]] · [[a-timed-out-reconcile-refresh-is-never-retried-by-re-running-it]]

**The net IS rebuildable without the TypeScript chain — `scripts/backfill-attribution-store-split.ts
--apply <period>` is the one path**, and it is idempotent. 🔴 **It REFUSES from a tree behind
`origin/main`** (exit 69, "this tree is 7 commit(s) BEHIND") because it recomputes the rule from the
code it runs in; `PHX_STALE_TREE_OK=1` stands that down, and it is only honest to use after checking
that the rule's own files — `attribution-store-split-net.ts`, `attribution-store-split-refresh.ts`,
`closing-store-split-net.ts`, `office-distributor.ts`, `office-allocation.ts`,
`monthly-closing-details.ts`, `closing-organogram-regions.ts` — are byte-identical to `origin/main`.
Proven by `scripts/check-store-split-drift.ts`, which answered "no drift, 732 frozen cells match the
rule" on 2026-10-10, after which the live closing and `au.f_sales_vs_target_range` agreed to the cent
on all four repaired areas. Related: [[a-rebuilt-net-goes-stale-when-an-upload-is-withdrawn]].
