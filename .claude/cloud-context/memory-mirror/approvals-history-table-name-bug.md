---
name: approvals-history-table-name-bug
description: "Approvals Hub history queries the v2_*/headers tables; older drafts named non-existent employee_excuses/employee_plans."
metadata: 
  node_type: memory
  type: project
  originSessionId: cc338e5f-624e-4207-a979-93c792fd4307
---

`getMyApprovalHistory()` in `src/lib/action-center/service.ts` powers the Approvals Hub
"Approval history" tab. It must query the REAL tables:
- excuses → **`v2_excuse_requests`** (NOT `employee_excuses` — does not exist)
- plans → **`employee_plan_headers`** (NOT `employee_plans`; it has no text decision column,
  so decision is derived from `status`: final_approved/hr_acknowledged→approved, *_returned→returned)
- vacation → `v2_vacation_requests`; resignations → `employee_resignations`.

Wrong table names silently returned nothing (Promise.allSettled swallows the error), so real
approved excuses/plans never appeared. Fixed in commits `2200ec3b` + `1e3083ba`.

Other hardening shipped `1e3083ba`:
- resignation + probation write-paths now normalize the actor to a canonical HR_ID before
  writing decision columns (login tokens like `admin-hr` must never be persisted there).
- history items now carry role-aware deep-link hrefs (`/employee-portals/approvals-hub` vs
  `/admin/approvals-hub` `?module=X&id=Y`). NOTE: `getActionCenterDeepLinkItem` only resolves
  the **excuse** module today — other modules land on the hub tab, not a rendered detail.
- History scope is intentionally the 4 people-ops modules only (owner decision): vacation,
  excuse, plans, resignation. Salary/sales/payroll/marketing/offers are corrected in DB for
  audit integrity but NOT surfaced in the history tab.

Related: [[phx1-system-admin-identity]].
