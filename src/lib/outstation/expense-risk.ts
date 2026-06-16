// Shared high-risk predicate for outstation expense requests. Used by the
// command-center service (per-row enrichment) and by the daily-digest cron
// (filter "new since yesterday + high risk"). Keeping this in ONE place
// guarantees the two surfaces never drift apart.

import type { OutstationExpenseRequest } from "@/lib/outstation/types";

export const HIGH_RISK_SCORE_THRESHOLD = 50;

/** A request is high-risk if any of: rejected by recommendation, GPS suspicion ≥ threshold, or any fraud flag. */
export function isHighRiskRequest(request: {
  approvalRecommendation?: OutstationExpenseRequest["approvalRecommendation"] | null;
  suspiciousLocationScore?: number | null;
  fraudFlags?: ReadonlyArray<string> | null;
}): boolean {
  if (request.approvalRecommendation === "reject") return true;
  if ((request.suspiciousLocationScore ?? 0) >= HIGH_RISK_SCORE_THRESHOLD) return true;
  if ((request.fraudFlags?.length ?? 0) > 0) return true;
  return false;
}

/** Compact human-readable reason for why a request is flagged. */
export function highRiskReasons(request: {
  approvalRecommendation?: OutstationExpenseRequest["approvalRecommendation"] | null;
  suspiciousLocationScore?: number | null;
  fraudFlags?: ReadonlyArray<string> | null;
}): string[] {
  const reasons: string[] = [];
  if (request.approvalRecommendation === "reject") reasons.push("auto-reject recommendation");
  const score = request.suspiciousLocationScore ?? 0;
  if (score >= HIGH_RISK_SCORE_THRESHOLD) reasons.push(`suspicious-location score ${score}`);
  if ((request.fraudFlags?.length ?? 0) > 0) {
    reasons.push(`fraud flags: ${(request.fraudFlags ?? []).join(", ")}`);
  }
  return reasons;
}
