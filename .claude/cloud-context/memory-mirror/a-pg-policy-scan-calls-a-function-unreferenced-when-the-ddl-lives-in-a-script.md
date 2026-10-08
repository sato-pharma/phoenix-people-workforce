---
name: a-pg-policy-scan-calls-a-function-unreferenced-when-the-ddl-lives-in-a-script
description: "A `pg_policy` scan proves nothing about whether an RLS helper is safe to revoke EXECUTE on, because it only sees policies that exist RIGHT NOW. `current_access_can_see_employee` returned zero policies on both production and staging, yet `scripts/phase25-staging-rls-mutation-smoke.ts` and `phase26-staging-browser-auth-mutation-smoke.ts` CREATE policies `to authenticated` whose `using` clause calls it - so the revoke would have broken every authenticated read of employee_probation and v2_vacation_requests the next time a smoke ran. Before revoking EXECUTE on any helper, grep the repo for the NAME as well as scanning pg_policy: policy DDL living in a script is a live reference the catalog cannot see."
metadata:
  node_type: memory
  type: project
---

🔴 **A `pg_policy` SCAN ANSWERS "IS THIS CALLED TODAY", NEVER "IS THIS SAFE TO REVOKE".** Measured
2026-10-08 while narrowing the Supabase linter's
`authenticated_security_definer_function_executable` finding on production.

Four `public` access helpers looked unreferenced, and on the live catalog all four were clean on
every axis — **zero** RLS policies, calling function bodies, views, column defaults, check
constraints and non-pin `pg_depend` rows, on production **and** staging:

```
current_access_can_see_employee(text,text)   policies: 0
current_access_is_admin()                    policies: 0
current_access_line()                        policies: 0
current_access_manager_hr_id()               policies: 0
```

**One of them was load-bearing anyway.** `scripts/phase25-staging-rls-mutation-smoke.ts` and
`scripts/phase26-staging-browser-auth-mutation-smoke.ts` each `create policy … to authenticated` on
`public.employee_probation` and `public.v2_vacation_requests` with

```sql
using (
  public.current_access_can_manage_employees()
  or public.current_access_can_see_employee(employee_hr_id, manager_hr_id)
)
```

A policy expression is evaluated as the **querying** role, so the revoke would have made every
authenticated read of those two tables fail with `permission denied for function
current_access_can_see_employee` — but only from the next smoke run onward, which is the worst
possible delay between cause and symptom.

**So the rule: scan the catalog AND grep the repo for the NAME.** Policy DDL that lives in a
migration, a smoke script or a repair SQL file is a real reference the catalog cannot see, because
the policy does not exist until something runs it. The grep is what caught this; `pg_policy` said
it was safe.

🔴 **AND READ THE HISTORY BEFORE RE-DOING A GRANT CHANGE — this exact revoke had already been tried
and reversed inside 48 hours.** `supabase/20260509_live_admin_auth_security_repair.sql` revoked
EXECUTE from `public, anon, authenticated` on all four; `supabase/20260511_phoenix_role_alignment.sql`
two days later revoked only from `public, anon` and **granted it back to `authenticated`** on every
one, which is the state the 2026-07-11 baseline records. That is not proof the first revoke broke
something — 05-11 is a uniform alignment pass, not an incident fix — but a grant shape that was
deliberately chosen once deserves evidence before it is narrowed, and `git grep` over
`supabase/*.sql` is where that evidence lives.

Outcome: three revoked, one kept, the exclusion pinned by an assertion inside the migration, and the
count measured on the linter's own predicate fell **14 → 11**. Related:
[[a-public-revoke-also-drops-the-supabase-platform-roles]] ·
[[verify-the-emitted-artifact-never-the-source]]
