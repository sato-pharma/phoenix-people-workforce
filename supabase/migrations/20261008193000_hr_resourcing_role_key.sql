-- Open the Talent Acquisition seat: the role key "HR Resourcing" joins the role lists.
--
-- The owner built this seat on 2026-10-08 from his own ticks on the access blueprint. In the code it
-- is a bundle of HR functions (src/lib/auth/hr-functions.ts, HR_ROLE_BUNDLES["HR Resourcing"]),
-- shown everywhere as "Talent Acquisition" (HR_SEAT_JOB_TITLES). Keyed by capability, not job title,
-- for the reason 20260828140000_hr_role_keys_replace_talent_acquisition.sql retired the old
-- "Talent Acquisition" role: a title used as a permission key strands the day its holder leaves.
--
-- Three CHECK constraints enumerate phoenixRoles, so without this an account cannot be GIVEN the
-- role at all — the write is refused. This adds the one value to all three, in phoenixRoles order,
-- and the lookup row the user-access screens list roles from.
--
-- Nothing is assigned here. No user holds the role until the owner creates her account, and the
-- notification audiences are untouched: no notification_role_policies row is changed, so she is
-- sent nothing until he decides who receives what.
--
-- Additive only: every value the constraints allowed before is still allowed, so no existing row
-- can fail the re-added constraint.

begin;

alter table public.app_auth_users             drop constraint if exists app_auth_users_role_check;
alter table public.user_access_profiles       drop constraint if exists user_access_profiles_phoenix_role_check;
alter table public.notification_role_policies drop constraint if exists notification_role_policies_roles_check;

alter table public.app_auth_users
  add constraint app_auth_users_role_check check (role = any (array[
    'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
    'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
    'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
    'HR Resourcing', 'Manager', 'CEO', 'Super Admin'
  ]));

alter table public.user_access_profiles
  add constraint user_access_profiles_phoenix_role_check check (
    phoenix_role is null or phoenix_role = any (array[
      'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
      'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
      'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
      'HR Resourcing', 'Manager', 'CEO', 'Super Admin'
    ])
  );

alter table public.notification_role_policies
  add constraint notification_role_policies_roles_check check (roles <@ array[
    'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
    'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
    'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
    'HR Resourcing', 'Manager', 'CEO', 'Super Admin'
  ]);

insert into public.roles (key, name, description, is_system)
values (
  'hr_resourcing',
  'HR Resourcing',
  'Shown as Talent Acquisition. Recruiting pipeline, CV lookup, the HR support and business-card desks, and read-only workforce context. Composed from HR functions in src/lib/auth/hr-functions.ts -- not a job title.',
  false
)
on conflict (key) do update
  set name        = excluded.name,
      description = excluded.description;

-- Prove it in the same transaction, so a partial apply rolls back rather than half-landing.
do $$
declare
  v_constraints integer;
  v_role_rows   integer;
begin
  select count(*) into v_constraints
    from pg_constraint
   where contype = 'c'
     and conname in (
       'app_auth_users_role_check',
       'user_access_profiles_phoenix_role_check',
       'notification_role_policies_roles_check'
     )
     and pg_get_constraintdef(oid) like '%HR Resourcing%';
  if v_constraints <> 3 then
    raise exception 'expected HR Resourcing in 3 role CHECK constraints, found %', v_constraints;
  end if;

  select count(*) into v_role_rows from public.roles where key = 'hr_resourcing' and name = 'HR Resourcing';
  if v_role_rows <> 1 then
    raise exception 'expected 1 roles row for hr_resourcing, found %', v_role_rows;
  end if;
end $$;

commit;
