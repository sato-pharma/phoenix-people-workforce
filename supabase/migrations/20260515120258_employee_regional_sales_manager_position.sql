-- Add Regional Sales Manager as a supported employee master position.
-- This migration only seeds the lookup row. It does not reassign DSMs; hierarchy
-- follows employees.manager_hr_id so HR can move only the selected DSMs under the RSM.

do $$
declare
  v_sales_department_id bigint;
  v_position_id bigint;
begin
  select id
    into v_sales_department_id
  from public.departments
  where lower(trim(coalesce(code, ''))) = 'sales'
     or lower(trim(name)) = 'sales'
  order by case when lower(trim(coalesce(code, ''))) = 'sales' then 0 else 1 end, id
  limit 1;

  select id
    into v_position_id
  from public.positions
  where lower(trim(code)) in ('regional_sales_manager', 'regional_manager', 'rsm')
     or lower(trim(title)) in ('regional sales manager', 'regional manager', 'rsm')
  order by
    case when lower(trim(code)) = 'regional_sales_manager' then 0 else 1 end,
    case when lower(trim(title)) = 'regional sales manager' then 0 else 1 end,
    id
  limit 1;

  if v_position_id is null then
    insert into public.positions (
      department_id,
      code,
      title,
      description,
      is_active,
      created_at,
      updated_at
    )
    values (
      v_sales_department_id,
      'regional_sales_manager',
      'Regional Sales Manager',
      'Sales leadership tier reporting to the National Sales Manager and managing selected DSMs.',
      true,
      now(),
      now()
    )
    returning id into v_position_id;
  else
    update public.positions
    set
      department_id = coalesce(v_sales_department_id, department_id),
      code = 'regional_sales_manager',
      title = 'Regional Sales Manager',
      description = coalesce(description, 'Sales leadership tier reporting to the National Sales Manager and managing selected DSMs.'),
      is_active = true,
      updated_at = now()
    where id = v_position_id;
  end if;

  update public.positions p
  set is_active = false, updated_at = now()
  where p.id <> v_position_id
    and (
      lower(trim(p.code)) in ('regional_sales_manager', 'regional_manager', 'rsm')
      or lower(trim(p.title)) in ('regional sales manager', 'regional manager', 'rsm')
    )
    and not exists (
      select 1
      from public.employees e
      where e.position_id = p.id
    );

  raise notice 'Regional Sales Manager position is ready with id %.', v_position_id;
end $$;
