-- Marketing Manager (A-9) had a per-user Modules Control sidebar curation
-- (sidebar_module_assignments, target_type='user') created out-of-band on
-- 2026-06-22 by a prior session. moduleIdAllowed() in
-- src/lib/navigation/active-path.ts treats any non-null assignment list as an
-- exhaustive allowlist, so every sidebar item added or renamed after that
-- date (My Workspace, Marketing Overview, the dedicated MM Sales
-- Intelligence dashboards, Team Operations) was silently hidden for her even
-- though the role-level defaults in system-navigation.ts already grant them.
-- Deleting the stale override restores the full default sidebar for every
-- active Marketing Manager (matching/exceeding GPM's portal access).
delete from sidebar_module_assignments
where navigation_mode = 'admin'
  and (
    (target_type = 'role' and lower(target_key) = 'marketing manager')
    or (
      target_type = 'user'
      and lower(target_key) in (
        select lower(hr_id) from app_auth_users where role = 'Marketing Manager' and hr_id is not null
        union
        select lower(login_id) from app_auth_users where role = 'Marketing Manager' and login_id is not null
      )
    )
  );
