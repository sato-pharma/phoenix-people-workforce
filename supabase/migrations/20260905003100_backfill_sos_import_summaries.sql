-- Source of Sales: repair the import summaries the nightly re-stamp left behind.
--
-- Companion to 20260905003000, which stops this recurring. That fix only corrects a batch the NEXT
-- re-stamp happens to touch, and a batch is only touched when its customer mapping moves again —
-- so seven months of already-drifted summaries would sit wrong indefinitely. This is the one-off
-- repair for what has already drifted.
--
-- WHAT IT DOES
-- Re-runs phx_refresh_sos_import_summaries over every VALIDATED batch. That function deletes and
-- re-inserts that batch's summary rows from the batch's own import rows — the same call
-- phx_finalize_sos_batch makes at import time. It is deterministic and idempotent: running it
-- twice produces the same rows, so a partial application is repaired by simply re-running this
-- migration.
--
-- SCOPE AND SIZE, measured on production 2026-09-04 (ozucdzovmcqvepbozvqf):
--     123 validated batches (2026-01 .. 2026-08)
--     19,080 summary rows rewritten
--     317,779 import rows scanned
-- Blocked batches are deliberately excluded: their summaries are not read by anything, and
-- rewriting them would be churn.
--
-- WHY THIS CANNOT MOVE A TOTAL — verified before writing this file, not assumed.
-- phx_refresh_sos_import_summaries also rewrites the batch HEADER (total_qty, total_bonus_qty,
-- total_value) from the same rows. Every one of the 123 batches was diffed live, stored against
-- recomputed, across all three columns:
--
--     all_validated_batches      123
--     batches_with_no_rows         0
--     header_value_would_move      0
--     header_qty_would_move        0
--     header_bonus_would_move      0
--     largest_header_delta      0.00
--
-- So this migration changes the SPLIT across area / region / brick / line / product and nothing
-- else. Per period the correction nets to exactly zero (for 2026-07: 30 areas gain what 11 lose,
-- net 0.00, row-count net 0). The Monthly Closing, achievement and incentives read
-- source_of_sales_fact_rollup, which this does not touch at all.
--
-- NOT A RE-DATING. The refresh reads only rows that already exist, with the geography already
-- stamped on them. It does not consult the live area map, so it cannot pull a later territory
-- move backwards into a closed month, and the August / Delta (3) rule is untouched by it.
--
-- JULY IS PUBLISHED AND LOCKED - CHECKED BEFORE WRITING THIS, NOT AFTER.
-- 2026-07 is the ONLY published period, and all three of its lines carry an active closing lock
-- (CNS locked 2026-08-31 17:58 Cairo by b-10; Anti Infective and Pedia 2026-09-01 06:04 by the
-- july-ai-area-stamp job), each holding a real freeze snapshot. So this migration DOES rewrite a
-- locked month's summary rows. That is safe, and deliberate, for three measured reasons:
--
--   1. It CANNOT touch a locked table. phx_reject_write_to_locked_closing guards exactly five:
--      source_of_sales_import_rows, _fact_rollup, _distributor_product_rollup,
--      _customer_directory_rollup, _channel_customer_rollup. phx_refresh_sos_import_summaries
--      writes only source_of_sales_import_summaries and the batch header - neither is guarded.
--
--   2. It cannot move a published LINE total. Measured against the three lock snapshots:
--
--          line              snapshot_units   fact total_qty   summaries total_qty
--          Anti Infective         7,017            7,017              7,017
--          CNS                  105,152          105,152            105,152
--          Pedia                 11,552           11,552             11,552
--
--      All three agree exactly. (CNS effective_units reads 105,151.97 - a 0.03 rounding artefact
--      between effective_units and total_qty, not a gap in the freeze.)
--
--   3. It moves the dashboard TOWARD the published closing, not away from it. For 2026-07, 40 of
--      51 areas ALREADY disagree between source_of_sales_fact_rollup - what the closing reads, and
--      which the sync does refresh - and the summaries, which it does not:
--
--          areas differing         40 of 51
--          units misattributed     11,353.5
--          fact_rollup total       367,300.000000
--          summaries total         367,300.000000   (net 0.000000)
--
--      The summaries are the stale side. Recomputing them from the same rows fact_rollup was built
--      from is what makes the screen agree with the closing that was already sent.

do $$
declare
  v_batch   uuid;
  v_done    integer := 0;
  v_started timestamptz := clock_timestamp();
begin
  -- The loop is one statement, so a client-side timeout cannot leave this half-applied without a
  -- rollback. Each refresh call carries its own 120s cap internally.
  set local statement_timeout = '900s';

  for v_batch in
    select id
    from public.source_of_sales_import_batches
    where status = 'validated'
    order by period, created_at
  loop
    perform public.phx_refresh_sos_import_summaries(v_batch);
    v_done := v_done + 1;
  end loop;

  raise notice 'sos import summaries backfilled: % batches in %',
    v_done, clock_timestamp() - v_started;
end
$$;
