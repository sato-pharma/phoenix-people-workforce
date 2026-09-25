---
name: revoke-from-public-strips-service-role-on-default-acl
description: "REVOKE EXECUTE ... FROM PUBLIC silently removes service_role's access when the function still has a default (NULL) ACL — always pair it with an explicit GRANT"
metadata: 
  node_type: memory
  type: project
  originSessionId: b33e06c8-f1fd-4ff6-91e5-9b925a03570b
  modified: 2026-08-01T17:35:38.142Z
---

`revoke execute on function f(...) from public` is **not** a no-op on a function whose `pg_proc.proacl`
is still NULL. A NULL ACL means "the built-in default", which includes an implicit EXECUTE grant to
PUBLIC. The first REVOKE **materialises** the ACL and drops the PUBLIC entry — and `service_role`
loses EXECUTE with it, because on such a function `service_role` holds EXECUTE *only* by being a
member of PUBLIC. Nothing errors; the next `service_role` call just starts failing.

Hit live on 2026-08-01 applying `20260801180000_cairo_date_in_lifecycle_and_seat_functions.sql`
to staging. Production's four target functions already had explicit ACLs
(`postgres=X | service_role=X`), so the revoke really was a no-op there. Staging's
`au.f_seat_occupant_asof` still had the default ACL, so after apply its ACL read `postgres=X` alone
— `service_role` had been silently stripped. Caught only because the verification query selected
`proacl` and `has_function_privilege('service_role', ...)` rather than just checking the body.

**Why:** `tests/migrations-secdef-revoke-guard.test.ts` requires every migration creating a public
SECURITY DEFINER function to self-revoke EXECUTE from PUBLIC. That guard is correct and must stay —
but satisfying it while relying on the *pre-existing* ACL for `service_role` makes the migration's
outcome depend on state it did not create, so it differs per environment.

**How to apply:** in any migration that revokes EXECUTE from PUBLIC, state the positive grant too:

```sql
revoke execute on function <schema>.<fn>(<args>) from public;
grant  execute on function <schema>.<fn>(<args>) to service_role;
```

Both are idempotent, and together they pin the same end state everywhere regardless of the prior
ACL. Verify with `has_function_privilege('service_role'|'anon'|'authenticated', oid, 'EXECUTE')`,
not by eyeballing the body — the body can be perfect while access is broken. Related:
[[app-visibility-is-application-scoped-not-rls]] (238 files call through `service_role`, so losing
that grant breaks the real path), [[list-migrations-reports-ledger-not-reality]].
