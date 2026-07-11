-- Correct the HR Specialist retirement workflow registry mapping.
--
-- Talent Acquisition may prepare recruitment/offer work, but must not inherit
-- approval or hire-conversion authority from the retired HR Specialist role.

begin;

update public.workflow_registry_modules wrm
set
  actions = coalesce((
    select jsonb_agg(
      case
        when action_item.action ? 'allowedRoles' then
          jsonb_set(
            action_item.action,
            '{allowedRoles}',
            coalesce((
              select jsonb_agg(to_jsonb(role_name) order by first_seen)
              from (
                select role_name, min(role_index) as first_seen
                from (
                  select
                    case
                      when role_text = 'HR Specialist' and not restricted_action.is_restricted then 'Talent Acquisition'
                      when role_text in ('HR Specialist', 'Talent Acquisition') and restricted_action.is_restricted then null
                      else role_text
                    end as role_name,
                    role_item.role_index
                  from jsonb_array_elements(action_item.action -> 'allowedRoles') with ordinality as role_item(role_value, role_index)
                  cross join lateral (
                    select role_item.role_value #>> '{}' as role_text
                  ) role_text_value
                ) mapped_roles
                where role_name is not null
                group by role_name
              ) deduped_roles
            ), '[]'::jsonb)
          )
        else action_item.action
      end
      order by action_item.action_index
    )
    from jsonb_array_elements(wrm.actions) with ordinality as action_item(action, action_index)
    cross join lateral (
      select case
        when wrm.module_key = 'offers' then action_item.action ->> 'key' in (
          'offer_chain_approve',
          'offer_chain_reject',
          'offer_hire_approve'
        )
        when wrm.module_key = 'recruitment' then action_item.action ->> 'key' in (
          'app_offer_approved',
          'app_offer_approval_rejected',
          'app_hire'
        )
        else false
      end as is_restricted
    ) restricted_action
  ), '[]'::jsonb),
  updated_by = 'harden_hr_specialist_offer_approval_roles',
  updated_at = now()
where wrm.module_key in ('recruitment', 'offers')
  and (
    wrm.actions::text like '%"HR Specialist"%'
    or wrm.actions::text like '%"Talent Acquisition"%'
  );

do $$
begin
  if exists (
    select 1
    from public.workflow_registry_modules wrm
    cross join lateral jsonb_array_elements(wrm.actions) action_item(action)
    where (
      (wrm.module_key = 'offers' and action_item.action ->> 'key' in (
        'offer_chain_approve',
        'offer_chain_reject',
        'offer_hire_approve'
      ))
      or (wrm.module_key = 'recruitment' and action_item.action ->> 'key' in (
        'app_offer_approved',
        'app_offer_approval_rejected',
        'app_hire'
      ))
    )
    and exists (
      select 1
      from jsonb_array_elements_text(action_item.action -> 'allowedRoles') role_name
      where role_name in ('HR Specialist', 'Talent Acquisition')
    )
  ) then
    raise exception 'Restricted offer/recruitment approval actions still include retired HR roles';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
