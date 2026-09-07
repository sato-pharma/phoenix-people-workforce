import { APPROVALS_SLA_THRESHOLDS, slaTone } from "@/components/approvals-hub/sla-thresholds";
import type { AccessContext } from "@/lib/auth/permissions";
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
 * number the inbox it sits on cannot explain.
 */

/** What a nav badge needs: the number waiting, and whether any of them is late. */
export type MarketAwarenessDecisionBadge = { count: number; overdue: boolean };

/** The three columns the badge reads. Nothing here is ever displayed. */
export type MarketAwarenessBadgeRow = {
  managerHrId: string | null;
  /**
   * When the CURRENT step opened. `updated_at`, not `submitted_at`: an update trigger stamps it on
   * every write, so it is the moment this step started waiting. Measuring from submission would
   * hand the CEO a clock the manager had already half spent, and a resubmitted activity would
   * arrive pre-breached against whoever inherits it.
   */
  openedAt: string | null;
  status: string;
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
  /** ISO instant to measure the wait against — passed in so the rule is testable. */
  now: string;
  rows: MarketAwarenessBadgeRow[];
}): MarketAwarenessDecisionBadge {
  // `returned` reaches here (it is inside the open queue) and is dropped by `currentStep` answering
  // null, exactly as it is in the list: it is the requester's to act on, never an approver's.
  const mine = input.rows.filter((row) => {
    const step = currentStep(row.status as MarketAwarenessStatus);
    if (!step) return false;
    return canDecideStep({ access: input.access, managerHrId: row.managerHrId, step });
  });
  const nowMs = new Date(input.now).getTime();
  return { count: mine.length, overdue: mine.some((row) => isDecisionOverdue(row.openedAt, nowMs)) };
}
