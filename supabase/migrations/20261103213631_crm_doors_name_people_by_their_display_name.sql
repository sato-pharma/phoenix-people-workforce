-- crm_doors_name_people_by_their_display_name
--
-- WHAT THIS CHANGES: the one person lookup behind crm_visits_unified and crm_checkins_unified now
-- carries the person's DISPLAY name (nickname, else full name), and a nickname edit rebuilds it.
-- Both name columns keep their names, so neither door's body changes.
-- WHY: owner, 2026-11-03: "change weam name in her account and everywhere in the system to Weaam
-- Gweed", then "One PR, legal stays". Every CRM screen prints agent_name / double_name from these
-- doors, so they all read the legal name while the rest of the system read the nickname.
-- ROLLBACK: restore the calc body and the three-column trigger from
-- 20261023153000_crm_person_by_hr_key_cache.sql, then select public.crm_person_by_hr_key_rebuild().
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create or replace function public.crm_person_by_hr_key_calc(p_hr_key text default null)
returns table (hr_key text, hr_id text, crm_id text, full_name text, full_name_nz text)
language sql
stable
security definer
rows 400
set search_path = 'public'
as $function$
  select distinct on (upper(btrim(e.hr_id)))
         upper(btrim(e.hr_id)) as hr_key,
         e.hr_id,
         e.crm_id,
         coalesce(nullif(btrim(e.nickname), ''), e.full_name) as full_name,
         nullif(btrim(coalesce(nullif(btrim(e.nickname), ''), e.full_name)), '') as full_name_nz
    from public.employees e
   where p_hr_key is null or upper(btrim(e.hr_id)) = p_hr_key
   order by upper(btrim(e.hr_id)), e.hr_id
$function$;

revoke execute on function public.crm_person_by_hr_key_calc(text) from public, anon, authenticated;
grant execute on function public.crm_person_by_hr_key_calc(text) to service_role;

drop trigger if exists crm_person_by_hr_key_sync on public.employees;
create trigger crm_person_by_hr_key_sync
  after insert or delete or update of hr_id, crm_id, full_name, nickname on public.employees
  for each statement
  execute function public.crm_person_by_hr_key_on_employee();

select public.crm_person_by_hr_key_rebuild();

do $check$
declare
  v_diff integer;
begin
  select count(*) into v_diff
    from (
      (select * from public.crm_person_by_hr_key_cache
        except
       select * from public.crm_person_by_hr_key_calc())
      union all
      (select * from public.crm_person_by_hr_key_calc()
        except
       select * from public.crm_person_by_hr_key_cache)
    ) d;
  if v_diff > 0 then
    raise exception 'crm_person_by_hr_key_cache disagrees with _calc() on % row(s), refusing to commit', v_diff;
  end if;
end
$check$;

commit;
