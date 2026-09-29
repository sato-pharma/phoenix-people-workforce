---
name: saginko-repriced-retail-from-october-direct-from-today
description: "Owner 2026-09-28: Saginko SA001 to xfactory 170.52 / public 270 / pharmacy 209.52 — direct orders from 28 Sep, RETAIL sales AND targets from 2026-10 only. This is the FIRST period-scoped price in the system; source_of_sales_products.factory_price stays 111.15 and the override lives in source_of_sales_product_price_history, read by phx_factory_price(code, period). Never flat-edit the master to 170.52 — it would restate Jan-Aug by +1.81M EGP including two published months."
metadata:
  node_type: memory
  type: project
  originSessionId: f9250d88-41f8-4421-b2aa-0c24ad73bb62
  modified: 2026-09-28T16:53:21.300Z
---

Owner instruction, 2026-09-28: *"change saginkgo xfactory to 170.52 (distributors) and public price
270 (bonus in direct) and pharmacy price 209.52 … and all orders that will be submitted starting
today with new prices"*, then, asked how far back it should reach: **"the direct orders … price to be
adjusted starting from today; the sales and target of the retail to be adjusted from 1 October"**.

Saginko `SA001` was 111.15 / 180 / 139.68.

## The two halves are scoped differently, on purpose

**Direct orders — live since 2026-09-28.** `public_price` and `pharmacy_price` went onto
`source_of_sales_products` that day. A direct order snapshots its own price at submit
(`public_price_snapshot` / `pharmacy_price_snapshot`), so all 20 existing SA001 orders keep
180/139.68 and anything submitted from that day prices at 270/209.52. A **returned** order that is
resubmitted reprices at today's basis — deliberate, and documented in `resubmitDirectOrder`. The
factory price is still banned from that module entirely
([[direct-order-pricing-rule-locked]]).

**Retail — from period `2026-10` only.** 🔴 **`source_of_sales_products.factory_price` STAYS
111.15.** Do not "finish the job" by typing 170.52 into the Product Master screen: the closing
engine values every month as `units × the CURRENT factory price`
([[a-price-fix-silently-restates-every-published-closing]]), so a flat edit restates
**+1,814,407 EGP** across Jan–Aug — **+194,852 on July and +177,101 on August, both published and
locked**, which is exactly what "a published and announced month is never corrected" forbids.

## How it is actually done

`public.source_of_sales_product_price_history (product_code, effective_period, factory_price, …)`
holds one row: `SA001` from `2026-10` at 170.52. `public.phx_factory_price(product_code, period)`
reads it and **falls back to the master price when no override covers that period** — so every other
product is valued exactly as before and the owner's 2026-08-14 "current price values all months"
ruling still governs everything with no override row. This narrows that ruling; it does not replace
it. 31 functions were repointed at the resolver (closing + detail surfaces, attribution/achievement,
sales dashboards, exec surfaces, customer/territory, market awareness, marketing ROI). Applied to
staging and production 2026-09-28; **34 line×period cells compared before and after, 0 moved,
0.00 EGP.** PR #4630, merged `07439c4de` 19:42 Cairo and **SHIPPED** — live revision contains it,
main's CI green.

🔴 **The repoint ships as ONE MIGRATION FILE PER FUNCTION, and that is not cosmetic.** Several
guards in `tests/` resolve "the newest migration that DEFINES function X" and then read that WHOLE
FILE, so a bundle of 31 makes one function's SQL answer for another's — `territory-units-effective`
failed on a `sum(f.total_qty) as units` belonging to `phx_closing_brick`, four functions away. Two
sibling traps from the same night: `au-seat-occupant-resolver` extracts a body behind
`kind === "function"`, a **case-SENSITIVE** compare, so `pg_get_functiondef`'s uppercase `CREATE`
cut the body at the first semicolon (594 chars of 6,931) and hid a call the function makes twice —
**write migration SQL lowercase**; and the closing-corrections guards assert grants with identity
args as **types only** (`(text)`), not the named form
`pg_get_function_identity_arguments` returns. 🔴 **And before any repo-wide expression sweep, grep
the TESTS for the exact old string** — three CI rounds were lost here to pins that encode the
old formula, two of them found only by sweeping every test that pins the touched surface (27 SQL-side
+ 27 TS-side) rather than fixing whatever CI named that round.

🔴 **The TARGET side is half the change, and it is the half that touches money.**
`au.monthly_targets.target_value` is **stored** while sales value is recomputed live, and
`au.f_monthly_achievement` divides one by the other. A target authored at 111.15 against sales at
170.52 inflates Saginko's achievement by **53%**, on the number the incentive scheme reads. Q4
targets were not loaded yet, so the fix is in the authoring path: `loadProductPriceMap(period)` and
`loadTargetableProducts(lineCode, period)` now take a **required** period (required so the compiler
names every call site), resolving through `src/lib/sales/product-period-price.ts`. **When Q4 targets
are loaded, Saginko's October–December target value must be units × 170.52.**

Deliberately NOT repointed: `import_marketing_request_atomic` and `phx_marketing_roi_fast` (read a
stored snapshot), `phx_market_awareness_products` (shows today's price on purpose),
`phx_record_factory_price_restatement` (audits a master-price edit, which is not period-scoped).

Related: [[sos-monthly-closing-is-the-only-sales-truth]] ·
[[never-fix-a-published-and-announced-month]] ·
[[closing-pre-july-revalue-and-backfill-targets-at-phoenix-price]]
