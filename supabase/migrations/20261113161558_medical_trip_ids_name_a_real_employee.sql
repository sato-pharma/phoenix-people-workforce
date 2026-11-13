-- medical_trip_ids_name_a_real_employee — the rep a District Manager names on a medical-trip expense
-- is stored as that employee's real id, and the database refuses an id that names nobody
--
-- WHAT THIS CHANGES:
--   1. A pre-image of every outstation_expense_requests row with a medical_trip_hr_id (id + the old
--      value) goes into outstation_backup_20261113.medical_trip_ids_pre_case_repair.
--   2. A BEFORE INSERT OR UPDATE trigger, phx_outstation_medical_trip_hr_id_canonical, rewrites
--      medical_trip_hr_id to the employee's own hr_id when the two differ only by case or
--      surrounding spaces. If NO employee matches at all, the id is cleared and the rep's name
--      (medical_trip_name) is kept, so a District Manager's expense is never refused over it.
--   3. The existing rows are repaired by touching that column, so the same trigger does the work.
--   4. outstation_expense_requests_medical_trip_phx_employee_fkey -> public.employees(hr_id),
--      ON UPDATE CASCADE ON DELETE RESTRICT, NOT VALID then VALIDATE, after a refusing orphan count.
--
-- WHY (enterprise audit 2026-11-13, F-DB-001, REC-037 slice 3; the owner, 2026-11-13 ~16:15 Cairo:
--   "repair the 42 medical trip ids"):
--   The expense forms take the rep list from the seat model, which carries lower-case ids
--   ("b-107" for B-107). Every one of the 117 rows written since 2 Aug 2026 (42 people) was stored
--   that way, so the column joined to no employee and could not take the key the other money
--   tables got in 20261113160008 and 20261113160747. Correcting it in the database covers all three
--   writers (submit, offline sync, and anything later) in one place.
--
-- MEASURED ON PRODUCTION 2026-11-13 (read-only), before this was written:
--   117 rows, 42 distinct ids, every one matching exactly one employee by case; no two employees
--   differ only by case; 0 ids that match no employee. Staging: 14 rows, same shape.
--   Nothing in the application compares this id to anything: it is written, then read back for
--   display, so the canonical case changes no screen.
--
-- SIDE EFFECTS:
--   * 117 production rows have medical_trip_hr_id rewritten to its canonical case. No other column
--     of those rows changes. The pre-image above holds every old value.
--   * Deleting an employee named on a medical trip is refused (RESTRICT); the app never deletes one.
--
-- ROLLBACK (restores the old values, then drops the key and the trigger):
--   alter table public.outstation_expense_requests
--     drop constraint outstation_expense_requests_medical_trip_phx_employee_fkey;
--   drop trigger phx_outstation_medical_trip_hr_id_canonical on public.outstation_expense_requests;
--   update public.outstation_expense_requests o set medical_trip_hr_id = b.medical_trip_hr_id
--     from outstation_backup_20261113.medical_trip_ids_pre_case_repair b where b.id = o.id;
--   drop function public.phx_outstation_medical_trip_hr_id_canonical();
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;

-- 1. Pre-image.
create schema if not exists outstation_backup_20261113;
revoke all on schema outstation_backup_20261113 from public, anon, authenticated;
create table if not exists outstation_backup_20261113.medical_trip_ids_pre_case_repair as
  select id, medical_trip_hr_id, now() as captured_at
    from public.outstation_expense_requests
   where medical_trip_hr_id is not null;

-- 2. The canonicalising trigger.
create or replace function public.phx_outstation_medical_trip_hr_id_canonical()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_hr_id text;
begin
  if new.medical_trip_hr_id is null then
    return new;
  end if;
  if exists (select 1 from public.employees e where e.hr_id = new.medical_trip_hr_id) then
    return new;
  end if;

  select e.hr_id into v_hr_id
    from public.employees e
   where upper(e.hr_id) = upper(btrim(new.medical_trip_hr_id))
   limit 2;

  if found and (select count(*) from public.employees e
                 where upper(e.hr_id) = upper(btrim(new.medical_trip_hr_id))) = 1 then
    new.medical_trip_hr_id := v_hr_id;
  else
    -- Names nobody (or, never seen, two people at once): keep the name, drop the id.
    new.medical_trip_hr_id := null;
  end if;
  return new;
end;
$$;

drop trigger if exists phx_outstation_medical_trip_hr_id_canonical on public.outstation_expense_requests;
create trigger phx_outstation_medical_trip_hr_id_canonical
  before insert or update of medical_trip_hr_id on public.outstation_expense_requests
  for each row execute function public.phx_outstation_medical_trip_hr_id_canonical();

-- 3. Repair the existing rows through the same trigger.
update public.outstation_expense_requests o
   set medical_trip_hr_id = o.medical_trip_hr_id
 where o.medical_trip_hr_id is not null
   and not exists (select 1 from public.employees e where e.hr_id = o.medical_trip_hr_id);

-- 4. The key, after a count that refuses.
do $$
declare
  orphans bigint;
begin
  select count(*) into orphans
    from public.outstation_expense_requests o
   where o.medical_trip_hr_id is not null
     and not exists (select 1 from public.employees e where e.hr_id = o.medical_trip_hr_id);
  if orphans > 0 then
    raise exception 'public.outstation_expense_requests.medical_trip_hr_id holds % row(s) naming no employee — repair them before this key', orphans;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.outstation_expense_requests'::regclass
                    and conname = 'outstation_expense_requests_medical_trip_phx_employee_fkey') then
    alter table public.outstation_expense_requests
      add constraint outstation_expense_requests_medical_trip_phx_employee_fkey
      foreign key (medical_trip_hr_id) references public.employees (hr_id)
      on update cascade on delete restrict not valid;
    alter table public.outstation_expense_requests
      validate constraint outstation_expense_requests_medical_trip_phx_employee_fkey;
  end if;
end $$;

commit;
