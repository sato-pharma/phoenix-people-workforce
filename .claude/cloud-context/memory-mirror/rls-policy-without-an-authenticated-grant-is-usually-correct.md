---
name: rls-policy-without-an-authenticated-grant-is-usually-correct
description: "A public table with RLS enabled and no SELECT grant to `authenticated` is the NORM in this DB (258 of 326 tables), not the expense_claims bug repeating — check which client reads it before writing any grant migration"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2bd3db13-e571-41e3-97b5-ba614a644a7b
  modified: 2026-08-12T21:54:41.239Z
---

Measured on production `ozucdzovmcqvepbozvqf` 2026-08-13:

| `authenticated` has SELECT | public tables | all with RLS on |
| --- | --- | --- |
| **no** | **222** | 222 |
| yes | 86 | 86 |

So "RLS on, `authenticated` denied, PostgREST returns 42501" describes **two thirds of this
database** and is the intended posture, stated outright in
`20260812100100_public_default_privileges_grant_service_role.sql`: *"service_role ONLY … anon and
authenticated are deliberately not granted"*. See [[app-visibility-is-application-scoped-not-rls]].

**Why this bites.** The `expense_claims` 42501 incident (2026-08-12, PR #2065/#2066) makes
"policy exists but no grant" *look* like a defect class to sweep for. It is not. `expense_claims`
was real for one reason only: `listExpenseClaims` reads it with the **user's own session** via
`getSupabaseRlsClientIfAvailable()`, so the missing grant took a live route down. Absent such a
path, granting is a pure widening that exposes real HR rows to every logged-in JWT to satisfy
nothing.

## The test that actually decides it

`getSupabaseRlsClientIfAvailable()` is imported by **three** modules only — outstation claims-read,
outstation expenses, payroll service (re-verified 2026-08-13). There is **no browser Supabase
client anywhere in the repo**. So:

> If the table is not read by one of those three modules, it is service-role-only and the missing
> grant is correct. Fix the expectation, not the database.

Two decoys that do **not** mean a table is meant to be read by `authenticated`:

- **Policies `TO authenticated` that are inert.** `employee_probation` carries four
  `..._access` policies for `authenticated` from the 2026-07-11 baseline and has never had a grant
  behind them. Only 5 tables are in this state (also `app_auth_users`, `employee_documents`,
  `employee_history`, `users`).
- **A SECURITY INVOKER function `authenticated` may EXECUTE.** `fn_get_admin_command_center_data`
  and `fn_get_command_center_metrics` read `employee_probation` and are executable, but have zero
  callers in the repo.

## Settled cases — do not re-raise

`employee_probation` (0 rows) and `v2_vacation_requests` (311 rows) are **service-role-only by
design**, confirmed in staging and production. All ~51 app call sites between them use
`getSupabaseAdmin()`; `v2_vacation_requests` was revoked from anon/authenticated explicitly
pre-baseline. Closed 2026-08-13 by fixing `scripts/phase24-real-auth-rls-api-smoke.ts`, not by a
migration — see [[phase24-rls-smoke-cannot-run-locally]].

## How to apply

Before writing any `grant … to authenticated` migration: name the code path that reads the table
with a user session. If you cannot, there is no bug. Prove denial with
`has_table_privilege('authenticated', oid, 'SELECT')` plus a `set local role authenticated` probe —
42501 is *denied*, PGRST205/"could not find the table" is *absent*, and they mean opposite things.

## 2026-09-04 — re-measured: the posture is now MORE dominant, not less

| `authenticated` has SELECT | recorded 2026-08-13 | live 2026-09-04 |
| --- | --- | --- |
| **no** | **222** of 308 (72%) | **258** of 326 (**79%**) |
| yes | 86 | 68 |

Every one of the 326 public base tables has RLS enabled. So the claim did not merely survive
re-measurement — it strengthened: what looked like two thirds of the database is now four fifths.

**The test that decides it is unchanged and still exact.** `getSupabaseRlsClientIfAvailable` is
imported by **three** modules — `src/lib/outstation/claims-read.ts`, `src/lib/outstation/expenses.ts`,
`src/lib/payroll/service.ts`. A fourth file matches the grep and is `src/lib/supabase/rls-server.ts`,
the definition itself; counting it gives 4 and quietly breaks the rule this memory exists to state.

**`AGENTS.md` §2.1 carried the same stale pair and was corrected 2026-09-04 in PR #3094**, together
with `docs/agents-session-traps.md` and `docs/agents-memory-map.md`. The hook now leads with the
proportion — **~4 in 5 public tables (258 of 326, 2026-09-04)** — because a bare undated count in a
file that auto-loads on every request had already rotted twice. Nothing had regressed either time:
the schema grew (308 → 326 tables) and the `service_role`-only posture did not change, so an old
count under-reports **by design**, never because a grant went missing. Re-measure before quoting
either number:

```sql
select count(*) as total,
       count(*) filter (where c.relrowsecurity
         and not has_table_privilege('authenticated', c.oid, 'SELECT')) as rls_on_no_grant
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname = 'public';
```
