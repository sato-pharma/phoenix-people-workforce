// Pure, JSX-free SLA logic — split out from sla-badge.tsx so it can be unit-tested directly
// (the .tsx sibling can't be imported by the plain-TS test loader). Reuses the exact thresholds
// already established in src/components/action-center/action-center-hub.tsx (SLA_THRESHOLDS).
// `directOrderMonth` is not an approval SLA like the other three — nobody is approving anything.
// It is the age at which an APPROVED direct order still carrying no sales month stops being normal
// turnaround and starts being a problem, measured from the CEO's decision. It lives here anyway so
// there is one escalation vocabulary in the product: slaTone() decides none/due/overdue for the
// sidebar badge, the dashboard tile and the queue row alike, instead of each growing its own idea
// of "late".
//
// 5 days, chosen against the month boundary rather than a service target. An unbooked order is not
// merely late, it is uncounted — its sales are in no month at all — and the real damage is when it
// drifts past a month end, because the month it belongs to may already be closed by the time anyone
// notices. Five days keeps a weekend plus a few working days inside "normal", and turns amber
// ("due") on day 4 — early enough to act before a month-end in every case.
export const APPROVALS_SLA_THRESHOLDS = { leave: 3, excuse: 2, plan: 2, directOrderMonth: 5 } as const;

export type ApprovalsSlaModule = keyof typeof APPROVALS_SLA_THRESHOLDS;

export type SlaTone = "overdue" | "due" | "none";

export function slaTone(ageDays: number, threshold: number): SlaTone {
  if (ageDays >= threshold) return "overdue";
  if (threshold - ageDays <= 1) return "due";
  return "none";
}
