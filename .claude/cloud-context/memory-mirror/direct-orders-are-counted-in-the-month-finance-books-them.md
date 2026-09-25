---
name: direct-orders-are-counted-in-the-month-finance-books-them
description: "OWNER GOLDEN RULE 2026-09-05 - system direct orders REPLACED the Excel-uploaded ones, so whenever the Finance manager sets a sales month the order must be counted to that pharmacy's brick and area IN THAT MONTH. Already honoured end to end; the one live gap is that setDirectOrderSalesMonth commits the month BEFORE the SoS rebuild, so a locked period strands the booking"
metadata: 
  node_type: memory
  type: project
  originSessionId: 11fc0a87-82cb-4e65-9c4b-50a7cf984982
  modified: 2026-09-14T19:04:03.671Z
---

## OWNER GOLDEN RULE, 2026-09-05 - "never forget it"

His words: *"the direct orders requested from the system... they replaced the direct orders that we
were uploading Excel. So whenever the finance manager choose a month for a direct order, this direct
order must be calculated to this brick or area in the same month he added."*

**Two vintages of direct order exist and only one is current.** `distributor_code = 'DIRECT'` is the
retired Excel upload (2026-01 .. 2026-07; Feb-Jun carry `area_code = ''`, an EMPTY STRING, not null,
so an `is null` check reads them as placed). `distributor_code = 'DirectReq'` is the module, and it
starts at 2026-08. Never treat the blank-area DIRECT months as a defect to repair - they are the old
world the rule replaced.

**Measured 2026-09-05 on prod `ozucdzovmcqvepbozvqf`: the rule is ALREADY honoured, all four ways.**

| Check | Result |
| --- | --- |
| Approved orders with a `sales_month` and no `sos_batch_id` | **0** (8 Anti Infective + 13 Pedia, all 2026-08) |
| `direct_order_request_items` vs `source_of_sales_fact_rollup` | AI 460 qty / 23 bonus / 34,978.90 - **exact**; Pedia 1,802 / 240 / 258,858.67 - **exact** |
| Pharmacy area + brick present on every booked order | **0 missing** either; 4 AI areas, 5 Pedia |
| `au.f_monthly_achievement` stored vs `_live` for 2026-08 | **0 unit and 0 value drift** on all three lines |

`phx_rebuild_direct_order_sos_batch(period)` is a rebuild-from-truth: it supersedes the prior
DirectReq batch and re-injects every approved non-reversal order for that month, taking
`region_code` / `area_code` / `brick_id` straight from `direct_order_pharmacies`. That is the rule,
in code.

## The one live gap - a LOCKED month strands the booking, and the month still saves

`setDirectOrderSalesMonth` (`src/lib/direct-orders/service.ts`) writes `sales_month` in one HTTP
call, THEN calls the rebuild in a second. There is no shared transaction. Every rollup carries
`trg_lock_guard_ins/upd/del` -> `phx_reject_write_to_locked_closing`, which refuses ANY row for a
`(line, period)` holding an open row in `monthly_closing_locks`. So booking into a locked month
leaves `sales_month` COMMITTED and the injection rolled back: the order is in the month for Finance
and absent from the closing, from the export and from the rep's achievement. **Nothing retries** -
`phx_rebuild_direct_order_sos_batch` has exactly one live caller and no cron. The APPROVAL path is
safe by contrast: injection is atomic inside `phx_apply_direct_order_decision`.

Not currently breached - 2026-08 has no lock row at all - but 19 Anti Infective and 7 Pedia approved
orders are still unbooked, so the exposure is live the moment August is locked.

**How to apply:** after any lock/unlock, and before quoting a month as final, re-run the
items-vs-fact-rollup reconciliation above. Never "fix" a missing direct order by flipping
`not is_direct` in `phx_refresh_sos_distributor_product_rollup` - that double-counts, see
[[closing-reads-distributor-product-rollup-not-fact-rollup]]. And the booking itself is never yours
to make: [[direct-order-sales-month-is-finance-owned]]. Related:
[[direct-orders-were-labelled-excluded-from-a-closing-holding-them]],
[[sos-monthly-closing-is-the-only-sales-truth]].

## The retired vintage is correctly INVISIBLE to area-scoped viewers — owner 2026-09-06

The Source of Sales audit raised **two** findings against this, and both are CLOSED as
working-as-intended: *"every area-scoped viewer loses all blank-area Direct sales and sees Direct
share 0%"* and *"Direct rows carry area_code = '' and form a real blank-labelled area bucket"*.

Measured on production 2026-09-06: **157 rows, 9,029,692.33 EGP, periods 2026-01..06**, `area_code`
an EMPTY STRING (never null). ⚠ **The audit's own figure was 4.91M — it has since nearly doubled, so
do not quote that number either**; re-measure before saying anything about the size of this bucket.

**Owner, asked directly and answered: "keep it invisible, thats the retired vintage."**

So an area-scoped viewer seeing Direct share 0% is CORRECT, not a loss: those sales belong to no
area by construction, which is exactly what the retired vintage means. **Do not "restore" them to
scoped viewers, do not backfill an area onto them, and do not re-raise either finding.** A session
reading the audit list cold will see 9M EGP apparently vanishing from a manager's screen and try to
fix it — that reflex is the thing this paragraph exists to stop.

Related: `sos-remeasure-2026-09-06.md` in the audit vault records the re-measurement these two came
from, and the other four findings on `sos-dashboard.ts`.

## 🔴 AUGUST 2026 CARRIES ONE OWNER-APPROVED `DIRECT` HAND BATCH BESIDE `DirectReq` — NOT a double count

Loaded 2026-09-14 at the owner's instruction ("load to august direct sales + the already in"): batch
`3bc8c0a8-1e86-4761-b3cb-81b053a2eecf`, `distributor_code = 'DIRECT'`, file "Direct Sales (1) (1).xlsx",
10 rows, 1,502 units, EGP 205,194.30, every row with a real area (Pedia D13/D14/D15/GZ2/GZ4, Anti
Infective D16/UE2). Raw rows carry `source = owner_august_2026_direct_hand_sheet`.

**`phx_direct_sales_reconciliation('2026-08')` now reads pass=false with EGP 135,684.90 "overlap" — that
is EXPECTED.** Asked twice by multiple choice, the owner answered "None — all 10 are extra" and then,
for the two groups that match orders exactly, "Extra sales — keep all 10". **Never delete, merge or
"reconcile away" this batch, and never re-ask.** It is exempt from the direct cleanup by period
(`LIVE_DIRECT_VINTAGE_FROM`). Pre-image: schema `direct_aug_hand_backup_20260914`. Undo (only if he
says): delete the batch, then `au.f_refresh_monthly_attribution('2026-08')`.
