-- ============================================================================================
-- Retire the HR Business Partner seat ("HR Advisory"); recruiting goes to Talent Acquisition.
--
-- WHY THIS EXISTS
-- ---------------
-- The owner, 2026-10-08: "move recruiting off the HR Business Partner", then the same evening "no
-- more HR business partner. This title, no more ... everything regarding recruiting is for the
-- talent acquisition". Asked who takes the rest of the seat's work, he answered "Leave it for
-- system administrator now". The code side (same PR) empties the seat's grants, takes it out of
-- the User Access picker and refuses it server-side. This file does the database half.
--
-- THE REAL DEFECT THIS CLOSES. The Talent Acquisition seat ("HR Resourcing", live since #5552)
-- holds `recruiting` in the permission matrix, but the workflow registry never named it: every
-- recruitment and offers action, and the employee's own leave and calendar-dispute "submit",
-- listed "HR Advisory" and not "HR Resourcing". resolveWorkflowRegistryTransition refuses a role
-- the action does not list (workflow_role_not_allowed), so the seat's holder could open the
-- pipeline and move nothing in it, and could not file her own leave.
--
-- The key "HR Advisory" stays in the three CHECK constraints on purpose: the code keeps it as a
-- dormant PhoenixRole (retiredPhoenixRoles in src/lib/auth/permissions.ts) so that every
-- restriction written against it keeps applying. Nothing below may assign it, and nothing does.
--
-- FAIL CLOSED, NOT SIDEWAYS. The one account still carrying it (HR-010, is_active = false, resigned
-- 2026-09-14) becomes 'Employee', NOT 'HR Resourcing' — aliasing a departed holder to the successor
-- seat would be a privilege carry-forward. Same choice as 20260828140000.
--
-- VERIFIED LIVE against production (ozucdzovmcqvepbozvqf) on 2026-10-08 before writing:
--   workflow_registry_modules: recruitment 40 actions, offers 6, leave_requests 1,
--     private_calendar_data_disputes 1 name "HR Advisory"; NONE of the 48 also names
--     "HR Resourcing", so a text replace cannot produce a duplicate role in one action.
--   app_auth_users.role = 'HR Advisory' .............. 1 row  (HR-010, inactive)
--   user_access_profiles.phoenix_role ................ 1 row  (HR-010); legacy `role` 0 rows
--   auth.users raw_app_meta_data / raw_user_meta_data  1 row  (HR-010, key 'phoenix_role')
--   distribution_lists 'hr_team' ..................... roles {HR Advisory, HR Operations}
--   notification_role_policies 'retention_risk_alert'  {HR Operations, HR Advisory, Super Admin, SFE Manager}
--   functions, RLS policies and views naming it ...... 0
--
-- ROLLBACK. Every change is a small, named row edit; the pre-image is the list above. To undo:
-- replace '"HR Resourcing"' with '"HR Advisory"' in the same four modules' actions, put
-- 'HR Advisory' back into the two role arrays, and set HR-010 back to 'HR Advisory' in the four
-- places. Production has NO point-in-time recovery — the 7 daily backups are the whole story, so
-- this file is written to be reversed by hand, not restored.
-- ============================================================================================

-- 1. The workflow registry: the Talent Acquisition seat takes the retired seat's place, action
--    for action. Super-Admin-only actions (the offer approval) never named HR Advisory and are
--    untouched, so the recruiter who prepares an offer still cannot approve it.
update public.workflow_registry_modules
   set actions    = replace(actions::text, '"HR Advisory"', '"HR Resourcing"')::jsonb,
       updated_at = now(),
       updated_by = 'migration:20261008235900'
 where module_key in ('recruitment', 'offers', 'leave_requests', 'private_calendar_data_disputes')
   and actions::text like '%"HR Advisory"%';

-- 2. The HR Team distribution list. It resolves members by role at send time, so the retired seat
--    reaches nobody already; removed so the list says what it does.
update public.distribution_lists
   set roles       = array_remove(roles, 'HR Advisory'),
       description = 'The HR Operations seat, plus Omar Anwar (B-10) by name. The HR Business '
                  || 'Partner seat was on this list until it was retired on 2026-10-08.',
       updated_at  = now(),
       updated_by  = 'migration:20261008235900'
 where list_key = 'hr_team'
   and 'HR Advisory' = any (roles);

-- 3. The retention-risk alert. The stored row WINS over the code default in
--    src/lib/notifications/role-recipients.ts, so the code change alone would change nothing.
update public.notification_role_policies
   set roles       = array_remove(roles, 'HR Advisory'),
       description = 'Who is told when a MEDICAL REP reaches three consecutive working days of '
                  || 'recorded leave, or three consecutive working days with no CRM entry of any '
                  || 'kind, and has not been seen since (owner, 2026-09-07: medical reps only, '
                  || 'three days, still away). Defaults to HR Operations, Super Admin and SFE '
                  || 'Manager — the owner picked these with the HR Business Partner on '
                  || '2026-09-06, and that seat was retired on 2026-10-08. The person''s own line '
                  || 'manager is added per alert by the sweep itself and is deliberately NOT a '
                  || 'role here: it is one named manager per subject, not everyone holding a '
                  || 'manager role.',
       updated_at  = now(),
       updated_by  = 'migration:20261008235900'
 where notification_key = 'retention_risk_alert'
   and 'HR Advisory' = any (roles);

-- 4. The one account on the retired key. Inactive already; session_version is bumped anyway so a
--    session minted before today cannot keep presenting the old role.
update public.app_auth_users
   set role            = 'Employee',
       session_version = coalesce(session_version, 0) + 1,
       updated_at      = now()
 where role = 'HR Advisory';

update public.user_access_profiles
   set phoenix_role = 'Employee',
       updated_at   = now()
 where phoenix_role = 'HR Advisory';

-- The key is 'phoenix_role', not 'role' (20260828140000 records why that matters: jsonb_set on a
-- missing key would CREATE a stray key and leave the real one unchanged).
update auth.users
   set raw_app_meta_data = jsonb_set(raw_app_meta_data, '{phoenix_role}', '"Employee"'::jsonb)
 where raw_app_meta_data ->> 'phoenix_role' = 'HR Advisory';

update auth.users
   set raw_user_meta_data = jsonb_set(raw_user_meta_data, '{phoenix_role}', '"Employee"'::jsonb)
 where raw_user_meta_data ->> 'phoenix_role' = 'HR Advisory';

-- 5. Verification. Reads the same keys the writes above changed AND an independent text scan, so a
--    write to the wrong key cannot report a clean zero.
do $$
declare
  v_registry      int;
  v_resourcing    int;
  v_dupes         int;
  v_app_auth      int;
  v_profiles      int;
  v_auth_app      int;
  v_auth_user     int;
  v_lists         int;
  v_policies      int;
begin
  select count(*) into v_registry from public.workflow_registry_modules where actions::text like '%"HR Advisory"%';
  select count(*) into v_resourcing
    from public.workflow_registry_modules m, jsonb_array_elements(m.actions) a
   where m.module_key in ('recruitment', 'offers') and a->'allowedRoles' ? 'HR Resourcing';
  select count(*) into v_dupes
    from public.workflow_registry_modules m, jsonb_array_elements(m.actions) a
   where (select count(*) from jsonb_array_elements_text(a->'allowedRoles') r where r = 'HR Resourcing') > 1;
  select count(*) into v_app_auth  from public.app_auth_users where role = 'HR Advisory';
  select count(*) into v_profiles  from public.user_access_profiles where phoenix_role = 'HR Advisory';
  select count(*) into v_auth_app  from auth.users where raw_app_meta_data::text  like '%HR Advisory%';
  select count(*) into v_auth_user from auth.users where raw_user_meta_data::text like '%HR Advisory%';
  select count(*) into v_lists     from public.distribution_lists where 'HR Advisory' = any (roles);
  select count(*) into v_policies  from public.notification_role_policies where 'HR Advisory' = any (roles);

  if v_registry   <> 0  then raise exception 'workflow_registry_modules still names HR Advisory in % rows', v_registry; end if;
  if v_resourcing <  46 then raise exception 'expected HR Resourcing on at least 46 recruitment/offers actions, found %', v_resourcing; end if;
  if v_dupes      <> 0  then raise exception '% actions list HR Resourcing twice', v_dupes; end if;
  if v_app_auth   <> 0  then raise exception 'app_auth_users still has % rows on the retired seat', v_app_auth; end if;
  if v_profiles   <> 0  then raise exception 'user_access_profiles still has % rows on the retired seat', v_profiles; end if;
  if v_auth_app   <> 0  then raise exception 'auth.users app_metadata still names it in % rows', v_auth_app; end if;
  if v_auth_user  <> 0  then raise exception 'auth.users user_metadata still names it in % rows', v_auth_user; end if;
  if v_lists      <> 0  then raise exception 'distribution_lists still names it in % rows', v_lists; end if;
  if v_policies   <> 0  then raise exception 'notification_role_policies still names it in % rows', v_policies; end if;

  raise notice 'HR Business Partner seat retired: % recruitment/offers actions now name the Talent Acquisition seat', v_resourcing;
end $$;
