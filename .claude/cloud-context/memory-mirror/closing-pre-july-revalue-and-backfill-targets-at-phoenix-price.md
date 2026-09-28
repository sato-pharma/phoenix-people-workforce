---
name: closing-pre-july-revalue-and-backfill-targets-at-phoenix-price
description: "Owner ruling 2026-08-14: every pre-July (Jan-Jun 2026) manual closing is VALUED at Phoenix's CURRENT source_of_sales_products.factory_price for BOTH sales and target units (NOT the manual's historical price - achievement=sales/target is price-invariant, only EGP value shifts, so a side-by-side vs the manual differs BY DESIGN, do not 'fix' back), and its target units are BACKFILLED into the empty au.monthly_targets via phx_upsert_monthly_targets. Jan and Feb are DONE for all three lines - do not redo/undo; Mar-Jun follow the same recipe. Reusable methods: normalized-pharmacy-code retail reconciliation, CNS split-by-actual-sales-share (no 1:1 area map), atomic RAISE-rollback booking, and the mandatory official_line filter on any reverse."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e908adcc-abd2-4e16-9fb1-92d5cb0eeff1
  modified: 2026-09-25T23:23:09.468Z
---

Owner ruling 2026-08-14, while training on monthly closings. Two rules for **every pre-July
(Jan–Jun 2026) manual closing**:

1. **VALUE at Phoenix's CURRENT `source_of_sales_products.factory_price` for BOTH sales units and
   target units** — "our factory price / our known policy", NOT the manual's historical price.
   **Achievement = sales ÷ target is INVARIANT to the price (it cancels),** so only the EGP *value*
   shifts — a value shown side-by-side vs the old manual differs **by design; do NOT "fix" it back.**
   Owner rejected both matching the manual's value and adding period-scoped prices. Price anchors that
   recur: **Saginko `SA001` = 111.15** (manual had 126.72; the 2026-08-11 realignment 126.72→111.15
   stands for all months), Royafloxacin `RO001` ≈ 60.75, **Lacto `LA001`/`LA002` = 270** (manual
   priced 225.06), Ivyronc `IV001` = 30.375 regular but **14 Military, Main Store only**
   ([[ivyronc-military-price-is-14-main-store-only]]).

2. **BACKFILL the empty historical targets.** `au.monthly_targets` had NO Jan–Jun rows (only
   Jul/Aug/Sep). Take **target units per product** from the manual `Total` sheet × Phoenix price =
   target value, and upsert via **`phx_upsert_monthly_targets(p_rows jsonb, p_actor, p_source)`**.
   That function is a plain insert-on-conflict — **NO `carries_target` or line/area-map validation in
   its body, and no product FK at all;** the only guardrails are the `area_code`/`line_code` FKs to
   `au.canonical_areas`/`au.lines`, so **the caller must map areas correctly.** The engine that
   surfaces it: `phx_monthly_targets` + `au.f_monthly_achievement` → `phx_monthly_achievement` → the
   Targets/achievement grid. 🔴 The closing's `analytics.closing_fact` reads a **DIFFERENT** target
   (`sales_records.target_*`) — not this table.

## Area mapping (pre-July non-unification)

Manual `Total`.`Sys` (old area name) → canonical by name-match; the hard cases are already ruled by
**`au.area_migration_map`** (Dakahlia 4→D23 merge, Sharkia 3→D25, Faisal & October / Haram → Giza).
Anti-infective has **35** `carries_target` canonical areas (incl `CA2` Nasr City, `CA6` Cairo West,
`GZ2` Dokki-Mohandseen, `GZ4` Haram-Faisal); **July only used 30, so never assume the July subset is
the whole set — read `au_v_line_area_map`.** Heal Quick is excluded from targets, as from sales. See
[[closing-reconcile-per-customer-product-not-area-pre-july]].

🔴 **CNS is the exception — do NOT force an area→area map.** The CNS manual's `Sales Closing`
geography is coarser and partly COMBINED (Dak-Sharkia-P.D, Ghar-Menoufia-Qal, Ismailia-Suez,
Luxor-Aswan, Alex-BHR-KFS, … plus Main Store / Others / Cairo Others / Upper Egypt buckets) and does
not map 1:1. Owner ruling **"split by actual sales share":** distribute each product's manual GRAND
target across Phoenix areas by that product's **positive-part-normalized actual sales share**
(weight = `greatest(net_units,0)` ÷ per-product sum, so shares sum to 1 with no negative target); a
product with a target but zero actual sales splits by its **therapeutic-family** actual share.

## Reusable methods for the remaining months (Mar–Jun, all lines)

- **Retail residual → reconcile by NORMALIZED PHARMACY CODE (strip leading zeros), IGNORING area.**
  The area-level deltas are pure pre-July non-unification scramble — a red herring. Phoenix
  `client_code 0001583229` == manual `Pharmacy Code 1583229`; match the pharmacy sets, then the
  residual is a clean add-only per pharmacy×product at Phoenix price.
- **Book offset rows ATOMICALLY in one DO block that RAISEs (rolls back)** unless per-product +
  per-family/channel + grand total all equal the manual. Tag `raw_row->>'source'='manual-closing-<period>'`,
  row_number above each batch's max, then refresh the batch rollups
  (`phx_refresh_sos_fact_rollup`/`_channel_rollup`/`_customer_directory_rollup`). Distributor family
  folds: POS→PS, IBNSINA→IS, STORES→Office, EGD→EG, RAMCO→RM, SOFICO→SF, MEC→MC, EPDA→EP,
  CHIMIPHARM→CP; tender channels fold into their parent (PS-T→POS, IS-T→IBNSINA, EG-BR/EG-HOS→EGD).
- **Direct-sales reconciliation is the paired half** of the sales side
  ([[direct-orders-pre-july-from-manual-post-august-from-phoenix]]); Stores→Office, `is_direct` set
  per channel.

## File/data traps when reading a manual

- 🔴 **Feb month-label trap:** the Feb file's `Total` sheet `Month` column says "Jan" but the data IS
  February (verify against a known cell, e.g. a Heliopolis Saginko value, before trusting the label).
- **Filenames carry stray double spaces** before `.xlsx` (`… Final  .xlsx`) — match literally.
- **Manual `Total` mislabels RO001's family as "Dolabactin"** — a quirk; the numbers tie to RO001
  (Royafloxacin), so Dolabactin-family → RO001. Count today-active products only (exclude Head-Office
  Lacto LF/Basic, Tigogrow, Dolabactin/Tebofortine, etc.).

## Status and reversal

**Jan and Feb are DONE for all three lines (Anti-Infective, Pedia, CNS), unit-exact and
per-product/channel-exact at Phoenix price, 2026-08-14 — do NOT redo or undo them.** Mar–Jun remain,
by the recipe above. Full per-month execution record (exact tallies, batch ids, row numbers) is in
the scratchpad ledger `closing-ingest-ledger.md`.

**General reversal** (a specific month×line, if ever needed) — 🔴 the `official_line` filter is
MANDATORY because one batch carries several lines under the same source tag:
```sql
delete from source_of_sales_import_rows
 where invoice_period='<P>' and official_line='<Line>' and raw_row->>'source'='manual-closing-<P>';
-- then refresh that line's batch rollups (fact/channel/customer_directory)
delete from au.monthly_targets
 where period='<P>' and line_code='<line_code>' and source='manual-backfill-<P>';
```

Related: [[closing-reconcile-per-customer-product-not-area-pre-july]] ·
[[closing-retail-value-is-units-times-factory-price]] · [[sos-monthly-closing-is-the-only-sales-truth]]
