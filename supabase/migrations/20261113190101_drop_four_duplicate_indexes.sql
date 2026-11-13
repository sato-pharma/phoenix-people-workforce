-- drop_four_duplicate_indexes
--
-- WHAT THIS CHANGES: drops four plain indexes, each an exact copy of an index on the same table
-- that enforces something (a unique index or a unique constraint) and stays.
--
--   dropped                                         the index that stays and answers the same reads
--   ats_candidate_call_actions_claim_lookup_idx     ats_candidate_call_actions_one_claim
--   direct_order_approval_steps_request_idx         direct_order_approval_steps_request_id_step_order_key
--   employee_locations_employee_hr_id_idx           employee_locations_employee_hr_id_uidx
--   v2_vacation_sla_runs_run_date_idx               v2_vacation_sla_runs_run_date_unique
--
-- WHY: enterprise audit 2026-11-13, F-DB-005 / REC-040 ("duplicate indexes dropped first as the safe
-- win"). Read on production 2026-11-13 ~18:45 Cairo: each pair has the same table, access method,
-- columns, operator classes, collations, expression and partial predicate, so Postgres answers every
-- read the dropped one served from the one that stays. Three also have the same sort direction; the
-- fourth (run_date DESC against run_date) is single-column, and a b-tree is read backwards at the same
-- cost. Each copy still costs a write on every insert and update.
--
-- DELIBERATELY KEPT although they match the same columns:
--   - payroll_statutory_config_effective_from_idx and idx_salary_structure_effective — payroll is left
--     alone, as 20261030215000 recorded (tests/phase21-security-hardening.test.ts pins the second).
--   - prodplan_compositions_product_idx, prodplan_material_prices_current_idx and
--     source_of_sales_product_price_history_lookup_idx — multi-column with a trailing DESC; a sort that
--     mixes directions could need them (the same call 20261030215000 made for six such pairs).
--
-- SAFETY: no data is touched. Each drop runs only when the index that stays still exists and is
-- valid, so a database whose indexes differ skips that pair instead of losing its only index. All four
-- tables are small (88 kB the largest); lock_timeout keeps a drop from queueing behind a long read.
--
-- ROLLBACK: recreate any of them with its original statement:
--   create index ats_candidate_call_actions_claim_lookup_idx on public.ats_candidate_call_actions (candidate_id) where (action = 'will_call'::text);
--   create index direct_order_approval_steps_request_idx on public.direct_order_approval_steps (request_id, step_order);
--   create index employee_locations_employee_hr_id_idx on public.employee_locations (employee_hr_id);
--   create index v2_vacation_sla_runs_run_date_idx on public.v2_vacation_sla_runs (run_date desc);
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

do $migration$
declare
  pair record;
  dropped integer := 0;
  skipped integer := 0;
begin
  for pair in
    select * from (values
      ('ats_candidate_call_actions_claim_lookup_idx', 'ats_candidate_call_actions_one_claim'),
      ('direct_order_approval_steps_request_idx', 'direct_order_approval_steps_request_id_step_order_key'),
      ('employee_locations_employee_hr_id_idx', 'employee_locations_employee_hr_id_uidx'),
      ('v2_vacation_sla_runs_run_date_idx', 'v2_vacation_sla_runs_run_date_unique')
    ) as p(drop_name, keep_name)
  loop
    if exists (
      select 1
      from pg_index k
      join pg_class kc on kc.oid = k.indexrelid
      join pg_namespace kn on kn.oid = kc.relnamespace
      where kn.nspname = 'public' and kc.relname = pair.keep_name and k.indisvalid
    ) and to_regclass('public.' || pair.drop_name) is not null then
      execute format('drop index public.%I', pair.drop_name);
      dropped := dropped + 1;
    else
      skipped := skipped + 1;
    end if;
  end loop;
  raise notice 'duplicate indexes: % dropped, % skipped', dropped, skipped;
end
$migration$;

commit;
