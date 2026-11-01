-- phoenix_crm_first_run_rows_repair
--
-- WHAT THIS CHANGES: two classes of row the first run of the iReports360 history copy wrote before the rules of
-- 2026-11-01 existed. It updates 968 rows and deletes none.
--   A. 218 copied visits of a training manager, filed as `double` with them as the manager. They held no seat on any
--      of those days and their login role is Training Manager, so the copy's own rule files them as
--      `product_manager` (docs/phoenix-crm-ireports360-history-import.md, "A double visit keeps its partner").
--   B. 138 Archive pharmacies on the AM or PM list, and their 612 copied visits. A pharmacy is a pharmacy whatever
--      period the old system tagged. They move to the Pharmacy list, and each visit gets the pharmacy's name, which
--      the insert trigger phoenix_crm_visits_pharmacy_name gave every other pharmacy visit and does not do on update.
--      This is the shape the other 339 imported pharmacies and their 1,883 visits already have.
--
-- WHY: the owner read every row and asked for exactly these two groups (2026-11-01, about 11:40 Cairo). The catch-all
-- contact's rows and the same-name pairs are left alone on purpose: a name does not prove one doctor.
--
-- PRE-IMAGE: phoenix_crm_backup_20261101 holds the rows exactly as they were, before any change.
--
-- ROLLBACK (data only, nothing is dropped by this file):
--   update public.phoenix_crm_visits v set kind = b.kind, manager_hr_id = b.manager_hr_id,
--          product_manager_hr_id = b.product_manager_hr_id
--     from phoenix_crm_backup_20261101.visits_training_manager b where b.id = v.id;
--   update public.phoenix_crm_customers c set list_type = b.list_type
--     from phoenix_crm_backup_20261101.customers_pharmacy b where b.id = c.id;
--   update public.phoenix_crm_visits v set list_type = b.list_type, pharmacy_name = b.pharmacy_name
--     from phoenix_crm_backup_20261101.visits_pharmacy b where b.id = v.id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Announced to the owner in plain words BEFORE it was applied.
--
-- Idempotent: every statement selects only rows still in the broken state, so a re-run changes nothing. On a database
-- with no such rows (staging, a fresh replay) it is a no-op. Any other count refuses and rolls the whole file back.

begin;

create schema if not exists phoenix_crm_backup_20261101;
revoke all on schema phoenix_crm_backup_20261101 from public, anon, authenticated;

create table if not exists phoenix_crm_backup_20261101.visits_training_manager
  as select * from public.phoenix_crm_visits where false;
create table if not exists phoenix_crm_backup_20261101.customers_pharmacy
  as select * from public.phoenix_crm_customers where false;
create table if not exists phoenix_crm_backup_20261101.visits_pharmacy
  as select * from public.phoenix_crm_visits where false;

revoke all on all tables in schema phoenix_crm_backup_20261101 from public, anon, authenticated;

do $repair$
declare
  v_expected_manager_visits constant int := 218;
  v_expected_pharmacies constant int := 138;
  v_expected_pharmacy_visits constant int := 612;
  v_count int;
  v_manager_visits int;
  v_pharmacies int;
  v_pharmacy_visits int;
begin
  -- ── A. A training manager's copied visits, filed as double ───────────────────────────────────────────────────────
  -- The copy's rule, narrowed to the one role the owner named: no seat that day, then the login's role, then the title.
  insert into phoenix_crm_backup_20261101.visits_training_manager
  select v.*
  from public.phoenix_crm_visits v
  join public.employees pe on lower(pe.hr_id) = lower(v.manager_hr_id)
  left join lateral (
    select u.role
    from public.app_auth_users u
    where lower(u.hr_id) = lower(pe.hr_id) and not u.is_test_persona
    order by u.is_active desc, u.updated_at desc
    limit 1
  ) login on true
  where v.imported_from_ireports360_at is not null
    and not v.is_test
    and v.kind = 'double'
    and coalesce(login.role, btrim(pe.job_title)) = 'Training Manager'
    and not exists (
      select 1 from public.au_v_seat_occupancy_all o
      where lower(o.occupant_canonical_hr_id) = lower(pe.hr_id)
        and o.node_type = 'person'
        and o.effective_from <= v.visit_date
        and (o.effective_to is null or o.effective_to >= v.visit_date)
    );
  get diagnostics v_manager_visits = row_count;
  if v_manager_visits not in (0, v_expected_manager_visits) then
    raise exception 'first-run repair: % training manager visits, expected % or 0', v_manager_visits, v_expected_manager_visits;
  end if;

  update public.phoenix_crm_visits v
  set kind = 'product_manager',
      product_manager_hr_id = v.manager_hr_id,
      manager_hr_id = null
  from phoenix_crm_backup_20261101.visits_training_manager b
  where b.id = v.id
    and v.kind = 'double'
    and v.imported_from_ireports360_at is not null;
  get diagnostics v_count = row_count;
  if v_count <> v_manager_visits then
    raise exception 'first-run repair: updated % training manager visits, expected %', v_count, v_manager_visits;
  end if;

  -- ── B. Archive pharmacies on the AM or PM list ───────────────────────────────────────────────────────────────────
  insert into phoenix_crm_backup_20261101.customers_pharmacy
  select c.*
  from public.phoenix_crm_customers c
  where c.imported_from_ireports360_at is not null
    and not c.is_test
    and not c.campaign_visit_holder
    and c.status = 'dropped'
    and c.list_type in ('AM', 'PM')
    and lower(regexp_replace(btrim(coalesce(c.speciality, '')), '[[:space:]]+', ' ', 'g')) = 'pharmacy';
  get diagnostics v_pharmacies = row_count;
  if v_pharmacies not in (0, v_expected_pharmacies) then
    raise exception 'first-run repair: % pharmacies, expected % or 0', v_pharmacies, v_expected_pharmacies;
  end if;

  -- A real Phoenix visit on one of them would mean a rep has worked it, and that is not this repair's to re-file.
  select count(*) into v_count
  from public.phoenix_crm_visits v
  join phoenix_crm_backup_20261101.customers_pharmacy b on b.id = v.customer_id
  where v.imported_from_ireports360_at is null;
  if v_count <> 0 then
    raise exception 'first-run repair: % real Phoenix visits on the pharmacies, expected 0', v_count;
  end if;

  insert into phoenix_crm_backup_20261101.visits_pharmacy
  select v.*
  from public.phoenix_crm_visits v
  join phoenix_crm_backup_20261101.customers_pharmacy b on b.id = v.customer_id
  where v.imported_from_ireports360_at is not null
    and v.list_type in ('AM', 'PM')
    and not exists (select 1 from phoenix_crm_backup_20261101.visits_pharmacy done where done.id = v.id);
  get diagnostics v_pharmacy_visits = row_count;
  if v_pharmacy_visits not in (0, v_expected_pharmacy_visits) then
    raise exception 'first-run repair: % pharmacy visits, expected % or 0', v_pharmacy_visits, v_expected_pharmacy_visits;
  end if;

  update public.phoenix_crm_customers c
  set list_type = 'Pharmacy'
  from phoenix_crm_backup_20261101.customers_pharmacy b
  where b.id = c.id
    and c.imported_from_ireports360_at is not null
    and c.list_type in ('AM', 'PM');
  get diagnostics v_count = row_count;
  if v_count <> v_pharmacies then
    raise exception 'first-run repair: updated % pharmacies, expected %', v_count, v_pharmacies;
  end if;

  update public.phoenix_crm_visits v
  set list_type = 'Pharmacy',
      pharmacy_name = coalesce(v.pharmacy_name, left(c.name, 120))
  from phoenix_crm_backup_20261101.visits_pharmacy b, public.phoenix_crm_customers c
  where b.id = v.id
    and c.id = v.customer_id
    and v.imported_from_ireports360_at is not null
    and v.list_type in ('AM', 'PM');
  get diagnostics v_count = row_count;
  if v_count <> v_pharmacy_visits then
    raise exception 'first-run repair: updated % pharmacy visits, expected %', v_count, v_pharmacy_visits;
  end if;

  raise notice 'first-run repair: % training manager visits, % pharmacies, % pharmacy visits',
    v_manager_visits, v_pharmacies, v_pharmacy_visits;
end
$repair$;

commit;
