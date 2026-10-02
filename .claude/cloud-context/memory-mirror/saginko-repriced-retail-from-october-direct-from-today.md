---
name: saginko-repriced-retail-from-october-direct-from-today
description: "Owner 2026-09-28: Saginko SA001 to xfactory 170.52 / public 270 / pharmacy 209.52 — direct orders from 28 Sep, RETAIL sales AND targets from 2026-10 only. This is the FIRST period-scoped price in the system; source_of_sales_products.factory_price stays 111.15 and the override lives in source_of_sales_product_price_history, read by phx_factory_price(code, period). Never flat-edit the master to 170.52 — it would restate Jan-Aug by +1.81M EGP including two published months."
metadata:
  node_type: memory
  type: project
  originSessionId: f9250d88-41f8-4421-b2aa-0c24ad73bb62
  modified: 2026-10-01T04:27:43.702Z
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

🔴 **The TypeScript half of the closing was missed, and fixed 2026-10-01 (PR #5019, merged
`b248a693a`).** The 31 repointed functions are all SQL. `loadMonthlyClosingDetails` (Details tab,
export Data/Total sheets, premium Detail sheet, live store-split money) and Source Coverage
(`aggregateCoverage`) still read the product master's flat price, so the first October file would have
shown Saginko at 111.15 beside a Matrix at 170.52 — 177,100.71 short at August's 2,983 units. Both now
price through `loadProductPeriodPrices()`: Details at the CLOSING month (the batch period, which is the
Matrix's `f.period`), Source Coverage at each row's own month. Re-pricing every validated row Jan–Aug
moved 0.00. **Any TypeScript that turns units into EGP for a period must use `priceFor(code, period)`
— a direct read of `source_of_sales_products.factory_price` is this bug.** The persisted
`au.monthly_store_split_net` stores units only, so it was never at risk.

**Two more TS surfaces, 2026-10-01.** The importer's STORED `source_of_sales_import_rows.value`
(parser + Normalizer engine) prices each row at its own month — #5030, which shipped inside roll-up
#5033 (`57176b029`), not on its own. Weekly reports (dashboard + Combined Report) price each row at the
dated price of its CYCLE month, else its week's month — owner asked 2026-10-01, PR #5045. 🔴 **OFFICE
IS THE ONE EXCEPTION, ON PURPOSE:** `office-allocation.ts` (locked) values Office at units × the
MASTER price in every month, so anything comparing Office across months (the re-dated duplicate-upload
guard, `repriceableUploadRow`) must keep Office at face value — re-pricing it lets a re-dated Office
file walk past the guard. Latent while Office stays CNS-only with no CNS dated price.

**The last four surfaces, found by a full sweep 2026-10-01 (PR #5054):** `analytics.sos_fact` and
`sos_fact_all` (the CEO command center's IMS panel) valued every month at the flat price — migration
`analytics_sos_fact_dated_price` APPLIED to staging and production that day, Jan–Sep identical to the
cent. 🔴 **A VIEW must INLINE the dated lookup, NEVER call `phx_factory_price`:** its EXECUTE is
`service_role`/`postgres` only and a view runs functions with the READER's rights, so
`analytics_readonly`/`analytics_privileged` would break (`au.f_monthly_attribution` and
`phx_closing_customers` inline it too). 🔴 **The targets TEMPLATE priced a whole span at its FIRST
month** — a semester Jul–Dec stored Oct–Dec Saginko targets at 111.15 (achievement +53%); it now
prices each row at its own Period (a dated `Product|YYYY-MM` table on the Lists sheet). Weekly stock
value and the ROI near-miss figures were fixed in the same PR. Everything else that reads the master
price was classified: master-data screens, types, deliberate snapshots, Office (locked), or period-priced
upstream. A target typed by hand into an uploaded sheet is stored exactly as typed.

Related: [[sos-monthly-closing-is-the-only-sales-truth]] ·
[[never-fix-a-published-and-announced-month]] ·
[[closing-pre-july-revalue-and-backfill-targets-at-phoenix-price]]
