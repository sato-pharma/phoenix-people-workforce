---
name: public-schema-default-acl-grants-authenticated
description: "Both Supabase projects (staging + prod) have a default ACL that auto-grants EXECUTE on new public-schema functions to `authenticated` — revoke from public is not enough"
metadata:
  node_type: memory
  type: project
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

**Confirmed via `pg_default_acl` on staging (cifwmndunmlxjhyjugxa) 2026-07-18:** the `public` schema has a project-level default ACL for functions (`defaclobjtype='f'`): `{postgres=X, authenticated=X, service_role=X}`. Any NEW function created in `public` by the `postgres` role automatically grants EXECUTE to `authenticated` at creation time — a DIRECT grant to that role, not routed through `PUBLIC`.

**Why this matters:** the standard hardening pattern used everywhere else in this codebase — `revoke execute ... from public; grant execute ... to service_role;` — does NOT undo this. `REVOKE ... FROM PUBLIC` only removes the PUBLIC pseudo-role grant; it leaves a direct grant to `authenticated` untouched. Any `public.phx_*` RPC migration that skips an EXPLICIT `revoke execute ... from authenticated` silently ships callable by any Supabase-authenticated session via PostgREST — bypassing every app-layer permission/workflow check that normally gates it (assertPermission, canSeeEmployee, resignation workflow validation, etc.), since PostgREST calls the function directly with no app code in between.

Confirmed this default does NOT apply to the `au` schema (only `public`) — `au.resign_occupant` and other `au.*` RPCs are unaffected. Pre-existing `public.phx_*` functions (e.g. `phx_monthly_closing_matrix`) don't have the `authenticated` grant either, meaning their migrations already included the explicit revoke (or predate this default ACL rule) — this is not a new/regressed issue, just an easy one-line omission for any FUTURE public-schema RPC.

**How to apply:** every new `public.phx_*`/`public.*` function migration must include, right after creation:
```sql
revoke execute on function public.fn_name(arg_types) from public;
revoke execute on function public.fn_name(arg_types) from authenticated;
grant execute on function public.fn_name(arg_types) to service_role;
```
Always verify post-apply via `select proacl from pg_proc where proname = 'fn_name'` — should show ONLY the owner + `service_role`, nothing else. Caught this on the `phx_resign_employee_and_open_vacancy` RPC (see [[resignation-transactional-rpc-authored]]) before it reached production — same check should be run for any prior `public`-schema RPC in this codebase that might have missed it.
