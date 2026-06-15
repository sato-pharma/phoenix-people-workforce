do $$
declare
  a3_policy_id bigint;
  default_policy_id bigint;
begin
  select id
    into a3_policy_id
  from public.attendance_policy_groups
  where target_type = 'employee_hr_id'
    and upper(trim(coalesce(target_value, ''))) = 'A-3'
    and policy_name = 'A-3 office-based Monday/Wednesday policy'
  order by effective_from asc, id desc
  limit 1;

  if a3_policy_id is null then
    insert into public.attendance_policy_groups (
      policy_name,
      target_type,
      target_value,
      scheduled_start,
      scheduled_end,
      grace_minutes,
      is_active,
      effective_from,
      effective_to,
      working_weekdays
    )
    values (
      'A-3 office-based Monday/Wednesday policy',
      'employee_hr_id',
      'A-3',
      time '09:30',
      time '14:30',
      10,
      true,
      date '1900-01-01',
      null,
      array[1, 3]::smallint[]
    )
    returning id into a3_policy_id;
  else
    update public.attendance_policy_groups
       set policy_name = 'A-3 office-based Monday/Wednesday policy',
           target_type = 'employee_hr_id',
           target_value = 'A-3',
           scheduled_start = time '09:30',
           scheduled_end = time '14:30',
           grace_minutes = 10,
           is_active = true,
           effective_from = date '1900-01-01',
           effective_to = null,
           working_weekdays = array[1, 3]::smallint[],
           updated_at = now()
     where id = a3_policy_id;
  end if;

  update public.attendance_policy_groups
     set scheduled_start = time '09:30',
         scheduled_end = time '14:30',
         grace_minutes = 10,
         working_weekdays = array[1, 3]::smallint[],
         updated_at = now()
   where target_type = 'employee_hr_id'
     and upper(trim(coalesce(target_value, ''))) = 'A-3'
     and id <> a3_policy_id
     and is_active is true;

  if not exists (
    select 1
    from public.attendance_policy_rules
    where policy_id = a3_policy_id
  ) then
    select id
      into default_policy_id
    from public.attendance_policy_groups
    where target_type = 'default'
      and is_active is true
      and effective_from <= date '1900-01-01'
      and (effective_to is null or effective_to >= date '1900-01-01')
    order by effective_from desc, id desc
    limit 1;

    if default_policy_id is not null and exists (
      select 1
      from public.attendance_policy_rules
      where policy_id = default_policy_id
    ) then
      insert into public.attendance_policy_rules (
        policy_id,
        event_type,
        from_minutes,
        to_minutes,
        recommended_action,
        deduction_days,
        deduction_value,
        is_active,
        sort_order
      )
      select
        a3_policy_id,
        event_type,
        from_minutes,
        to_minutes,
        recommended_action,
        deduction_days,
        deduction_value,
        is_active,
        sort_order
      from public.attendance_policy_rules
      where policy_id = default_policy_id
      order by sort_order, id;
    else
      insert into public.attendance_policy_rules (
        policy_id,
        event_type,
        from_minutes,
        to_minutes,
        recommended_action,
        deduction_days,
        deduction_value,
        is_active,
        sort_order
      )
      values
        (a3_policy_id, 'late', 11, 30, 'Review late arrival - quarter day recommendation', 0.25, null, true, 1),
        (a3_policy_id, 'late', 31, 45, 'Review late arrival - half day recommendation', 0.50, null, true, 2),
        (a3_policy_id, 'late', 46, null, 'Review late arrival - full day recommendation', 1.00, null, true, 3),
        (a3_policy_id, 'early_leave', 11, 30, 'Review early leave - quarter day recommendation', 0.25, null, true, 4),
        (a3_policy_id, 'early_leave', 31, 45, 'Review early leave - half day recommendation', 0.50, null, true, 5),
        (a3_policy_id, 'early_leave', 46, null, 'Review early leave - full day recommendation', 1.00, null, true, 6),
        (a3_policy_id, 'single_punch', null, null, 'Review missing punch', 0.50, null, true, 7);
    end if;
  end if;
end $$;
