-- Repair legacy manager replacement ownership for live operational records.
--
-- Earlier lifecycle governance moved active employee reports away from resigned
-- managers, but open territory vacancies and future sales ownership can still
-- reference the resigned manager. This repair only moves rows when there is one
-- unambiguous active replacement occupying the same manager position.

with terminal_managers as (
  select
    hr_id,
    area_id,
    line_id,
    position_id,
    manager_hr_id,
    coalesce(last_working_date, resignation_date, updated_at::date, created_at::date, current_date) as effective_date
  from public.employees
  where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
),
replacement_candidates as (
  select
    t.hr_id as previous_hr_id,
    a.hr_id as replacement_hr_id,
    t.effective_date,
    count(*) over (partition by t.hr_id) as candidate_count
  from terminal_managers t
  join public.employees a
    on a.hr_id <> t.hr_id
   and a.area_id is not distinct from t.area_id
   and a.line_id is not distinct from t.line_id
   and a.position_id is not distinct from t.position_id
   and a.manager_hr_id is not distinct from t.manager_hr_id
   and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
   and coalesce(a.payroll_eligible, true) is true
   and coalesce(a.organogram_visible, true) is true
),
unique_replacements as (
  select previous_hr_id, replacement_hr_id, effective_date
  from replacement_candidates
  where candidate_count = 1
)
update public.position_vacancies v
set
  manager_hr_id = u.replacement_hr_id,
  manager_name = r.full_name,
  note = case
    when coalesce(v.note, '') ilike '%Replacement ownership repair:%' then v.note
    else concat_ws(
      E'\n',
      nullif(v.note, ''),
      'Replacement ownership repair: moved live vacancy manager from '
        || u.previous_hr_id || ' to ' || u.replacement_hr_id || ' on ' || current_date::text || '.'
    )
  end,
  updated_at = now()
from unique_replacements u
join public.employees r on r.hr_id = u.replacement_hr_id
where v.manager_hr_id = u.previous_hr_id
  and lower(coalesce(v.status, 'open')) = 'open';
do $$
begin
  if to_regclass('public.sales_records') is not null then
    execute $sql$
      with terminal_managers as (
        select
          hr_id,
          area_id,
          line_id,
          position_id,
          manager_hr_id,
          coalesce(last_working_date, resignation_date, updated_at::date, created_at::date, current_date) as effective_date
        from public.employees
        where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
      ),
      replacement_candidates as (
        select
          t.hr_id as previous_hr_id,
          a.hr_id as replacement_hr_id,
          t.effective_date,
          count(*) over (partition by t.hr_id) as candidate_count
        from terminal_managers t
        join public.employees a
          on a.hr_id <> t.hr_id
         and a.area_id is not distinct from t.area_id
         and a.line_id is not distinct from t.line_id
         and a.position_id is not distinct from t.position_id
         and a.manager_hr_id is not distinct from t.manager_hr_id
         and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
         and coalesce(a.payroll_eligible, true) is true
         and coalesce(a.organogram_visible, true) is true
      ),
      unique_replacements as (
        select previous_hr_id, replacement_hr_id, effective_date
        from replacement_candidates
        where candidate_count = 1
      )
      update public.sales_records s
      set manager_hr_id = u.replacement_hr_id
      from unique_replacements u
      where s.manager_hr_id = u.previous_hr_id
        and (
          s.year > extract(year from u.effective_date)::integer
          or (
            s.year = extract(year from u.effective_date)::integer
            and s.month >= extract(month from u.effective_date)::integer
          )
        )
    $sql$;
  end if;

  if to_regclass('public.sales_targets') is not null then
    execute $sql$
      with terminal_managers as (
        select
          hr_id,
          area_id,
          line_id,
          position_id,
          manager_hr_id,
          coalesce(last_working_date, resignation_date, updated_at::date, created_at::date, current_date) as effective_date
        from public.employees
        where lower(coalesce(employment_status, 'active')) in ('resigned', 'terminated', 'inactive')
      ),
      replacement_candidates as (
        select
          t.hr_id as previous_hr_id,
          a.hr_id as replacement_hr_id,
          t.effective_date,
          count(*) over (partition by t.hr_id) as candidate_count
        from terminal_managers t
        join public.employees a
          on a.hr_id <> t.hr_id
         and a.area_id is not distinct from t.area_id
         and a.line_id is not distinct from t.line_id
         and a.position_id is not distinct from t.position_id
         and a.manager_hr_id is not distinct from t.manager_hr_id
         and lower(coalesce(a.employment_status, 'active')) in ('active', 'on_leave')
         and coalesce(a.payroll_eligible, true) is true
         and coalesce(a.organogram_visible, true) is true
      ),
      unique_replacements as (
        select previous_hr_id, replacement_hr_id, effective_date
        from replacement_candidates
        where candidate_count = 1
      )
      update public.sales_targets s
      set manager_hr_id = u.replacement_hr_id
      from unique_replacements u
      where s.manager_hr_id = u.previous_hr_id
        and (
          s.year > extract(year from u.effective_date)::integer
          or (
            s.year = extract(year from u.effective_date)::integer
            and s.month >= extract(month from u.effective_date)::integer
          )
        )
    $sql$;
  end if;
exception
  when undefined_column then
    raise notice 'Replacement sales ownership repair skipped because expected sales manager/period columns are missing.';
end $$;
