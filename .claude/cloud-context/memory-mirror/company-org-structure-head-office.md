---
name: company-org-structure-head-office
description: "Company structure — Head Office (line_id=4, الإدارة) serves all lines; 3 business lines each have a PM/GPM reporting to the MM. Head-office managers' teams are defined by manager_hr_id, NOT line."
metadata:
  node_type: memory
  type: reference
  originSessionId: 77d1b67e-6071-4e33-b292-07ab1e57d207
---

Owner-explained company structure (2026-06-28), critical for ALL scope/visibility logic:

- **Head Office / الإدارة = `line_id = 4`** — a cross-cutting "office" that serves ALL business lines. Seats here: Marketing Manager (MM), SFE Manager, CEO, HR, Training Manager (TM), Finance, etc. These are company/department-level roles, NOT tied to one business line.
- **3 business lines** (`line_id` 1, 2, 3) — each has its own **Product Manager (PM) or Group Product Manager (GPM)**, and those PM/GPM sit **under the MM's supervision** in the Marketing department.

**Implication:** a head-office department head's team is defined by the **reporting edge (`manager_hr_id`)**, NOT by their line. The MM (A-9, line 4) supervises PM/GPM who are *intentionally* on the business lines (different `line_id`s). So any LINE-scoped visibility rule that filters "same line + same department" WRONGLY drops a head-office manager's cross-line direct reports. The fix is to ALSO include direct reports via the live `manager_hr_id` / vacant-seat edge (`reportsToManagerSeat`), regardless of line — NOT to broaden the manager to whole business lines. Shipped for vacation in PR #574 ([[local-browser-verify-gotchas]] context). The same line-vs-reporting-edge trap likely exists in other LINE-scoped modules (coaching, expenses, double-visit) — check before "fixing" by line.

Prod data snapshot: A-9 MM (line 4) ← reports: A-8 Rasha (GPM, line 2, "she"), A-10 Nahed (PM, line 1), A-7 Ahmed (TM, line 4). `employees` has `line_id`, `line_name`(null), `manager_hr_id`, `pending_manager_replacement_for_hr_id`, `department_name`(null) — NO `role` column (role is app-resolved). See [[employees-line-name-not-line]], [[seat-continuity-resolver]], [[mm-portal-audit-2026-06-27]].

**Cross-domain audit (PR #574 — MERGED to main 2026-06-28, squash 180a4225) — which domains had the head-office LINE gap:**
- FIXED: **vacation** (LINE filter + reportsToManagerSeat for direct reports), **expenses** (added MM to `PORTAL_HIERARCHY_EXPENSE_ROLES` → full downward chain; read/export only, MM can't approve), **vacancies** (`getEmployeePortalVacancies` → MM company-scoped via `canAccessCompanyOrganogram`, matching organogram), **sales/ROI** (`computeSalesAccessScope` → MM's own head-office line bridges to no product line, so scope to direct reports' lines via new `reportLineNames`/`HEAD_OFFICE_REPORTS_LINE_SALES_ROLES`; confidential codes still stripped).
- CLEAN (MM already COMPANY-wide, no gap): coaching (`coachingOversightRoles`), double-visit, probation, organogram (`canAccessCompanyOrganogram`).
- CLEAN (intentional SELF): payroll, deductions (financial PII — never line-mates).
- NOT this bug / deferred product decisions: attendance (MM has no `employees:read`, so can't open attendance views at all — separate access question), and whether the MM's ROI should be company-wide vs reports'-lines (owner chose reports'-lines).
Rule of thumb: when the MM is COMPANY-scoped a module is fine; when LINE-scoped, it needs the direct-report edge (or company scope) or it silently shows the MM ~nothing.
