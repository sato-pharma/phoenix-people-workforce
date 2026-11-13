-- Phoenix Workforce role-alignment cleanup.
-- Removes legacy user_access_profiles admin policies left over after role alignment.
-- Replacement Super Admin policies are created by 20260511_phoenix_role_alignment.sql.

begin;

drop policy if exists user_access_profiles_insert_admin on public.user_access_profiles;
drop policy if exists user_access_profiles_delete_admin on public.user_access_profiles;

notify pgrst, 'reload schema';

commit;
