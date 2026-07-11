-- Coaching authority: add Product Manager + Group Product Manager as field coaches.
--
-- Background: the application permission matrix (defaultPermissionMatrix) grants
-- Product Manager and Group Product Manager `coaching: read/create/update`, and
-- canManageCoachingReports() treats them as coaches. The coaching lifecycle, however,
-- is gated at runtime by the workflow registry (workflow_registry_modules), whose
-- coaching_reports module only allowed Training Manager + Super Admin — so a PM/GPM
-- creating a coaching report received a hard "Forbidden: Workflow Registry does not
-- allow Product Manager to run coaching_reports.create_draft" on submit.
--
-- This migration aligns the registry with the matrix by adding the two roles to the
-- coaching lifecycle actions (create_draft, update_draft, submit, lock). Read/list
-- visibility and own-draft write scoping are still enforced in the coaching service
-- (coachingOversightRoles + assertOwnDraftOrOverride), so a coach can only edit their
-- own drafts; this change only unblocks the lifecycle transitions for these roles.
--
-- Drift-safe + idempotent: it appends the two roles to whatever allowedRoles already
-- exist for those actions and de-duplicates, preserving action order and any other
-- roles. Re-running it is a no-op.

update public.workflow_registry_modules m
set
  actions = (
    select jsonb_agg(
      case
        when (action ->> 'key') in ('create_draft', 'update_draft', 'submit', 'lock')
        then jsonb_set(
          action,
          '{allowedRoles}',
          (
            select jsonb_agg(role_name order by role_name)
            from (
              select distinct role_name
              from (
                select jsonb_array_elements_text(action -> 'allowedRoles') as role_name
                union
                select unnest(array['Product Manager', 'Group Product Manager']) as role_name
              ) merged
            ) deduped
          )
        )
        else action
      end
      order by ord
    )
    from jsonb_array_elements(m.actions) with ordinality as t(action, ord)
  ),
  updated_by = 'system',
  updated_at = now()
where m.module_key = 'coaching_reports';

-- Guard: surface a clear error if the coaching module row is missing (registry not seeded).
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from public.workflow_registry_modules
  where module_key = 'coaching_reports';

  if v_count = 0 then
    raise exception 'coaching_reports workflow registry module not found; seed migration must run first';
  end if;
end $$;
