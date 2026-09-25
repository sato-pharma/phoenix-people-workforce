---
name: portal-no-salary-on-landing
description: "RULE — no payslip AT ALL on any overview/landing page for any role (not the amount, not even the month label); payslips live only on /employee-portals/payslips"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0c89c9a5-f1c8-425b-89b2-be9cac82f4a2
  modified: 2026-07-30T01:35:41.848Z
---

**No payslip on any overview/landing page, for ANY role.** Not the net/gross amount, and not even
the month label — the whole tile/card is removed. Owner instruction 2026-07-30, which ESCALATED the
earlier rule (which had allowed a month-label-only tile).

**Why:** salary is sensitive personal data and must stay behind the dedicated payslips page. The
owner flagged the amount showing on a landing page as unacceptable — twice now, so treat any payslip
figure on a dashboard as a release blocker, not a nitpick.

**How to apply:**
- Landing/overview surfaces = `PortalCommandCenter` + every role dashboard inside
  `src/components/employee-portal/dashboards/` (rm-, dsm-, nsm-, marketing-manager-command-center).
  None of them may reference `latestPayslip` or render `netSalary`.
- A plain "My Payslips" NAV link/tile is fine — it renders no payslip data, only navigation.
  (Confirmed acceptable: the RM sidebar keeps its Payslips link.)
- Payslip data belongs only on `/employee-portals/payslips` (which renders
  `MedicalRepPayrollPage` → `PayrollPayslipsSection`) and the payroll detail pages.
- Guard test: `tests/employee-portal-payslip-salary.test.ts` iterates `landingSurfaceFiles` and
  asserts none matches `/latestPayslip\s*\?/` or `/netSalary/`. Add any new role dashboard to that
  array.
- The `latestPayslip` field on `PortalHomeSnapshot` still exists (other surfaces use it) — the rule
  is about RENDERING it on a landing page, not about deleting the data.

Related: [[rm-dsm-portal-provisioning-gaps]]
