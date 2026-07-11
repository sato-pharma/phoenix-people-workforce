-- Defense-in-depth grant hardening for attendance_exceptions.
--
-- The original attendance_exceptions migration (20260611000000) enabled RLS and
-- created a service_role-only policy, but -- unlike every sibling attendance table
-- (attendance_device_user_map, attendance_raw_punches, attendance_policy_groups,
-- attendance_policy_rules) -- it never revoked the default table-level privileges
-- from anon/authenticated. RLS with only a service_role policy already blocks
-- anon/authenticated access today, and the Phoenix app only ever reaches this
-- table through the service-role admin client. This migration closes the remaining
-- defense-in-depth gap and removes the staging/production grant drift by matching
-- the sibling tables' lockdown exactly. It is idempotent and safe to re-run.

begin;

revoke all on table public.attendance_exceptions from anon, authenticated;

grant select, insert, update, delete on table public.attendance_exceptions to service_role;
grant usage, select on sequence public.attendance_exceptions_id_seq to service_role;

notify pgrst, 'reload schema';

commit;
