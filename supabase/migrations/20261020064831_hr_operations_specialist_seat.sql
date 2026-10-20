-- hr_operations_specialist_seat
--
-- WHAT THIS CHANGES: opens the HR Operations Specialist seat — the role key "HR Administration"
--   (src/lib/auth/hr-functions.ts, HR_ROLE_BUNDLES["HR Administration"], shown as "HR Operations
--   Specialist" by HR_SEAT_JOB_TITLES).
--   1. The three CHECK constraints that enumerate phoenixRoles admit the one new value, in
--      phoenixRoles order, and public.roles gets its lookup row.
--   2. Six workflow-registry actions let the seat act: her own vacation request
--      (leave_requests.submit) and calendar dispute (private_calendar_data_disputes.submit), the
--      contract HR review and signed upload (contracts.contract_hr_review, contract_upload_signed),
--      and following a resignation through (resignations.resignation_mark_review,
--      resignation_complete). Approving, rejecting, cancelling, creating, renewing or not renewing
--      stay with the roles that hold them today.
--   3. The resignation_workflow_alert audience gains the seat, so she is told when one is submitted,
--      and its description and the probation-milestone email policy's description say who is told
--      now (probation milestones go to the owner alone since this change).
-- WHY: owner, 2026-10-20 — a tailored account for the HR employee now on "HR Operations": contract
--   renewals "track and prepare papers", resignations "i submit the emp resigned she recieves
--   notification and start folloeing up until he comes to office to do fillfill resignation cycle",
--   and she submits her own vacation. "HR Operations" stays as it is (shown "HR Generalist") for a
--   future hire. Keyed by capability, not job title, for the reason
--   20260828140000_hr_role_keys_replace_talent_acquisition.sql gives.
-- ROLLBACK: nobody may hold the role first (move the account back), then remove 'HR Administration'
--   from the six actions' allowedRoles and from resignation_workflow_alert.roles, delete the roles
--   row 'hr_administration', and re-add the three constraints without it — the exact lists in
--   20261008193000_hr_resourcing_role_key.sql.
--
-- Nothing is assigned here: no account holds the role until the owner's login moves after deploy.
-- Additive only — every value the constraints allowed before is still allowed, and each list is
-- widened only where the value is missing, so a re-run changes nothing.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: three constraints widened, one lookup row, six jsonb arrays and one role list.

begin;

alter table public.app_auth_users             drop constraint if exists app_auth_users_role_check;
alter table public.user_access_profiles       drop constraint if exists user_access_profiles_phoenix_role_check;
alter table public.notification_role_policies drop constraint if exists notification_role_policies_roles_check;

alter table public.app_auth_users
  add constraint app_auth_users_role_check check (role = any (array[
    'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
    'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
    'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
    'HR Resourcing', 'HR Administration', 'Manager', 'CEO', 'Super Admin'
  ]));

alter table public.user_access_profiles
  add constraint user_access_profiles_phoenix_role_check check (
    phoenix_role is null or phoenix_role = any (array[
      'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
      'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
      'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
      'HR Resourcing', 'HR Administration', 'Manager', 'CEO', 'Super Admin'
    ])
  );

alter table public.notification_role_policies
  add constraint notification_role_policies_roles_check check (roles <@ array[
    'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
    'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
    'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
    'HR Resourcing', 'HR Administration', 'Manager', 'CEO', 'Super Admin'
  ]);

insert into public.roles (key, name, description, is_system)
values (
  'hr_administration',
  'HR Administration',
  'Shown as HR Operations Specialist. Daily and weekly fingerprint and field reports reviewed row by row for the HR Manager to decide, the Employee Master without any salary, contract renewals and resignations followed through, and HR reminders. Never payroll, never a salary. Composed from HR functions in src/lib/auth/hr-functions.ts -- not a job title.',
  false
)
on conflict (key) do update
  set name        = excluded.name,
      description = excluded.description;

-- The six workflow actions. One statement per module keeps each row's other actions untouched.
update public.workflow_registry_modules as m
set
    actions = (
        select jsonb_agg(
            case
                when (m.module_key, elements.action->>'key') in (
                    ('leave_requests', 'submit'),
                    ('private_calendar_data_disputes', 'submit'),
                    ('contracts', 'contract_hr_review'),
                    ('contracts', 'contract_upload_signed'),
                    ('resignations', 'resignation_mark_review'),
                    ('resignations', 'resignation_complete')
                )
                and not (elements.action->'allowedRoles') ? 'HR Administration'
                then jsonb_set(
                    elements.action,
                    '{allowedRoles}',
                    (elements.action->'allowedRoles') || '["HR Administration"]'::jsonb
                )
                else elements.action
            end
            order by elements.ordinality
        )
        from jsonb_array_elements(m.actions) with ordinality as elements(action, ordinality)
    ),
    updated_by = 'migration:20261020064831'
where m.module_key in ('leave_requests', 'private_calendar_data_disputes', 'contracts', 'resignations');

update public.notification_role_policies
set
    roles = roles || array['HR Administration'],
    updated_at = now(),
    updated_by = 'migration:20261020064831'
where notification_key = 'resignation_workflow_alert'
  and not ('HR Administration' = any (roles));

-- The stored description says what the code default says (src/lib/notifications/role-recipients.ts),
-- because a stored row wins over the default and the recipients console shows this text.
update public.notification_role_policies
set
    description = 'Who is told when a resignation is submitted or changes state. Owner-set 2026-08-09 (the Talent Acquisition seat, retired 2026-08-28, now HR Generalist): Super Admin and HR Generalist, and since 2026-10-20 the HR Operations Specialist, who follows each resignation through until the leaver completes the cycle at the office. Deliberately NOT the CEO and NOT the leaver''s manager chain. While the HR Generalist seat is empty its copy is the Super Admin''s. Editable here rather than in code.',
    updated_at = now(),
    updated_by = 'migration:20261020064831'
where notification_key = 'resignation_workflow_alert';

-- Probation Day 30/60/75 emails now go to the owner alone (owner, 2026-10-20: "To you only"); the
-- email control centre shows this description.
update public.email_notification_policies
set description = 'Probation Day 30 / 60 / 75 milestone emails — To Omar Gawish alone.'
where notification_type = 'probation_milestone';

-- Prove it in the same transaction, so a partial apply rolls back rather than half-landing.
do $$
declare
  v_constraints integer;
  v_role_rows   integer;
  v_actions     integer;
  v_alert       integer;
begin
  select count(*) into v_constraints
    from pg_constraint
   where contype = 'c'
     and conname in (
       'app_auth_users_role_check',
       'user_access_profiles_phoenix_role_check',
       'notification_role_policies_roles_check'
     )
     and pg_get_constraintdef(oid) like '%HR Administration%';
  if v_constraints <> 3 then
    raise exception 'expected HR Administration in 3 role CHECK constraints, found %', v_constraints;
  end if;

  select count(*) into v_role_rows from public.roles where key = 'hr_administration' and name = 'HR Administration';
  if v_role_rows <> 1 then
    raise exception 'expected 1 roles row for hr_administration, found %', v_role_rows;
  end if;

  select count(*) into v_actions
    from public.workflow_registry_modules m, jsonb_array_elements(m.actions) a
   where (m.module_key, a->>'key') in (
           ('leave_requests', 'submit'),
           ('private_calendar_data_disputes', 'submit'),
           ('contracts', 'contract_hr_review'),
           ('contracts', 'contract_upload_signed'),
           ('resignations', 'resignation_mark_review'),
           ('resignations', 'resignation_complete')
         )
     and (a->'allowedRoles') ? 'HR Administration';
  if v_actions <> 6 then
    raise exception 'expected HR Administration on 6 workflow actions, found %', v_actions;
  end if;

  select count(*) into v_alert
    from public.notification_role_policies
   where notification_key = 'resignation_workflow_alert' and 'HR Administration' = any (roles);
  if v_alert <> 1 then
    raise exception 'expected HR Administration on resignation_workflow_alert, found %', v_alert;
  end if;
end $$;

commit;
