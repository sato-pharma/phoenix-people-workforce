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

export function isDeductionsReadActor(access: Pick<AccessContext, "role">) {
  return access.role === "Super Admin" || access.role === "CEO" || access.role === "Finance Manager";
}

export function assertDeductionsReadActor(access: Pick<AccessContext, "role">) {
  if (!isDeductionsReadActor(access)) {
    throw new Error("Forbidden: you do not have access to the Deductions module.");
  }
}
