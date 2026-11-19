-- salary_change_log_view_shows_actor_hr_id
--
-- WHAT THIS CHANGES:
--   public.v_employee_salary_change_log gains one column, actor_hr_id, appended at the end
--   (CREATE OR REPLACE VIEW can only append). The base table already stores it; the view never
--   showed it. Every other column, every join, the security_invoker option and the grants are
--   unchanged — the definition is 20261119035258's, word for word, plus that one column.
--
-- WHY (owner, 19 Nov 2026: "Build the screen"):
--   The Employee Master's Change History panel must name whoever changed a salary by DISPLAY name
--   (nickname, else full name — .claude/rules/employees.md, every screen). The view gives only
--   actor_name, the full name, and no HR id to look the display name up by. 35 of the 73 salary
--   log rows carry actor_hr_id; only 20 of the 66 with a login id resolve through app_auth_users,
--   so the login alone cannot stand in for it.
--
--   Deliberately NOT changed: actor_name's join reads coalesce(actor_hr_id, actor_login_id) as an
--   HR id, which the record view does not do. Rewriting it would change names already read
--   elsewhere; the panel no longer depends on it (it reads actor_hr_id, then the login through
--   app_auth_users, and only then actor_name).
--
-- ROLLBACK: a view cannot lose a column by CREATE OR REPLACE. Drop and re-create the view with
--   its 20261119035258 definition, then
--     revoke all on public.v_employee_salary_change_log from public, anon, authenticated;
--     grant select on public.v_employee_salary_change_log to service_role;
--   Nothing reads actor_hr_id from this view except the panel, which falls back without it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This touches no row: a view definition only.

begin;

create or replace view public.v_employee_salary_change_log
with (security_invoker = true) as
  select
    l.id,
    l.changed_at,
    l.employee_hr_id,
    e.full_name as employee_name,
    l.actor_login_id,
    a.full_name as actor_name,
    l.actor_source,
    l.changed_fields,
    l.old_values,
    l.new_values,
    l.write_channel,
    l.write_db_user,
    l.write_application,
    l.write_api_role,
    l.write_api_path,
    l.actor_hr_id
  from public.employee_salary_change_log l
  left join public.employees e on e.hr_id = l.employee_hr_id
  left join public.employees a on a.hr_id = coalesce(l.actor_hr_id, l.actor_login_id)
  order by l.changed_at desc;

revoke all on public.v_employee_salary_change_log from public, anon, authenticated;
grant select on public.v_employee_salary_change_log to service_role;

commit;
