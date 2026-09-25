---
name: hr-approval-authority
description: "HR approval governance: only Super Admin approves HR workflows; HR Specialist (incl. designated A-16) has NO approve. B-10 (Omar Anwar Gawish) is already Super Admin = approver. PR #36."
metadata: 
  node_type: memory
  type: project
  originSessionId: 77132691-db3d-4ec1-bf67-fd48dae8b4a4
---

Requirement (user): HR Specialist must NOT approve anything; approvals belong to "Admin-HR" + "B-10".

Resolved identities (verified read-only on PROD ozucdzovmcqvepbozvqf):
- **Admin-HR = the Super Admin role** (user's definition).
- **B-10 = Omar Anwar Gawish, HR Manager, HR_ID `B-10`** — already has role **Super Admin** in app_auth_users → already an approver. So NO allowlist needed; both approvers are covered by Super Admin.
- **A-16 = designated HR Specialist** (`designatedHrSpecialistHrId = "a16"` in permissions.ts) — role HR Specialist → loses approval with the HR Specialist change.

Fix (branch codex/hr-approval-authority-fix, commit a34cf14b, PR #36 → main, NOT merged):
1. `src/lib/auth/permissions.ts` — added `allActionsNoApprove` const; stripped `approve` from EVERY resource in the "HR Specialist" matrix row. (Matrix is the primary gate: leave/resignations/contracts/expenses/outstation/deductions/weekly_plans/support/marketing approval all flow through `assertPermission(resource,"approve")` → now denied for HR Specialist, incl. A-16 who falls through to the matrix in canAccess.)
2. `src/lib/probation/service.ts` — `hrProbationRoles` Set → `{Super Admin}` only (probation pass/terminate/createEvaluation are gated by isProbationAdministrator, a ROLE-SET bypass, NOT the matrix). SIDE EFFECT: also removes HR Specialist probation read/export (admin+approval share one gate) — flagged to user; can split if they want HR Specialist to keep probation VIEW.
3. `src/lib/offers/approval-chain.ts` — `computeRequiredApprovers` "HR Manager" step role "HR Specialist" → "Super Admin".
4. `tests/expense-risk-hardening.test.ts` — was asserting HR Specialist HAS expenses/outstation approve; updated to assert NO approve anywhere.

Key learnings / gotchas:
- Approval bypasses outside the matrix that I had to check: probation `hrProbationRoles`/`isProbationAdministrator`; offers approval-chain step roles; `outstation/admin-access.ts adminOutstationRoles`; `payroll/expenses.ts manualPayrollExpenseApproverRoles`. The outstation + payroll role-sets call `assertPermission(...,"approve")` FIRST, so the matrix change already blocks them — left their role-sets intact (they also govern read/workspace access). vacation `decideVacationRequest` also gates via `assertPermission(access,"leave","approve")` → matrix handles it; vacation 325/1286 are visibility/notifications only.
- `role_permission_overrides` (prod) cols: role_name, resource, action, is_allowed. Checked: HR Specialist has overrides only for coaching/communication/imports/overview (no approve) → code change is authoritative.
- NOT live-approval (left as-is, they're visibility/scope/notifications/display-only): contracts isCompanyContractReader, hiring-documents filterHiringDocumentsForAccess, scopeForRole, recruitment manage roles, weekly-planning notification recipients, workflow-control/definitions (Phase-1 Super-Admin-only, display/simulation), supabase-identity mapping.
- No DB migration — pure code; live once merged+deployed. B-10 already Super Admin so approves immediately.

MERGED + DEPLOYED 2026-06-07: PR #36 merged to main (merge commit a8ab40bc); production auto-deployed (domain 200). The chain is LIVE: HR Specialist (incl. A-16) can no longer approve anything; Super Admin (Admin-HR + B-10/Omar) approves.

PROBATION VIEW REFINEMENT (commit 32fa1e0c, in PR #36 per user "yes viewing but no take action or approval"): split the probation gate — `isProbationAdministrator` (Super Admin only) governs ACTIONS (pass/terminate/createEvaluation/manager feedback, lines ~138/334/776); new exported `canViewAllProbation` (Super Admin + HR Specialist) governs read (canReadProbationEmployee) + export (assertCanExportProbation). So HR Specialist/A-16 can VIEW + export probation but take no action. (Generic HR Specialists still gated by canAccess to employee_profile only; effectively A-16 is the HR Specialist who can view.)

Optional follow-up smoke (needs real prod login): A-16 (HR Specialist) gets Forbidden on any approve/probation-action but can view probation; Omar B-10 (Super Admin) can approve.
