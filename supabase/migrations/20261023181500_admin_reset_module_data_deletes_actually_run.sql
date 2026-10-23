-- The admin "Reset module data" button has never deleted a single row.
--
-- `phx_admin_reset_module_data` was written as nineteen bare `delete from <table>;` statements.
-- PostgREST connects as `authenticator`, whose `session_preload_libraries` carries **safeupdate**,
-- and safeupdate refuses any DELETE or UPDATE with no WHERE clause — so the function fails on its
-- very first delete, every time, for every scope. It works when pasted into a SQL editor (a direct
-- session does not preload safeupdate), which is why it looked healthy. Same root cause as
-- `phx_refresh_expense_claims` (2026-08-29) and `crm_person_by_hr_key_rebuild` (2026-10-23).
-- `tests/function-bodies-need-a-where-clause.test.ts` allow-listed this one function with the
-- reason "fails closed on a destructive wholesale delete — re-arming it is the owner's call". He
-- made that call on 2026-10-23: "fix the admin Reset module data deletes". The allowlist entry is
-- removed in the same change, so the test now enforces this repair instead of excusing it.
--
-- Adding the WHERE clauses alone would have shipped a destructive function carrying four further
-- defects. Each is fixed here, because each one only ever shows up the first time the button works.
--
--   1. LOCKED CLOSINGS.  `source_of_sales_import_rows` carries `trg_lock_guard_del`, an AFTER
--      STATEMENT trigger running `phx_reject_write_to_locked_closing('invoice_period',
--      'official_line')`, which raises check_violation when a deleted row belongs to a closing
--      that is still locked. Measured on production 2026-10-23: 9 live locks, and 52 of the 156
--      import batches hold at least one locked row. A whole-table delete can only ever abort.
--      Deleting the unlocked rows OUT of those batches would be worse than aborting — it would
--      leave a torn batch sitting behind its own summaries and rollups. So the unit of this reset
--      is the BATCH: a batch is deleted only when no row of it belongs to a live lock, and what
--      was kept is reported back to the caller instead of being skipped in silence. The join below
--      is the guard's own join, copied from `pg_get_functiondef` so the two cannot drift.
--
--   2. SIX UNDECLARED TABLES.  Six rollups cascade off `source_of_sales_import_batches`
--      (brick_move_files, channel_customer_rollup, customer_directory_rollup,
--      customer_presence_rollup, distributor_product_rollup, fact_rollup — 295,418 rows in
--      fact_rollup alone). They were wiped invisibly, counted nowhere, and named nowhere on the
--      confirmation screen. They are deleted explicitly now, so `get diagnostics` counts them and
--      the UI can list them before the owner types CONFIRM DELETE.
--
--   3. ONE FOREIGN KEY THAT IS NOT CASCADE.  `direct_order_marketing_offsets.marketing_request_id`
--      is ON DELETE NO ACTION and NOT NULL, so it cannot be unlinked, only removed — and until it
--      is, the delete of `marketing_requests` raises foreign_key_violation.
--
--   4. AN APPEND-ONLY TABLE.  `marketing_request_events` is immutable by design
--      (`phx_marketing_request_events_immutable` raises restrict_violation on UPDATE, DELETE and
--      TRUNCATE). The reset must not try to clear it. Deleting a request in fact ADDS one
--      `request_deleted` event, so the audit trail survives the reset — that is the intent, and
--      the confirmation screen now says so rather than leaving it to be discovered.
--
-- The function is also CHUNKED. `service_role` has statement_timeout=300s and the Data API gateway
-- gives up well before that; 405,724 import rows plus 295,418 rollup rows is not a single-request
-- delete. Each call clears at most `p_max_batches` batches and reports how many remain, and
-- `executeReset` loops until `done`. Marketing is small (66 requests) and runs in one pass, on the
-- last chunk.
--
-- The return shape changes from a bare array to an object, so the one-argument signature is
-- DROPPED rather than replaced: a defaulted second argument would overload it, not supersede it,
-- and PostgREST would then refuse the call as ambiguous.

drop function if exists public.phx_admin_reset_module_data(text);

create or replace function public.phx_admin_reset_module_data(
  p_module text,
  p_max_batches integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tables    jsonb := '[]'::jsonb;
  v_kept      jsonb := '[]'::jsonb;
  v_count     bigint;
  v_batch     uuid;
  v_batches   uuid[];
  v_limit     integer := greatest(coalesce(p_max_batches, 25), 1);
  v_remaining integer := 0;

  -- Source of Sales running totals, one per table, summed over the batches in this chunk.
  v_sos_summaries bigint := 0;
  v_sos_brick     bigint := 0;
  v_sos_channel   bigint := 0;
  v_sos_directory bigint := 0;
  v_sos_presence  bigint := 0;
  v_sos_distprod  bigint := 0;
  v_sos_fact      bigint := 0;
  v_sos_rows      bigint := 0;
  v_sos_batches   bigint := 0;

  -- Weekly Sales running totals.
  v_week_rows    bigint := 0;
  v_week_batches bigint := 0;

  -- What a live lock held back.
  v_kept_batches integer := 0;
  v_kept_rows    bigint  := 0;
  v_kept_periods text;
begin
  if p_module not in ('sales', 'weekly', 'marketing', 'all') then
    raise exception 'Invalid module: %. Must be sales, weekly, marketing, or all.', p_module;
  end if;

  ---------------------------------------------------------------- Source of Sales
  if p_module in ('sales', 'all') then
    -- Deletable batches only. A batch holding even one row of a locked closing is left whole.
    select coalesce(array_agg(pick.id), '{}'::uuid[])
      into v_batches
      from (
        select b.id
          from source_of_sales_import_batches b
         where not exists (
                 select 1
                   from source_of_sales_import_rows r
                   join monthly_closing_locks l
                     on l.period = r.invoice_period
                    and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
                    and l.unlocked_at is null
                  where r.batch_id = b.id
               )
         order by b.id
         limit v_limit
      ) pick;

    foreach v_batch in array v_batches loop
      delete from source_of_sales_import_summaries where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_summaries := v_sos_summaries + v_count;

      delete from source_of_sales_brick_move_files where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_brick := v_sos_brick + v_count;

      delete from source_of_sales_channel_customer_rollup where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_channel := v_sos_channel + v_count;

      delete from source_of_sales_customer_directory_rollup where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_directory := v_sos_directory + v_count;

      delete from source_of_sales_customer_presence_rollup where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_presence := v_sos_presence + v_count;

      delete from source_of_sales_distributor_product_rollup where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_distprod := v_sos_distprod + v_count;

      delete from source_of_sales_fact_rollup where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_fact := v_sos_fact + v_count;

      delete from source_of_sales_import_rows where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_rows := v_sos_rows + v_count;

      delete from source_of_sales_import_batches where id = v_batch;
      get diagnostics v_count = row_count;
      v_sos_batches := v_sos_batches + v_count;
    end loop;

    v_tables := v_tables
      || jsonb_build_array(
           jsonb_build_object('table', 'source_of_sales_import_summaries', 'deleted', v_sos_summaries),
           jsonb_build_object('table', 'source_of_sales_brick_move_files', 'deleted', v_sos_brick),
           jsonb_build_object('table', 'source_of_sales_channel_customer_rollup', 'deleted', v_sos_channel),
           jsonb_build_object('table', 'source_of_sales_customer_directory_rollup', 'deleted', v_sos_directory),
           jsonb_build_object('table', 'source_of_sales_customer_presence_rollup', 'deleted', v_sos_presence),
           jsonb_build_object('table', 'source_of_sales_distributor_product_rollup', 'deleted', v_sos_distprod),
           jsonb_build_object('table', 'source_of_sales_fact_rollup', 'deleted', v_sos_fact),
           jsonb_build_object('table', 'source_of_sales_import_rows', 'deleted', v_sos_rows),
           jsonb_build_object('table', 'source_of_sales_import_batches', 'deleted', v_sos_batches)
         );

    -- Everything a live lock held back, counted after the chunk so the number cannot drift.
    select count(*)::integer, coalesce(sum(held.row_count), 0)
      into v_kept_batches, v_kept_rows
      from (
        select (select count(*) from source_of_sales_import_rows r where r.batch_id = b.id) as row_count
          from source_of_sales_import_batches b
         where exists (
                 select 1
                   from source_of_sales_import_rows r
                   join monthly_closing_locks l
                     on l.period = r.invoice_period
                    and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
                    and l.unlocked_at is null
                  where r.batch_id = b.id
               )
      ) held;

    if v_kept_batches > 0 then
      select string_agg(distinct l.line || ' ' || l.period, ', ')
        into v_kept_periods
        from monthly_closing_locks l
       where l.unlocked_at is null
         and exists (
               select 1
                 from source_of_sales_import_rows r
                where r.invoice_period = l.period
                  and lower(btrim(coalesce(r.official_line, ''))) = l.normalized_line
             );

      v_kept := v_kept
        || jsonb_build_array(jsonb_build_object(
             'table', 'source_of_sales_import_batches',
             'batches', v_kept_batches,
             'rows', v_kept_rows,
             'reason', 'the monthly closing is still locked: ' || coalesce(v_kept_periods, 'unknown closing')
           ));
    end if;

    -- Deletable batches still waiting after this chunk.
    select count(*)::integer
      into v_count
      from source_of_sales_import_batches b
     where not exists (
             select 1
               from source_of_sales_import_rows r
               join monthly_closing_locks l
                 on l.period = r.invoice_period
                and l.normalized_line = lower(btrim(coalesce(r.official_line, '')))
                and l.unlocked_at is null
              where r.batch_id = b.id
           );
    v_remaining := v_remaining + v_count;
  end if;

  ---------------------------------------------------------------- Weekly Sales
  -- No lock guard and no triggers at all on these two; chunked only to keep each call short.
  if p_module in ('weekly', 'all') then
    select coalesce(array_agg(pick.id), '{}'::uuid[])
      into v_batches
      from (select b.id from weekly_sales_batches b order by b.id limit v_limit) pick;

    foreach v_batch in array v_batches loop
      delete from weekly_sales_rows where batch_id = v_batch;
      get diagnostics v_count = row_count;
      v_week_rows := v_week_rows + v_count;

      delete from weekly_sales_batches where id = v_batch;
      get diagnostics v_count = row_count;
      v_week_batches := v_week_batches + v_count;
    end loop;

    v_tables := v_tables
      || jsonb_build_array(
           jsonb_build_object('table', 'weekly_sales_rows', 'deleted', v_week_rows),
           jsonb_build_object('table', 'weekly_sales_batches', 'deleted', v_week_batches)
         );

    select count(*)::integer into v_count from weekly_sales_batches;
    v_remaining := v_remaining + v_count;
  end if;

  ---------------------------------------------------------------- Marketing Requests
  -- Small enough for one pass, and held to the final chunk so a long sales or weekly reset does
  -- not repeat it on every call.
  if p_module in ('marketing', 'all') and v_remaining = 0 then
    -- ON DELETE NO ACTION and NOT NULL: this row cannot be unlinked, only removed, and until it is
    -- it blocks the delete of `marketing_requests`.
    delete from direct_order_marketing_offsets where marketing_request_id is not null;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'direct_order_marketing_offsets', 'deleted', v_count));

    delete from marketing_roi_customer_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_customer_facts', 'deleted', v_count));

    delete from marketing_roi_distributor_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_distributor_facts', 'deleted', v_count));

    delete from marketing_roi_region_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_region_facts', 'deleted', v_count));

    delete from marketing_roi_line_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_line_facts', 'deleted', v_count));

    delete from marketing_roi_product_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_product_facts', 'deleted', v_count));

    delete from marketing_roi_trend_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_trend_facts', 'deleted', v_count));

    delete from marketing_roi_request_geo_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_request_geo_facts', 'deleted', v_count));

    delete from marketing_roi_request_facts where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_request_facts', 'deleted', v_count));

    delete from marketing_roi_refresh_runs where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_refresh_runs', 'deleted', v_count));

    delete from marketing_roi_export_audit where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_roi_export_audit', 'deleted', v_count));

    delete from marketing_request_finance_requirements where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_request_finance_requirements', 'deleted', v_count));

    delete from marketing_request_approval_steps where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_request_approval_steps', 'deleted', v_count));

    delete from marketing_request_pharmacies where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_request_pharmacies', 'deleted', v_count));

    delete from marketing_request_products where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_request_products', 'deleted', v_count));

    -- `phx_capture_marketing_request_event` writes one `request_deleted` row per request as this
    -- runs. `marketing_request_events` is append-only by design and is never cleared here.
    delete from marketing_requests where true;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('table', 'marketing_requests', 'deleted', v_count));

    v_kept := v_kept
      || jsonb_build_array(jsonb_build_object(
           'table', 'marketing_request_events',
           'rows', (select count(*) from marketing_request_events),
           'reason', 'the request audit trail is append-only by design and is kept, with one request_deleted event added per deleted request'
         ));
  end if;

  return jsonb_build_object(
    'tables', v_tables,
    'kept', v_kept,
    'remaining', v_remaining,
    'done', v_remaining = 0
  );
end;
$function$;

revoke execute on function public.phx_admin_reset_module_data(text, integer) from public, anon, authenticated;
grant execute on function public.phx_admin_reset_module_data(text, integer) to service_role;

comment on function public.phx_admin_reset_module_data(text, integer) is
  'Admin "Reset module data". Every delete carries a WHERE clause, because safeupdate is preloaded '
  'on the PostgREST role and refuses a bare one. Source of Sales and Weekly Sales are cleared one '
  'BATCH at a time, at most p_max_batches per call; a batch holding any row of a still-locked '
  'monthly closing is kept whole and reported under "kept". Marketing runs in one pass on the last '
  'chunk. Returns {tables, kept, remaining, done}; the caller loops until done.';
