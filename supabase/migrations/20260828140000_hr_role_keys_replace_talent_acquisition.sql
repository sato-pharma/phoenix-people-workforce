-- ============================================================================================
-- Retire the "Talent Acquisition" permission ROLE; introduce "HR Advisory" + "HR Operations".
--
-- WHY THIS EXISTS
-- ---------------
-- "Talent Acquisition" was a JOB TITLE used as a permission key. The person holding it resigned
-- (A-16, employment_status = resigned, resignation_date 2026-08-31), so the key now names nobody.
-- This is the SECOND time the same mistake has cost a rename plus a migration -- "HR Specialist"
-- was retired the same way in 2026-06. The owner's instruction on 2026-08-28 was to stop naming
-- roles after job titles, so the two replacements are named for CAPABILITIES and are composed
-- from a catalogue of HR functions (src/lib/auth/hr-functions.ts), not from a person's title.
--
-- The JOB TITLE "Talent Acquisition" is NOT retired and is deliberately untouched below --
-- employees.job_title, offers and candidate records still name it historically, and rewriting a
-- historical fact about a person is not a rename, it is a falsification. Only the ROLE moves.
--
-- FAIL CLOSED, NOT SIDEWAYS
-- -------------------------
-- The one row still carrying the retired role becomes 'Employee', NOT one of the new seats.
-- Aliasing a retired role to its successor reads as continuity and is a privilege carry-forward:
-- the holder has left, the account is is_active = false, and normalizeRole() is what a stale JWT's
-- app_metadata passes through. src/lib/auth/permissions.ts makes the same choice for the same
-- reason, and tests/hr-function-governance.test.ts asserts it. The two new hires starting
-- 2026-09-01 have their role written explicitly at provisioning and never pass through this path.
--
-- ALSO FIXED HERE: two CHECK constraints were already missing 'Financial Advisor', which is a
-- live PhoenixRole. Assigning it would have failed at the database with a constraint violation
-- and no clue why. Found while rewriting these lists; folded in rather than left for later.
--
-- VERIFIED LIVE against production (ozucdzovmcqvepbozvqf) on 2026-08-28 before writing:
--   app_auth_users.role = 'Talent Acquisition' .............. 1 row  (A-16, inactive, resigned)
--   user_access_profiles.phoenix_role = 'Talent Acquisition'  1 row  (same person)
--   user_access_profiles.role         ilike '%talent%' ...... 0 rows (the legacy key is unused)
--   auth.users raw_app_meta_data ->> 'phoenix_role' ......... 1 row  (same person; NOT ->>'role')
--   auth.users raw_user_meta_data ->> 'phoenix_role' ........ 1 row
--   roles (key = 'talent_acquisition') ...................... 1 row
--   notification_role_policies (roles @> ...) ............... 1 row  (resignation_workflow_alert)
--   workflow_registry_modules.actions ilike ................. 6 rows
--   role_permission_overrides.role_name ilike ............... 0 rows
--   employees.job_title ilike ............................... 1 row  -- LEFT ALONE, see above
--
-- ORDER MATTERS: constraints are dropped BEFORE the data moves and re-added AFTER, or the update
-- is rejected by the very list it is updating.
-- ============================================================================================

begin;

-- --------------------------------------------------------------------------------------------
-- 1. Drop the three CHECK constraints that enumerate the role list.
-- --------------------------------------------------------------------------------------------
alter table public.app_auth_users            drop constraint if exists app_auth_users_role_check;
alter table public.user_access_profiles      drop constraint if exists user_access_profiles_phoenix_role_check;
alter table public.notification_role_policies drop constraint if exists notification_role_policies_roles_check;

-- --------------------------------------------------------------------------------------------
-- 2. Move the data. The retired role resolves DOWN to Employee.
-- --------------------------------------------------------------------------------------------
update public.app_auth_users
   set role = 'Employee'
 where role = 'Talent Acquisition';

update public.user_access_profiles
   set phoenix_role = 'Employee'
 where phoenix_role = 'Talent Acquisition';

-- The legacy lower-case key column. Zero rows carry it today; written anyway so a row created
-- between this migration being authored and applied is not left behind.
update public.user_access_profiles
   set role = 'employee'
 where role = 'talent_acquisition';

-- Supabase auth metadata. Two separate JSON documents, and a session reads app_metadata, so a row
-- missed here keeps handing out the retired role until the user next signs in.
--
-- THE KEY IS 'phoenix_role', NOT 'role'. This was written as '{role}' first, and the mistake is
-- worth recording because it was self-concealing: jsonb_set on a missing key would have CREATED a
-- stray "role" key, the real "phoenix_role" would have kept saying Talent Acquisition, and the
-- verification block at the bottom -- which asked the same wrong key -- would have reported a
-- clean zero. A check that reads the same wrong field as the write it is checking proves nothing.
-- Confirmed live 2026-08-28: the one row is A-16, and both documents carry "phoenix_role".
update auth.users
   set raw_app_meta_data = jsonb_set(raw_app_meta_data, '{phoenix_role}', '"Employee"'::jsonb)
 where raw_app_meta_data ->> 'phoenix_role' = 'Talent Acquisition';

update auth.users
   set raw_user_meta_data = jsonb_set(raw_user_meta_data, '{phoenix_role}', '"Employee"'::jsonb)
 where raw_user_meta_data ->> 'phoenix_role' = 'Talent Acquisition';

-- --------------------------------------------------------------------------------------------
-- 3. The `roles` lookup table: one retired row becomes two.
-- --------------------------------------------------------------------------------------------
delete from public.roles where key = 'talent_acquisition';

insert into public.roles (key, name, description, is_system)
values
  ('hr_advisory',   'HR Advisory',
   'Recruiting, engagement and retention, probation, workforce insight, HR governance. Composed from HR functions in src/lib/auth/hr-functions.ts -- not a job title.',
   false),
  ('hr_operations', 'HR Operations',
   'Personnel records, time and attendance, payroll inputs, probation, HR governance. Composed from HR functions in src/lib/auth/hr-functions.ts -- not a job title.',
   false)
on conflict (key) do update
  set name        = excluded.name,
      description = excluded.description;

-- --------------------------------------------------------------------------------------------
-- 4. Notification audience. Resignations belong to HR Operations, not HR Advisory: resignations
--    live in the people_records function, which only HR Operations holds. The stored row WINS
--    over the code default in src/lib/notifications/role-recipients.ts, so changing the code
--    without this update would have changed nothing in production.
-- --------------------------------------------------------------------------------------------
update public.notification_role_policies
   set roles = array['Super Admin', 'HR Operations'],
       description = 'Who is told when a resignation is submitted or changes state. Owner-set '
                  || '2026-08-09 as Super Admin + Talent Acquisition; that seat was retired '
                  || '2026-08-28 and its resignations grant went to HR Operations. Deliberately '
                  || 'NOT the CEO and NOT the leaver''s manager chain. Editable here, not in code.',
       updated_at = now()
 where notification_key = 'resignation_workflow_alert';

-- --------------------------------------------------------------------------------------------
-- 5. Workflow registry. Six modules name the retired role inside actions[].allowedRoles, and they
--    split along the SAME function boundary as the permission matrix -- which is the point of a
--    function catalogue, and worth stating rather than leaving as a coincidence:
--
--      recruitment, offers ....... HR Advisory   (the recruiting function)
--      contracts, resignations ... HR Operations (the people_records function)
--      leave_requests, private_calendar_data_disputes ...... BOTH
--          Those two name EVERY role, because their one matching action is the employee's own
--          "submit" -- self-service, not an HR authority. Mapping them to a single successor
--          would silently remove the other seat's ability to file her own leave.
-- --------------------------------------------------------------------------------------------
update public.workflow_registry_modules
   set actions   = replace(actions::text, '"Talent Acquisition"', '"HR Advisory"')::jsonb,
       updated_at = now(),
       updated_by = 'migration:20260828140000'
 where module_key in ('recruitment', 'offers')
   and actions::text like '%Talent Acquisition%';

update public.workflow_registry_modules
   set actions   = replace(actions::text, '"Talent Acquisition"', '"HR Operations"')::jsonb,
       updated_at = now(),
       updated_by = 'migration:20260828140000'
 where module_key in ('contracts', 'resignations')
   and actions::text like '%Talent Acquisition%';

update public.workflow_registry_modules
   set actions   = replace(actions::text, '"Talent Acquisition"', '"HR Advisory", "HR Operations"')::jsonb,
       updated_at = now(),
       updated_by = 'migration:20260828140000'
 where module_key in ('leave_requests', 'private_calendar_data_disputes')
   and actions::text like '%Talent Acquisition%';

-- --------------------------------------------------------------------------------------------
-- 6. private.phx_current_role(): the RLS-side role resolver. Its 'talent_acquisition' branch
--    reads the legacy lower-case user_access_profiles.role, which zero rows carry -- so the branch
--    is dead today. Rewritten anyway, because a dead branch returning a role that no longer exists
--    is exactly the shape that comes back to life quietly. Both new seats are self-scoped at the
--    RLS layer, so neither needs a mapping of its own here: phoenix_role is read directly by the
--    coalesce above this CASE, and phx_current_scope() already sends anything unlisted to 'SELF'.
-- --------------------------------------------------------------------------------------------
create or replace function private.phx_current_role()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(
    (
      select coalesce(
        uap.phoenix_role,
        case uap.role
          when 'super_admin' then 'Super Admin'
          when 'admin' then 'Super Admin'
          when 'company_reader' then 'CEO'
          when 'finance' then 'Finance Manager'
          -- 'talent_acquisition' retired 2026-08-28. It resolves DOWN to Employee, never sideways
          -- to a successor seat: the only holder had already left, and this function feeds RLS.
          when 'talent_acquisition' then 'Employee'
          when 'hr' then 'Employee'
          when 'manager' then 'Manager'
          else 'Employee'
        end
      )
      from public.user_access_profiles uap
      where uap.auth_user_id = (select auth.uid())
        and coalesce(uap.is_active, true) = true
      order by uap.updated_at desc nulls last
      limit 1
    ),
    (
      select aau.role
      from public.app_auth_users aau
      where aau.auth_user_id = (select auth.uid())
        and coalesce(aau.is_active, true) = true
      order by aau.updated_at desc nulls last
      limit 1
    ),
    'Employee'
  );
$function$;

-- --------------------------------------------------------------------------------------------
-- 7. Re-add the CHECK constraints, now matching phoenixRoles exactly (17 values).
--    'Talent Acquisition' is GONE from all three. 'Financial Advisor' is ADDED to the two that
--    were missing it. Keep these in the same order as src/lib/auth/permissions.ts so a future
--    diff between the two is readable.
-- --------------------------------------------------------------------------------------------
alter table public.app_auth_users
  add constraint app_auth_users_role_check check (role = any (array[
    'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
    'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
    'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
    'Manager', 'CEO', 'Super Admin'
  ]));

alter table public.user_access_profiles
  add constraint user_access_profiles_phoenix_role_check check (
    phoenix_role is null or phoenix_role = any (array[
      'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
      'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
      'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
      'Manager', 'CEO', 'Super Admin'
    ])
  );

alter table public.notification_role_policies
  add constraint notification_role_policies_roles_check check (roles <@ array[
    'Employee', 'Medical Rep', 'District Manager', 'Regional Manager', 'National Sales Manager',
    'Product Manager', 'Group Product Manager', 'SFE Manager', 'Training Manager',
    'Marketing Manager', 'Finance Manager', 'Financial Advisor', 'HR Advisory', 'HR Operations',
    'Manager', 'CEO', 'Super Admin'
  ]);

-- --------------------------------------------------------------------------------------------
-- 8. Prove it, in the same transaction, so a partial apply rolls back rather than half-landing.
--    Each of these is a count taken AFTER the work, not a restatement of the intent.
-- --------------------------------------------------------------------------------------------
do $$
declare
  v_app_auth       integer;
  v_profiles       integer;
  v_profiles_legacy integer;
  v_auth_app       integer;
  v_auth_user      integer;
  v_roles_old      integer;
  v_roles_new      integer;
  v_policies       integer;
  v_workflows      integer;
  v_wf_advisory    integer;
  v_wf_operations  integer;
  v_titles         integer;
begin
  select count(*) into v_app_auth        from public.app_auth_users where role = 'Talent Acquisition';
  select count(*) into v_profiles        from public.user_access_profiles where phoenix_role = 'Talent Acquisition';
  select count(*) into v_profiles_legacy from public.user_access_profiles where role = 'talent_acquisition';
  -- Deliberately matched on the whole document, not on a named key. The named-key check is what
  -- hid the bug above; a substring sweep cannot be fooled by looking in the wrong place.
  select count(*) into v_auth_app        from auth.users where raw_app_meta_data::text  like '%Talent Acquisition%';
  select count(*) into v_auth_user       from auth.users where raw_user_meta_data::text like '%Talent Acquisition%';
  select count(*) into v_roles_old       from public.roles where key = 'talent_acquisition';
  select count(*) into v_roles_new       from public.roles where key in ('hr_advisory', 'hr_operations');
  select count(*) into v_policies        from public.notification_role_policies where 'Talent Acquisition' = any (roles);
  select count(*) into v_workflows       from public.workflow_registry_modules where actions::text like '%Talent Acquisition%';
  select count(*) into v_wf_advisory     from public.workflow_registry_modules where actions::text like '%HR Advisory%';
  select count(*) into v_wf_operations   from public.workflow_registry_modules where actions::text like '%HR Operations%';
  select count(*) into v_titles          from public.employees where job_title ilike '%Talent Acquisition%';

  if v_app_auth <> 0 then raise exception 'app_auth_users still has % rows on the retired role', v_app_auth; end if;
  if v_profiles <> 0 then raise exception 'user_access_profiles.phoenix_role still has % rows', v_profiles; end if;
  if v_profiles_legacy <> 0 then raise exception 'user_access_profiles.role still has % legacy rows', v_profiles_legacy; end if;
  if v_auth_app <> 0 then raise exception 'auth.users app_metadata still names the retired role in % rows', v_auth_app; end if;
  if v_auth_user <> 0 then raise exception 'auth.users user_metadata still names the retired role in % rows', v_auth_user; end if;
  if v_roles_old <> 0 then raise exception 'roles still carries talent_acquisition'; end if;
  if v_roles_new <> 2 then raise exception 'expected 2 new role rows, found %', v_roles_new; end if;
  if v_policies <> 0 then raise exception 'notification_role_policies still names the retired role'; end if;
  if v_workflows <> 0 then raise exception 'workflow_registry_modules still names it in % rows', v_workflows; end if;
  if v_wf_advisory < 2 then raise exception 'expected HR Advisory in at least 2 workflow modules, found %', v_wf_advisory; end if;
  if v_wf_operations < 2 then raise exception 'expected HR Operations in at least 2 workflow modules, found %', v_wf_operations; end if;

  -- The JOB TITLE must SURVIVE. If this ever reads 0, something rewrote a historical fact about a
  -- real employee, which is the opposite of what this migration is for.
  if v_titles <> 1 then
    raise exception 'employees.job_title should still carry the historical title on exactly 1 row, found %', v_titles;
  end if;

  raise notice 'HR role keys migrated: role retired everywhere, job title preserved on % employee row(s)', v_titles;
end $$;

commit;
