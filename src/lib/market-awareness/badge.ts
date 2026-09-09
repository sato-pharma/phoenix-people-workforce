import { APPROVALS_SLA_THRESHOLDS, slaTone } from "@/components/approvals-hub/sla-thresholds";
import type { AccessContext } from "@/lib/auth/permissions";
import type { MarketAwarenessApproverSlot } from "@/lib/market-awareness/approvers";
import type { MarketAwarenessStatus } from "@/lib/market-awareness/types";
import { canDecideStep, currentStep } from "@/lib/market-awareness/workflow";

/**
 * Market Awareness — the nav badge's counting rule, pure and free of the database.
 *
 * Split out from the service so the RULE can be tested directly: a badge whose only test is "the
 * query looks right" is a badge nobody has ever seen count. The service supplies the rows; every
 * decision about which of them belong to this person, and whether any has gone late, is made here.
 *
 * It reuses `canDecideStep` — the very predicate the decision route enforces — rather than a second
 * copy of the routing rule. A badge built from its own predicate is how a count comes to show a
 * number the inbox it sits on cannot explain. Under the parallel group that matters more, not less:
 * a request is on the badge of everyone who has NOT yet answered it and on nobody else's, so the
 * same row is counted by two people at once and drops off each of their badges separately.
 */

/** What a nav badge needs: the number waiting, and whether any of them is late. */
export type MarketAwarenessDecisionBadge = { count: number; overdue: boolean };

/** The columns the badge reads. Nothing here is ever displayed. */
export type MarketAwarenessBadgeRow = {
  managerHrId: string | null;
  /**
   * When the CURRENT step opened — `step_opened_at`, never `updated_at`. An update trigger stamps
   * `updated_at` on every write, so under a parallel group one member approving would restart the
   * clock for every member still to answer, and a request three days late would read as fresh.
   * Measuring from submission is wrong in the other direction: it hands the CEO a clock the group
   * had already spent.
   */
  openedAt: string | null;
  status: string;
  /** The parallel group. Empty for a row at the CEO step, where the badge is role-checked. */
  approvers: Array<
    Pick<MarketAwarenessApproverSlot, "approverRole" | "lineId" | "assignedHrId" | "decision">
  >;
};

/** Has this step waited past the awareness SLA? A missing or unparseable clock is never late. */
export function isDecisionOverdue(openedAt: string | null, nowMs: number): boolean {
  if (!openedAt) return false;
  const openedMs = new Date(openedAt).getTime();
  if (!Number.isFinite(openedMs)) return false;
  const daysWaiting = Math.floor((nowMs - openedMs) / 86_400_000);
  if (daysWaiting < 0) return false;
  return slaTone(daysWaiting, APPROVALS_SLA_THRESHOLDS.marketAwareness) === "overdue";
}

export function summarizeMarketAwarenessDecisionBadge(input: {
  access: Pick<AccessContext, "role" | "hrId">;
  /** The viewer's own line. Only a National Sales Manager slot reads it; null for everyone else. */
  actorLineId?: number | null;
  /** ISO instant to measure the wait against — passed in so the rule is testable. */
  now: string;
  rows: MarketAwarenessBadgeRow[];
}): MarketAwarenessDecisionBadge {
  // `returned` reaches here (it is inside the open queue) and is dropped by `currentStep` answering
  // null, exactly as it is in the list: it is the requester's to act on, never an approver's. So is
  // `on_hold` — a frozen request is waiting on nobody until somebody releases it, and putting it on
  // an approver's badge would ask him for a decision the server would then refuse.
  const mine = input.rows.filter((row) => {
    const step = currentStep(row.status as MarketAwarenessStatus);
    if (!step) return false;
    return canDecideStep({
      access: input.access,
      actorLineId: input.actorLineId ?? null,
      approvers: row.approvers as MarketAwarenessApproverSlot[],
      managerHrId: row.managerHrId,
      step,
    });
  });
  const nowMs = new Date(input.now).getTime();
  return { count: mine.length, overdue: mine.some((row) => isDecisionOverdue(row.openedAt, nowMs)) };
}
