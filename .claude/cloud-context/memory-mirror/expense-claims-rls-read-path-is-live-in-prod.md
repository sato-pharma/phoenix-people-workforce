---
name: expense-claims-rls-read-path-is-live-in-prod
description: "PHOENIX_EXPENSE_CLAIMS_READ is true in production — expense_claims is read as `authenticated` under real RLS, the one live exception to \"visibility is application-scoped\""
metadata: 
  node_type: memory
  type: project
  originSessionId: 8031b3ca-9a44-46e9-aef8-a95699827cf6
  modified: 2026-08-14T12:28:32.770Z
---

Read live 2026-08-14 from `railway variables --environment production`:
**`PHOENIX_EXPENSE_CLAIMS_READ = true`**. So `listExpenseClaims` in
`src/lib/outstation/claims-read.ts` is the live read path for
`/api/admin/outstation/expenses`, and it runs
`(await getSupabaseRlsClientIfAvailable()) ?? getSupabaseAdmin()` — with a real user session that
resolves to the **`authenticated`** role, not service-role.

**Why this matters:** it is the one live exception to
[[app-visibility-is-application-scoped-not-rls]]. Row visibility on `expense_claims` really is
enforced by the Postgres policy `expense_claims_select_access`, not only by
`resolveExpenseAccessFilter`. Both are in force; the RLS half is easy to forget because every
other path is service-role.

The migration `20260812213000_expense_claims_select_rls.sql` narrates the flag being set back to
`false` after the 2026-08-12 incident (3.5h of 500s, `42501 permission denied`). **That narrative
is stale — it was re-enabled since.** Do not read the migration comment as current state.

Verified live in production (`ozucdzovmcqvepbozvqf`) on 2026-08-14: `authenticated` holds SELECT
only (no INSERT/UPDATE/DELETE), `relrowsecurity = true`, and the policy is source-aware —
`legacy_expense_id` rows answer to `phx_can_manage_payroll()`, `legacy_request_id` rows to
`phx_can_manage_outstation()`, plus a self/hierarchy branch that excludes resigned employees.
Zero errors on that route since 2026-08-12 20:38 UTC.

**How to apply:** before changing anything about `expense_claims` visibility, grants, or the
outstation expenses read, remember BOTH gates are live. Widening the policy widens real access to
payroll data. And per [[rls-policy-without-an-authenticated-grant-is-usually-correct]], this table
is the rare case where the `authenticated` grant is genuinely correct — do not "clean it up".
