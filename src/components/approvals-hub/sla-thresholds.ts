// Pure, JSX-free SLA logic — split out from sla-badge.tsx so it can be unit-tested directly
// (the .tsx sibling can't be imported by the plain-TS test loader). Reuses the exact thresholds
// already established in src/components/action-center/action-center-hub.tsx (SLA_THRESHOLDS).
export const APPROVALS_SLA_THRESHOLDS = { leave: 3, excuse: 2, plan: 2 } as const;

export type ApprovalsSlaModule = keyof typeof APPROVALS_SLA_THRESHOLDS;

export type SlaTone = "overdue" | "due" | "none";

export function slaTone(ageDays: number, threshold: number): SlaTone {
  if (ageDays >= threshold) return "overdue";
  if (threshold - ageDays <= 1) return "due";
  return "none";
}
