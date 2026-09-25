---
name: job-title-not-a-permission-source
description: "Governance rule — a job title is display-only and never grants access; roles come from the explicit app role + org structure + permission matrix, never title text."
metadata: 
  node_type: memory
  type: project
  originSessionId: 09e010be-e932-48d6-a83f-33ab86eaad44
---

Phoenix governance rule (user directive, 2026-06-05): **a job title is descriptive only and must never be a permission source.** Access + notification routing derive from the explicit app role (`app_auth_users.role`), the permission matrix, and org structure (`manager_hr_id`, department, line, area/team, configured approver) — never from the words in a title (e.g. the literal "Manager" in "Finance Manager").

**Why:** HR Specialist is NOT a manager; HR Manager is a manager-level *title* but its access must be assigned explicitly; R&D Manager = "Research and Development Manager" label only (not admin); Admin Assist / QPPV / Buffet / Office Co-ordinator / Regulatory Affairs / Financial Advisor get no elevation from title; "District Sales Manager" ≠ the "District Manager" role unless explicitly mapped by a business rule.

**How to apply:**
- `resolveEmployeeAccessRole` ([src/lib/employees/access-role.ts](src/lib/employees/access-role.ts)) now **always returns "Employee"** — every auto-provisioned account (manual create, bulk import, offer approval, all via `provisionNewHireAccess`) starts least-privilege; admins elevate explicitly. Do NOT re-introduce title→role inference here.
- `tryParseRole`/`normalizeRole` in [permissions.ts](src/lib/auth/permissions.ts) is an **explicit-app-role parser** (+ legacy role codes admin/account-admin/dsm/nsm), NOT a title interpreter. The elevating title aliases `hr manager→Manager`, `talent acquisition→HR Specialist`, `r&d manager→Manager` were removed. `parseRoleStrict` is only ever fed explicit roles (stored role, admin assignment, workflow allowedRoles, dev param) — never `job_title`.
- Notification recipients ([notifications/policy.ts](src/lib/notifications/policy.ts)) already resolve by manager_hr_id / manager chain / explicit approver / permission+org-scope, fail-closed — no title-based recipient logic. Keep it that way.
- Tests: [tests/title-permission-governance.test.ts](tests/title-permission-governance.test.ts) + governance assertions in [employee-access-provisioning.test.ts](tests/employee-access-provisioning.test.ts) lock this in.

**Job-function migration (DONE — commit 867a1048):** `normalizeRole` is now fully title-free. Job-function classification for *non-security* business rules lives in **`resolveJobFunctionRole(title)`** ([src/lib/employees/job-function.ts](src/lib/employees/job-function.ts)) — it reproduces the old title→category mapping (incl. non-canonical "Medical Representative"/"District Sales Manager"/"Regional Sales Manager"/"DSM") and is used by: outstation allowance tiers + employee_role ([outstation/service.ts](src/lib/outstation/service.ts) ×4), employee-portal routing/line-comparison ([employee-portal/service.ts](src/lib/employee-portal/service.ts) ×6), coaching portal mode ([coaching/portal-access.ts](src/lib/coaching/portal-access.ts)), portal nav ([employee-portal/navigation.ts](src/lib/employee-portal/navigation.ts) resolvePortalRole), and the submit-expense redirect. RULE GOING FORWARD: classify job function via `resolveJobFunctionRole`, parse explicit app roles via `normalizeRole` — never feed a job title to `normalizeRole`/`parseRoleStrict`.

**Pre-deploy safety check (before this ships to staging/prod):** verify no `app_auth_users.role` value is literally a removed title ("HR Manager", "Talent Acquisition", "R&D Manager") — those would now fail-closed to Employee / reject. Related: [[supabase-dual-project-schema]].
