-- HR approval ownership:
-- A-16 remains HR review/follow-up. B-10 is the HR manager with Super Admin-equivalent authority.

update public.app_auth_users
set
  role = 'Super Admin',
  session_version = session_version + 1,
  updated_at = now()
where regexp_replace(lower(coalesce(nullif(hr_id, ''), nullif(login_id, ''), '')), '[^a-z0-9]', '', 'g') = 'b10'
  and role is distinct from 'Super Admin';
update public.app_auth_users
set
  role = 'HR Specialist',
  session_version = session_version + 1,
  updated_at = now()
where regexp_replace(lower(coalesce(nullif(hr_id, ''), nullif(login_id, ''), '')), '[^a-z0-9]', '', 'g') = 'a16'
  and role is distinct from 'HR Specialist';
delete from public.role_permission_overrides
where lower(role_name) = 'hr specialist'
  and lower(action) = 'approve';
