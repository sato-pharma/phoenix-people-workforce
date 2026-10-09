---
name: dropping-a-function-drops-its-acl-and-the-new-one-is-public
description: "`drop function` + `create` loses the ACL and the fresh function is executable by PUBLIC, so anon can call it through PostgREST — revoking only anon/authenticated is a no-op and revoking PUBLIC strips service_role"
metadata:
  node_type: memory
  type: project
  originSessionId: abf9f7ad-6d41-471f-84f7-43a58d29f3a1
  modified: 2026-10-09T20:12:51.323Z
---

Adding a parameter to an existing database function means **dropping and recreating it** (`create or
replace` with an extra parameter creates a second function and the old call then fails as "function
is not unique"). The drop takes the function's **ACL** with it, and a newly created function is
`EXECUTE` to **PUBLIC** by default — so through PostgREST `anon` can call it.

Measured on production 2026-10-09, minutes after applying
`20261009234500_sos_map_guard_lock_and_impact.sql`: the recreated
`sos_map_guard_decide_and_move_sales` read `proacl = {=X/postgres, postgres=X/postgres,
service_role=X/postgres}` and `has_function_privilege('anon', oid, 'EXECUTE')` was **true** — anon
could release a held customer mapping and move its sales. The repo's own
`scripts/check-migrations.mjs` is what caught it (required `validate` job), not a review.

**Why both halves are needed, every time:**
- `revoke ... from anon, authenticated` alone is a **no-op** — both inherit EXECUTE through PUBLIC
  membership. The revoke must name `public`.
- Revoking PUBLIC on a **default** ACL also strips `service_role`, which is the only role this app
  calls as (most code paths use the service-role client). So `grant execute ... to service_role;`
  must follow.
- Name **EXECUTE**, not `revoke all` — `revoke all` satisfies the checker but hides which privilege
  was meant.

**Why:** a function that moves money or mapping, left callable by anon, is an unauthenticated write
path; and the opposite mistake (revoke without re-grant) makes the function dead to the server with
a permission error the UI reports as a failed decision.

**How to apply:** when a migration drops and recreates a function, end it with
`revoke execute on function public.<fn>(<args>) from public, anon, authenticated;` then
`grant execute on function public.<fn>(<args>) to service_role;` — and verify live with
`has_function_privilege('anon', p.oid, 'EXECUTE')`, never by reading the migration.
Related: [[a-supabase-query-builder-then-returns-a-promiselike-with-no-catch]].
