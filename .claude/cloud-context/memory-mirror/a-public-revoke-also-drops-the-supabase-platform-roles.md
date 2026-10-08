---
name: a-public-revoke-also-drops-the-supabase-platform-roles
description: "Revoking EXECUTE FROM PUBLIC on a function also silently drops supabase_etl_admin and supabase_read_only_user, which hold USAGE on `private` — benign only because both carry rolbypassrls and can read the tables directly, so check that before calling such a revoke behaviour-neutral."
metadata:
  node_type: memory
  type: project
  originSessionId: 35b44469-be05-434e-98f8-ff8164de6273
---

Measured 2026-10-08 on production while tightening `private.phx_visible_hr_ids()` and
`private.phx_resigned_hr_ids()` from the built-in `EXECUTE TO PUBLIC` default to an explicit
`authenticated, service_role` grant (PR #5482).

**A `revoke execute … from public` reaches more roles than `anon` and `authenticated`.** These two
Supabase platform roles also hold USAGE on the `private` schema and lost EXECUTE:

| role | `rolbypassrls` | `private` USAGE | can SELECT `public.employees` |
| --- | --- | --- | --- |
| `supabase_etl_admin` | true | yes | yes |
| `supabase_read_only_user` | true | yes | yes |

**Why it was still safe here, and the test to apply next time:** both bypass RLS, so they never
evaluate a policy that calls the helper, and both can already read the underlying tables — so
EXECUTE on the helper granted them no capability they lacked. Losing it removes nothing; it only
means a DIRECT call to that function from, say, a read-only dashboard query would now error.
Reversible with one `grant execute … to supabase_read_only_user`.

**So "effective access unchanged" is a claim about the roles you enumerated, not about PUBLIC.**
Before describing a PUBLIC revoke as behaviour-neutral, list every role with USAGE on the function's
schema and check each one's `rolbypassrls` and direct table privileges — not just `anon` and
`authenticated`:

```sql
select r.rolname, r.rolbypassrls,
       has_schema_privilege(r.rolname, '<schema>', 'USAGE') as schema_usage,
       has_function_privilege(r.rolname, '<schema>.<fn>()', 'EXECUTE') as fn_exec
  from pg_roles r where has_schema_privilege(r.rolname, '<schema>', 'USAGE');
```

A peer session caught this one after the merge, not the PR author. See
[[a-declined-supabase-mcp-apply-is-not-a-no]] for the apply path, and
[[a-ledger-version-never-matches-the-file]] — `apply_migration` stamped its own version here, so the
file's own 14 digits had to be inserted by hand to stop a later `db push` replaying it.
