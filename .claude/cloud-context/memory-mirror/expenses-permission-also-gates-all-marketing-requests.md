---
name: expenses-permission-also-gates-all-marketing-requests
description: "The `expenses` permission gates outstation expenses AND the entire /api/marketing-requests/** namespace — removing it from a role silently kills their marketing approval rung."
metadata: 
  node_type: memory
  type: project
  originSessionId: ae189d07-172a-45ce-b429-270b6b1adcf8
  modified: 2026-08-10T09:16:22.526Z
---

`expenses:read` does **two unrelated jobs**. It gates the Outstation expense claims, and it gates the
**whole `/api/marketing-requests/** namespace`** — see the ~20 entries in
`src/lib/security/access-registry.ts`, including `/api/marketing-requests/:id/decision` and
`/api/marketing-requests/finance-evidence`, plus `WorkspaceExpenseDashboardPage` and the
`/workspace/marketing-requests/*` pages via `requireAdminShellEmployeeWorkspaceAccess`.

**Why:** removing `expenses` from a role to take them out of Outstation also 403s every marketing
approval/execution action they hold. Hit live on 2026-08-10: the owner asked to exclude the Finance
Manager (B-185) "100% from outstation or expenses" the same morning he had activated that role's
terminal `finance_execution` marketing rung. Deleting the key would have made the rung a dead end
nobody could clear.

**How to apply:** to remove a role from Outstation, delete the **`outstation`** key and set
`getExpensesScope` to SELF — that closes every outstation page, route and hub. Keep `expenses` at a
bare `["read"]` only if the role has a marketing rung, and pin an explicit `allowedRoles` on
`/workspace/expense-dashboard` (it admits any `adminShellEmployeeRole` holding `expenses:read`).
Pinned by `tests/phase22-role-matrix-security.test.ts`. The permanent fix is to move the marketing
routes onto their own resource, after which `expenses` can be dropped outright.

Related: [[railway-merge-is-the-production-deploy]]
