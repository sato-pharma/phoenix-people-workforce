---
name: main-store-otms-is-a-real-area-outside-the-organogram
description: "Main Store (OTMS) unmapped sales were NOT missing knowledge - all 122 customers already had an active customer_map brick; the gap is an unapplied backfill, and monthly_closing_locks blocks fixing it"
metadata:
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-08-27T00:27:08.118Z
---

**`OTMS` = "Main Store", region_name "Others" on the sheet.** A REAL area the distributors write,
but `au.sos_area_crosswalk` has no row for it (it holds `OT1`…`OT10`), so `canonical_area_code`
resolves NULL and the row lands `channel='unmapped'`, `unmapped_reason='blank_area'`. That reason is
a lie — the area code is *present but unrecognised*. Filtering `nullif(btrim(area_code),'') is null`
returns EMPTY; join `au.sos_area_crosswalk` to find these.

## THE HEADLINE, 2026-08-27: this was never a mapping question

**All 122 unmapped customers ALREADY had an active `source_of_sales_customer_map` row with a real
brick.** Measured: `no_map_row_at_all = 0`, `mapped_and_active = 122`, `row_but_inactive = 0`,
`row_but_blank_brick = 0`. The knowledge was in the system the whole time.

The gap is an **unapplied backfill**, not missing information: 156 of 188 `source_of_sales_import_rows`
for those customers still carried a blank `brick_id`, and `source_of_sales_fact_rollup` is a
materialised copy of the import row, so it inherits the blank. The July sheet simply relabelled
customers as "Main Store" that earlier months had named correctly, and nothing re-derived them.

**Do NOT build a classification sheet for this, and do NOT create bricks for it.** A decision XLSX
with 122 rows was built and sent before this was checked — it was worthless, and the owner was right
to be angry. **Check `source_of_sales_customer_map` FIRST, before reading a single address.**

The fix is the app's own path, per customer + distributor:
`sos_backfill_import_rows_from_customer_map(p_distributor, p_customer)` → then refresh, per affected
batch, in this order: `phx_refresh_sos_fact_rollup`, `phx_refresh_sos_customer_directory_rollup`,
`phx_refresh_marketing_roi_facts`, then `phx_refresh_sos_channel_rollup`,
`phx_refresh_sos_distributor_product_rollup`, `phx_refresh_monthly_attribution` (all take
`p_batch_id uuid`). Mirrors `backfillCustomerRows` in `src/lib/sales/normalizer/mapping.ts`.

**That RPC is safe by construction** — `and (r.brick_id is null or r.brick_id = '')`. It fills a
MISSING brick and can NEVER re-point an existing one (re-pointing is
`sos_reconcile_import_rows_from_customer_map`'s job). So it cannot move a sale already credited to
somebody. Verified on the 10 rows applied: every `area_before` = `area_after`.

## THE CODE CAUSE, found 2026-08-27: the cross-area guard fired on a non-place

The import did not "forget" to apply the map — it **refused** to. `monthly-distributor-import.ts`
fills a blank brick from the customer map behind a **cross-area guard**: a stored mapping pointing
outside the area the sheet typed is rejected, so an unverified mapping can never move a rep's
numbers. Correct, and it stays. But the July sheet typed area `OTMS`, the map pointed at real bricks
in OT5/OT8/OT4/OT1/OT10, `OTMS !== OT5`, so the guard rejected **every Main Store row** and the brick
stayed blank. `source_of_sales_fact_rollup` is a materialised copy of the import row, so it inherited
the blank. Measured: 109 customers with `sheet_area = OTMS`, `guard_would_fire = true`, all with map
rows created BEFORE the 2026-08-06 import. The other 3 (CA3 ×2, D24 ×1) had `guard_would_fire = false`
and maps created 2026-08-26 — no mapping existed at import time, a different and harmless case.

**Fixed in PR #2440**: an area that owns **no brick in the master** is not a territory, so there is
nothing to cross — treat it like a blank area, take the mapping in full, and take the brick's real
area and region with it. A real area that owns bricks is still guarded, unchanged. The predicate is
narrow by measurement: **exactly two** areas own zero active bricks — `OTMS` (131 fact rows) and
`OT3` Aswan Legacy (0 rows). It cannot degenerate into "guard off": the auto-fill only runs once
`brickById` already resolved a brick, so an empty brick reference set skips the block entirely.
`au.sos_area_crosswalk` was REJECTED as the signal — it lives in the `au` schema and the import path
never loads it. Pinned by `tests/sos-warehouse-area-does-not-block-brick-fill.test.ts`, proven by
sabotage.

## `monthly_closing_locks` is a HARD trigger, not a flag

`phx_reject_write_to_locked_closing()` raises `23514` on ANY write touching a locked `(line, period)`
— *"No row may be added, changed or removed for it - this includes migrations and direct SQL."*
The whole statement rolls back, so a 122-customer batch fails atomically because of one locked line.
**Scope the work by lock before running it**: `select ... from monthly_closing_locks where
unlocked_at is null`, and exclude any customer whose rows touch a locked pair. Locked as of
2026-08-27: **Anti Infective / CNS / Pedia, all 2026-07**. CNS was re-locked 2026-08-26 22:17 Cairo
by `ez-even-split-dpr-repair-2026-08-26` — the `locked_by` string is how sessions record who and why,
and `owner-approved-…` in that column is the convention for an owner-sanctioned unlock.

**Applied 2026-08-27: 10 February rows** (2 batches, rollups refreshed) — February is now fully
mapped, including the **−607,500 EGP Pedia return**, which took brick `B205-13` الحي السابع in CA2
Nasr City, the area it already sat in. Reversal snapshot: `au.zz_brick_backfill_snapshot_20260827`
(166 rows) — kept in `au`, NOT `public`, because a `public` backup table is anon-readable.

**CNS July is CLOSED, not pending — do NOT map it.** Its 112 customers / 134 rows / EGP 47,385 stay
exactly as published. The owner ruled 2026-08-27: *once a closing is published and people have
noticed the numbers, never change them — start from August.* So do not unlock CNS 2026-07, do not
run the backfill on it, and do not read the lock as an obstacle to route around. The fix is the code
change below, which stops the NEXT upload producing blanks; the frozen months stay frozen. Full rule:
[[sos-monthly-closing-is-the-only-sales-truth]].

## The brick catalogue is FINE — an earlier claim here was wrong

A previous pass recorded "OT5 has exactly ONE brick, no Safaga, no El Quseir" and concluded new
bricks had to be created. **Wrong — it conflated two areas.** Hurgada is `OT5` (1 brick, الغردقة);
the Red Sea governorate is `OT8`, which already holds سفاجا, القصير, شنيشن-القصير and
ش6 اكتوبر-البحرالاحمر. Nothing needed creating.

## THE TRAP: `brick_id` is an EMPTY STRING, not NULL

**`where brick_id is null` silently misses 199 rows worth EGP 9,176,422.** `source_of_sales_fact_rollup`
stores `''` for "no brick", so a null-check reports those rows as *mapped*. Always test
`nullif(btrim(coalesce(brick_id,'')),'') is null`. Same for `client_code`. This is exactly how a
first pass measured 99.94% brick coverage and had to be corrected.

## Chain integrity, measured 2026-08-27 (production `ozucdzovmcqvepbozvqf`)

The brick→area→region chain is **clean**: 697 active bricks, **0** with no area, **0** with no
region, **0** whose area is missing from `au.line_area_map`, **0** areas without a region.

Everything lacking a brick beyond the 122 is an **area-level row with no customer at all** — 1,420
rows, EGP 11.64M — Office allocation, DIRECT region-level orders, and returns. Those can never carry
a brick and are **not a fault**.

Two useful resolution signals when a customer genuinely is unknown, in order of strength: (1) the
customer's **own earlier months** in `source_of_sales_import_rows` — that named the area for 9 of 15
hard cases; (2) the distributor's **client-code block**, since codes are issued by route (the 3536xx
block was 65% North Sinai and the streets corroborated Arish). Only 6 customers, EGP 1,924, have
never been seen anywhere but Main Store.

Still open: Anti Infective DIRECT rows are tagged region `UE` in some months and `UE-1`/`UE-2` in
others.

Related: [[sos-bricks-are-the-authority-for-branch-to-area]],
[[the-sales-geography-has-no-governorate-layer]],
[[address-matching-beats-paid-ai-and-geocoding-hurts]],
[[sos-monthly-closing-is-the-only-sales-truth]],
[[ungraded-sales-have-three-causes-only-one-is-big]].
