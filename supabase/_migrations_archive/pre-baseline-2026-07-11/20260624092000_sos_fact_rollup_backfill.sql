-- Phase 1 / Performance: one-shot backfill of the SoS fact rollup for all
-- existing validated batches. Idempotent (phx_refresh_sos_fact_rollup deletes
-- then re-inserts each batch), so this is safe to re-run as a reconcile.
select public.phx_backfill_sos_fact_rollup();
