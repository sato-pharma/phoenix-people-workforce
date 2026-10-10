---
name: a-timed-out-reconcile-refresh-is-never-retried-by-re-running-it
description: "`applyHistoricalReconciliation`'s own error says \"Re-run the reconcile to retry the refresh\" and that advice is WRONG — the rows are already corrected, so the re-run returns `updatedRows=0` with an empty batch list and refreshes NOTHING; the loop also aborts, so batches after the failing one and every later pair in your own loop are silently skipped. Call `refreshBatchRollups` directly for each batch instead. And when refreshing BY BATCH also times out, the culprit is refreshBatchRollups opening with a Promise.all over three heavy statements: retry two or three times, then run the whole chain SERIALLY, which cleared a 33,252-row batch on the first attempt."
metadata:
  node_type: memory
  type: project
  originSessionId: d5764c39-c02c-4dd4-a40d-70ad08cc490c
  modified: 2026-10-09T19:17:53.784Z
---

`applyHistoricalReconciliation` corrects the rows in ONE RPC
(`sos_reconcile_import_rows_from_customer_map`) and then walks the affected batches, calling
`refreshBatchRollups` for each. A refresh that fails throws, and the message it throws is
*"N historical row(s) were corrected, but rollup refresh failed for batch <id>: canceling statement
due to statement timeout. Re-run the reconcile to retry the refresh."*

🔴 **Re-running it does not retry anything.** The correction already happened, so the second call's
RPC finds no disagreeing row, returns `updated_rows = 0` and an EMPTY `affected_batch_ids`, and the
loop never executes — it reports `updatedRows=0 refreshedBatches=0` and looks like a clean no-op
while the batch's fact, directory, ROI, channel, distributor×product, store-split-net, attribution
and import-summary totals are all still pre-move. Two more things vanish in the same throw: the
batches **after** the failing one in that customer's list, and every pair after the current one if
you are looping over several customers in a script.

**The fix is to refresh by batch, not by customer.** `refreshBatchRollups(supabase, batchId, failure)`
is exported from `src/lib/sales/normalizer/customer-map.ts` and runs the whole chain in the required
order — including `writeStoreSplitNetForBatch`, which is why this is also how a stale store-split net
gets rebuilt. Find every batch holding that customer's rows (`source_of_sales_import_rows` grouped by
`batch_id`), and refresh each; it is idempotent, so refreshing one that already succeeded costs only
time.

**Measured 2026-10-09**, reconciling the six Sohag customers of
[[his-sohag-ruling-of-2026-10-09-moves-eight-customers]]: four pairs went through, then كيرلس صفوت
الجديدة (PS/0001571525) corrected 4 rows and died refreshing `c8605556-f52e-4972-9637-a9251ac343b3`
— **PS May 2026, 32,063 rows**, the biggest batch in the set. The retry reported
`updatedRows=0 refreshedBatches=0`; refreshing that batch and the three others his rows sit in
(`28cd2d54` September, `d8c7bcd2` March, `726990af` April) directly each succeeded **on the first
attempt**, so the timeout is batch SIZE, not load. September's net came back at 492 cells in
`au.monthly_store_split_net` — that table lives in schema `au`, not `public`.

🔴 **AND WHEN REFRESHING BY BATCH ALSO TIMES OUT, THE CULPRIT IS THE PARALLEL TRIO — RUN THE CHAIN
ONE STATEMENT AT A TIME.** `refreshBatchRollups` opens with `Promise.all` over
`phx_refresh_sos_fact_rollup`, `phx_refresh_sos_customer_directory_rollup` and
`phx_refresh_marketing_roi_facts`, so a 33k-row batch runs three heavy statements against the same
pooler at once and all three can die on `canceling statement due to statement timeout`.

Measured 2026-10-09 on the 45-candidate Sohag move: 13 batches, 11 refreshed, two failed —
`d8c7bcd2` (PS **March**, 33,252 rows) and `17ef39fa` (PS **June**, 32,467 rows). June went through
on the **third** identical retry; March failed three more times, then every step of the SAME chain
run **serially** — fact, directory, marketing ROI, channel, distributor×product,
`writeStoreSplitNetForBatch`, attribution, import summaries — succeeded on the **first** attempt.
So a retry is worth two or three goes, and after that the fix is serialization, never abandonment.

**The split net only exists for the periods the city-split rails cover:** after both refreshes,
`au.monthly_store_split_net` held **0** cells for 2026-03 and 2026-06 and 732 for 2026-09, so a
"split net: ok" on an older batch legitimately writes nothing.

🔴 **THE PUBLISHED-MONTH GUARD EXISTS ONLY IN THE SCRIPT, NOT IN `applyHistoricalReconciliation`.**
The RPC freezes a whole FILE that touches a LOCKED closing
(`sos_import_batch_touches_locked_closing`), and that is all the protection the screen's path has. A
lock and a publication are two different tables set from two different screens, so **calling
`applyHistoricalReconciliation` directly can rewrite a month that is published but not locked** —
against his rule "never cange a publkished month". Only `scripts/reconcile-month-customer-map.ts`
reads `monthly_closing_publications` (via `src/lib/sales/published-month-guard.ts`) and refuses.
**So reconcile through the script, not the function** — it also writes a pre-image CSV of every row
first and refreshes each file ONCE at the end instead of once per customer.

**And when its refresh loop throws, the AUDIT ENTRY is never written either** — `writeAuditLog` sits
after the loop, so a run that dies mid-refresh leaves 38 corrected rows with no audit trail at all.
Finish by hand: refresh the remaining files, then write the same entry (`entityId`
`source_of_sales_import_rows`, `entityType` `sales_import_batch`, the period/line/pairs/updated_rows,
the affected and frozen file ids, and the pre-image path).

**Measured 2026-10-10**, the five brick changes from his Mapping Guard approvals (CNS 2026-09, 38
rows across 14 files): the loop died on file **2 of 14** — not a statement timeout this time but
`attribution store split: writing the net for 2026-09 failed — Supabase request timed out`. All 13
remaining files then refreshed serially in **2-46s each**, and one (`b7436b25`) failed its first
attempt on a bare `TypeError: fetch failed` and succeeded on the second. So the per-file retry earns
its keep even on files that are not large.
