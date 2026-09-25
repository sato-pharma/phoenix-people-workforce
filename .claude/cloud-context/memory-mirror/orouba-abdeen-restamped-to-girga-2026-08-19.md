---
name: orouba-abdeen-restamped-to-girga-2026-08-19
description: "APPLIED TO PROD 2026-08-19 — صيدلية العروبة - عابدين ruled ONE shop in Girga; both its codes (IS 421516 + PS 0001511327, 507 units) restamped Sohag 1 → Sohag 2 across four SoS layers, with July unlocked and relocked"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3feca446-024a-4d2e-8f90-fe2a4611a626
  modified: 2026-08-19T16:29:54.147Z
---

**Applied to production 2026-08-19 on the owner's ruling — "it's one shop, keep Girga, move them
too and unlock July". Do not undo.** Backup schema `orouba_restamp_backup_20260819` holds the
pre-image of every touched table (`fact_rollup_pre` 19 / `import_rows_pre` 23 /
`directory_rollup_pre` 19 / `customer_map_pre` 3 / `ps_fact_pre` 48 / `ps_import_pre` 74 /
`ps_directory_pre` 48 / `dpr_pre` 637 / `locks_pre` 4), anon+authenticated revoked.

`صيدلية العروبة - عابدين` is ONE shop that two distributors registered separately, both at
ميدان العروبة:

| Code | Master name | Was | Now |
| --- | --- | --- | --- |
| Ibn Sina `421516` (IS + IS-S) | المتحدةشركة صيدليات عابدين فارما | split 43 Girga / 60 Sohag City | **103 Girga** |
| POS `0001511327` (PS) | احمد عزت - سوهاج | 404 Sohag City | **404 Girga** |

Everything now sits on `B165-3` جرجا / `UE6` / `UE`: **507 units, 67 fact rows, 67 directory rows,
97 import rows**, and all three map rows at confidence 100.

**The `421516` map rows never needed an edit** — they already said Girga from
`owner-file-okm-2026-08-11`. Same lesson as
[[placement-rulings-and-office-reimport-applied-2026-08-12]]: **a placement fix is a rollup
re-stamp, not a mapping edit.** The three fact layers each disagreed with the map *and with each
other* (fact 43/60, import 90/13, directory 27/76). Only the PS row was genuinely re-mapped
(`source = owner-ruling-orouba-one-shop-2026-08-19`).

**Layers that must all move together — there are FOUR, not three:**
`source_of_sales_fact_rollup`, `_import_rows`, `_customer_directory_rollup`, and
`_distributor_product_rollup`. The last one has **no `client_code`** — it is keyed
`(batch_id, line_key, period, distributor, region, area, product)`, so a customer move has to be
applied as a per-product delta: decrement the UE5 row, increment or insert the UE6 row. It also
**excludes restricted codes `LA003/LA004/SS001`** at build time, so 11 Head Office keys correctly
had no row to shift — join the UE5 row when inserting and the exclusion takes care of itself.
`_channel_customer_rollup` carries no geography at all; nothing to do there.

**Conservation, proven twice.** UE5+UE6 held **10,506 rows / 90,998.881164 units** before and
after (UE5 −62 rows / −464 units, UE6 +62 / +464 across the two passes). The distributor/product
rollup held **45,796.881164** units before and after, +1 row (one genuine new UE6 key). Pre-existing
negative rows: 12 before, 12 after — none created.

**July: unlocked and relocked, totals byte-identical.** `2026-07` was closed for Anti Infective,
CNS and Pedia, and `phx_reject_write_to_locked_closing` guards **five** tables. Used the real RPCs —
`phx_unlock_monthly_closing(line, period, actor, reason)` then `phx_lock_monthly_closing(line,
period, actor)`. **Re-locking INSERTS a new lock row and re-snapshots from the live rollup**, so the
snapshot is the proof: Anti Infective 7017.000000 / 1491 cells, CNS 105151.999996 / 17281, Pedia
11552.000000 / 1279 — identical before and after. Line totals never moved; only the area split did.
Note `phx_lock_monthly_closing(...) is not null` returns **false** on success (a fresh lock has NULL
`unlocked_at`), so never test the result that way — read `monthly_closing_locks` instead.

Marketing side re-resolved afterwards: both codes on pharmacy
`77bdcc14-1429-4281-8acb-0095d712f4dd` now read `mapped_area_code = UE6` / `B165-3`, `exact`. The
live request `MKT-REQ-20260818-8C628BF4` (customer انجي جاد) is still `pending_approval` and was not
touched.

**Do NOT repair a layer disagreement by calling `phx_refresh_sos_*_rollup(p_batch_id)`.** Those
rebuild a whole batch from `import_rows` and would silently re-verdict every other customer whose
rollup is stale the same way. Re-stamp the specific customer.

**Office allocation deliberately NOT re-run — owner's decision 2026-08-19, do not "fix" it.**
The Office spread for UE5/UE6 is stale by the 464 units of non-Office value that moved. Measured
before deciding: the whole correction is **~81 units** shifting Sohag 1 → Sohag 2 across all seven
months (CNS 7.3 / 3.7 / 5.8 / 8.0 / **39.1** / 3.9 / 11.9 for Jan–Jul, Pedia Jan 1.7) — **0.59% of
the ~13,700 Office units those two areas hold**, with every other area provably unmoved because the
line's total value never changed. Shown that number, the owner chose to leave it. If a later session
re-measures and re-proposes this, the answer is already no.

Two things that blocked doing it cheaply, worth knowing: **there is no re-run-from-DB path.**
`commitOfficeAllocation` (`src/lib/sales/office-upload.ts`) is the only entry point and it needs the
owner's Office **pivot workbook per period** — one file per month, carrying every line at once. The
area weights come from `phx_office_brick_share(period)` in the DB, but the national units per
product come from that file, and no Office workbook lives in `xlsx/`. Rebuilding those totals from
the existing Office rows is arithmetically sound (the allocation conserves per-product totals), but
it means authoring a bespoke production write path around the one calculation the repo mechanically
locks. See [[owner-office-allocation-rule-value-share]] and
[[office-golden-rule-is-mechanically-locked]].

Related: [[marketing-master-resolver-never-runs-automatically]] (how the two codes were found),
[[sos-bricks-are-the-authority-for-branch-to-area]],
[[moving-a-sos-brick-between-areas-needs-four-restamps]].
