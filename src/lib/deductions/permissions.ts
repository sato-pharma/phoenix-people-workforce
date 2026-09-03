// Unified Deductions module: access gating. Mirrors
// deductions-governance/calculations.ts's assertDeductionsGovernanceDecisionActor
// and automated-payroll/permissions.ts's HR_ROLES/PUBLISHER_ROLES pattern —
// this codebase is already consistent on "Super Admin decides/publishes".

import type { AccessContext } from "@/lib/auth/permissions";

export function isDeductionsDecisionActor(access: Pick<AccessContext, "role">) {
  return access.role === "Super Admin";
}

export function assertDeductionsDecisionActor(access: Pick<AccessContext, "role">) {
  if (!isDeductionsDecisionActor(access)) {
    throw new Error("Forbidden: only Super Admin can record or update a deduction decision.");
  }
}

// Same actor as decisions today (see automated-payroll-accounting-gaps memory:
// build+publish sharing one role is a known, owner-visible judgment call, not
// an oversight) — kept as its own named gate so a future maker/checker split
// only needs to change this one function.
export function isDeductionsPublishActor(access: Pick<AccessContext, "role">) {
  return access.role === "Super Admin";
}

export function assertDeductionsPublishActor(access: Pick<AccessContext, "role">) {
  if (!isDeductionsPublishActor(access)) {
    throw new Error("Forbidden: only Super Admin can publish a month's deductions.");
  }
}

/**
 * WHO MAY READ THE WHOLE COMPANY'S DEDUCTIONS.
 *
 * A named actor list, separate from the RBAC matrix and asserted ON TOP of it by every
 * company-wide read route. It exists because the matrix alone was not enough: a Regional Manager
 * held `deductions:read` so their portal page could render, and that one grant let them call
 * /api/admin/deductions/export and take away 69 employees' amounts — 124,138.96 EGP of live
 * production data. Owner instruction 2026-08-06: "everyone can only see his deductions only."
 * tests/deductions-read-gate.test.ts pins the audience in both directions.
 *
 * Finance Manager is here but is NOT on the page's VIEW_ROLES: the owner revoked his screen on
 * 2026-08-11 while leaving the data reach that payroll surfaces he keeps are built on. The two
 * lists are deliberately different questions and must not be collapsed.
 *
 * HR Operations added 2026-09-03, the owner's words: "yes give HR access to the deductions screen."
 * The screen has no self-only mode, so admitting her to it necessarily means company-wide read —
 * that is stated here rather than left to be discovered. Three things make it a small step rather
 * than a new disclosure:
 *
 *   1. She already reads MORE than this. getPayrollScope returns COMPANY for her seat (owner,
 *      2026-08-29) and payroll_inputs grants payroll:[read, export] and payslips:[read, export], so
 *      every employee's gross and net is already on her screen. A deduction is a component of the
 *      payslip she can already open.
 *   2. It is her job description, not a convenience. payroll_inputs cites "ops 3 — Payroll HR
 *      Inputs & Monthly Closure", whose line is "ensure no deduction is processed without evidence
 *      and approval" — unreadable deductions make that duty unperformable.
 *   3. READ ONLY, and not by this function's good manners. Her seat holds deductions:["read"] with
 *      no `export`, so /api/admin/deductions/export still refuses her at assertPermission — she
 *      reads the figures on screen and cannot carry the company's deductions out as a file. That is
 *      the same split the owner set for her payslip access on 2026-09-01. Every decision and
 *      publish route asserts Super Admin through the actors above, and HR_ROLE_BOUNDARIES pins
 *      deductions:approve/create/update ABSENT from both HR seats.
 *
 * HR Advisory is NOT here and holds no deductions grant at all — payroll_inputs is in the HR
 * Operations bundle alone, and payroll appears nowhere in the HR Business Partner job description.
 */
export function isDeductionsReadActor(access: Pick<AccessContext, "role">) {
  return access.role === "Super Admin"
    || access.role === "CEO"
    || access.role === "Finance Manager"
    || access.role === "HR Operations";
}

export function assertDeductionsReadActor(access: Pick<AccessContext, "role">) {
  if (!isDeductionsReadActor(access)) {
    throw new Error("Forbidden: you do not have access to the Deductions module.");
  }
}
