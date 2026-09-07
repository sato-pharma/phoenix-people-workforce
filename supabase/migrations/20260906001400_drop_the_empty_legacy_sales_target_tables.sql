-- Drop public.sales_targets and public.sales_target_batches.
--
-- Both have held ZERO rows for their entire life. Nothing in the repository reads them; the live
-- sales targets are au.monthly_targets. They were labelled EMPTY LEGACY on 2026-09-05
-- (20260905233500) and had anon/authenticated revoked (20260906000100). The owner asked for them
-- gone on 2026-09-06.
--
-- WHY THIS IS SAFE TO DROP, checked on production before writing this:
--   * 0 rows in both -- so no data is destroyed, and the guard below refuses if that ever changes
--   * no view or materialized view references either
--   * no trigger on either
--   * no function reads or writes either (phx_reassign_replacement_ownership only hard-codes
--     'sales_targets_reassigned': null into its result JSON -- it never touches the table)
--   * the ONLY foreign key is internal: sales_targets.batch_id -> sales_target_batches.id.
--     No external table points at either, so nothing is orphaned.
--   * indexes (sales_targets_pkey, sales_target_batches_pkey, sales_targets_batch_id_idx) and the
--     two service_role RLS policies drop with the tables.
--
-- THE APPLICATION IS SAFE ACROSS THE DEPLOY WINDOW. The manager-reassignment cascade used to PATCH
-- sales_targets; that code is removed in the same PR. If an older build is still serving when this
-- lands, its PATCH gets PostgREST's PGRST205 "Could not find the table ... in the schema cache",
-- and isEmployeeDirectorySchemaMissing() matches on the literal text "could not find the table" --
-- so patchOptionalTable swallows it rather than throwing. Verified by reading that function, not
-- assumed: the obvious 42P01 guard would NOT have fired, because a missing table answers PGRST205.
--
-- NOT REVIVING supabase/20260509_drop_sales_target_flow.sql. That loose root script (never stamped,
-- never applied) also drops and recreates public.v_hr_id_orphan_audit. That view EXISTS today and
-- no longer references sales_targets at all -- it was rebuilt by some other route since. Running
-- the old script would overwrite a live view with a four-month-old definition. This migration
-- therefore drops the two tables and touches nothing else.
--
-- REVERSIBILITY. Production has no point-in-time recovery, so the restore path is the DDL below,
-- captured from production immediately before the drop. Since both tables are empty, recreating
-- from this block restores them completely -- there is no data to lose.
--
--   create table public.sales_target_batches (
--     id uuid not null default gen_random_uuid(),
--     file_name text,
--     status text not null default 'uploaded'::text,
--     created_at timestamptz not null default now(),
--     updated_at timestamptz not null default now(),
--     constraint sales_target_batches_pkey primary key (id)
--   );
--   create table public.sales_targets (
--     id uuid not null default gen_random_uuid(),
--     batch_id uuid,
--     employee_hr_id text,
--     employee_name text,
--     manager_hr_id text,
--     product text,
--     target_value numeric(20,2) not null default 0,
--     year integer,
--     month integer,
--     created_at timestamptz not null default now(),
--     updated_at timestamptz not null default now(),
--     constraint sales_targets_pkey primary key (id),
--     constraint sales_targets_batch_id_fkey foreign key (batch_id)
--       references public.sales_target_batches(id) on delete set null
--   );
--   create index sales_targets_batch_id_idx on public.sales_targets using btree (batch_id);
--   alter table public.sales_targets enable row level security;
--   alter table public.sales_target_batches enable row level security;
--   create policy sales_targets_service_role_all on public.sales_targets
--     to service_role using (true) with check (true);
--   create policy sales_target_batches_service_role_all on public.sales_target_batches
--     to service_role using (true) with check (true);

-- Fail closed. If either table has acquired a row since this was written, refuse the whole
-- migration rather than destroy it. A DROP takes no WHERE clause, so this is the precondition.
do $$
declare
  v_targets bigint;
  v_batches bigint;
begin
  if to_regclass('public.sales_targets') is null
     and to_regclass('public.sales_target_batches') is null then
    raise notice 'both tables already absent - nothing to do';
    return;
  end if;

  select count(*) into v_targets from public.sales_targets;
  select count(*) into v_batches from public.sales_target_batches;

  if v_targets <> 0 or v_batches <> 0 then
    raise exception
      'REFUSING TO DROP: sales_targets has % row(s) and sales_target_batches has % row(s); expected 0 and 0. Someone started using these tables - investigate before dropping.',
      v_targets, v_batches;
  end if;
end $$;

-- SAFE: both tables hold ZERO rows on production, verified before this was written. Nothing
-- references them -- no view, no materialized view, no trigger, no function, and no foreign key
-- from any other table -- and the do-block above REFUSES the entire migration if either has
-- acquired a row since. The full justification, the deploy-window analysis and the restore DDL
-- for both tables are in the header comment at the top of this file.
-- Child first: sales_targets.batch_id references sales_target_batches.
drop table if exists public.sales_targets;
drop table if exists public.sales_target_batches;
