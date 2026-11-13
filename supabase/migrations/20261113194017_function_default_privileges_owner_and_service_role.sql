-- function_default_privileges_owner_and_service_role
--
-- WHAT THIS CHANGES: functions created from now on by the migration role (postgres), in any schema,
--   are executable by their owner and service_role only. PUBLIC — and so the anon role, through its
--   PUBLIC membership — no longer gets EXECUTE on a new function by default. No existing function's
--   privileges change.
-- WHY: S01, F-DB-009. The functions already in public were closed to PUBLIC and anon earlier; this
--   keeps new ones closed too. Postgres's built-in default gives EXECUTE to PUBLIC, and a per-schema
--   default can only ADD to it, never remove it — so the change is a global default for the role.
--   service_role is granted globally so the server keeps executing every new function, as it does
--   every existing one (590 of 590 in public). A new function that the browser role or a row-level
--   security policy must call takes its own explicit `grant execute ... to authenticated`.
-- ROLLBACK:
--   alter default privileges for role postgres grant execute on functions to public;
--   alter default privileges for role postgres revoke execute on functions from service_role;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here touches data or an existing object.

begin;

alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres grant execute on functions to service_role;

commit;
