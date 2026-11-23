/**
 * How often the system's lane matched the approver's answer — the desk's own meter.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). Until then a decision wrote over the
 * system's reading of the claim, so nobody could ask afterwards whether the reading was any good:
 * measured that day, a claim the old checks called matched was rejected 24% of the time and one
 * they called no activity 26% — a reading that says nothing. The two columns added that day
 * (`system_lane_at_decision`, `system_verdict_at_decision`) keep the lane and the checks as they
 * stood, and this counts them.
 *
 * "Agreed" means: a Ready claim he approved in full. A Ready claim he reduced or rejected is a
 * miss — Ready promised there was nothing to look at. A "Your call" claim has no right answer, so
 * its share approved is shown as a fact, never scored.
 *
 * Only decisions stamped on the rebuilt page are counted; nothing before it was backfilled, because
 * the past was decided on checks nobody kept. Pure.
 */

import type { ClaimVerdict, DecisionAction, DeskAgreement } from "@/lib/outstation/approvals/types";

export const AGREEMENT_WINDOW_DAYS = 30;

/** What is written into `system_verdict_at_decision` when a claim is decided. */
export type VerdictStamp = {
  action: DecisionAction;
  /** The amount he approved; null on a rejection. */
  approved: number | null;
  at: string;
  checks: ClaimVerdict["checks"];
  claimed: number;
  reason: string | null;
};

export function verdictStamp(input: {
  action: DecisionAction;
  approved: number | null;
  at: string;
  claimed: number;
  verdict: ClaimVerdict;
}): { lane: ClaimVerdict["lane"]; stamp: VerdictStamp } {
  return {
    lane: input.verdict.lane,
    stamp: {
      action: input.action,
      approved: input.action === "reject" ? null : input.approved,
      at: input.at,
      checks: input.verdict.checks,
      claimed: input.claimed,
      reason: input.verdict.reason,
    },
  };
}

export type StampedDecision = { lane: unknown; stamp: unknown };

export function summarizeAgreement(rows: ReadonlyArray<StampedDecision>, now: Date, windowDays = AGREEMENT_WINDOW_DAYS): DeskAgreement {
  const since = now.getTime() - windowDays * 86_400_000;
  const out: DeskAgreement = { ready: { approved: 0, decided: 0 }, windowDays, yourCall: { approved: 0, decided: 0 } };
  for (const row of rows) {
    if (row.lane !== "ready" && row.lane !== "your_call") continue;
    const stamp = row.stamp && typeof row.stamp === "object" ? (row.stamp as Partial<VerdictStamp>) : null;
    const at = stamp?.at ? Date.parse(String(stamp.at)) : Number.NaN;
    if (!stamp || !Number.isFinite(at) || at < since || at > now.getTime()) continue;
    const bucket = row.lane === "ready" ? out.ready : out.yourCall;
    bucket.decided += 1;
    if (stamp.action === "approve") bucket.approved += 1;
  }
  return out;
}

/** "27 of 28 (96%)" — or the plain words when nothing has been decided yet. */
export function agreementLine(bucket: { approved: number; decided: number }): string {
  if (bucket.decided === 0) return "no decisions yet";
  return `${bucket.approved} of ${bucket.decided} (${Math.round((bucket.approved / bucket.decided) * 100)}%)`;
}
