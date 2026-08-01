import {
  classifyOutstationExpenseEligibility,
  type OutstationDistanceEligibilityPolicy,
} from "@/lib/outstation/classification";
import type {
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";

// The system's automatic accept/reject decision for an outstation expense request.
// A Super Admin can later override it (→ accepted_by_admin / rejected_by_admin).
export type OutstationSystemDecisionStatus = "accepted_by_system" | "rejected_by_system";

export type OutstationDecisionInput = {
  actualDistanceKm: number | null;
  policy: OutstationDistanceEligibilityPolicy;
  // Canonical governorates (run both sides through resolveGovernorate() first so a
  // plain === comparison is valid). null = could not be resolved.
  destinationGovernorate: string | null;
  residenceGovernorate: string | null;
  expenseType: OutstationExpenseType;
  // Canonical job-function role (e.g. "District Manager", "Training Manager").
  role: string;
  transportationType: OutstationTransportationType;
  hasTicketAttachments: boolean;
  requiresTicketAttachment: boolean;
  // Double-visit counts within the trip window (only used for traveling DM/TM).
  campaignVisits: number;
  totalDvVisits: number;
};

export type OutstationDecision = {
  status: OutstationSystemDecisionStatus;
  reason: string;
};

// Only District Managers and Training Managers are subject to the campaign-visit cap.
export const CAMPAIGN_RULE_ROLES: ReadonlySet<string> = new Set([
  "District Manager",
  "Training Manager",
]);
export const MAX_CAMPAIGN_VISITS = 2;

/**
 * Rule 4 in isolation: ticket-based transport must carry ticket evidence.
 * Returns the rejection reason, or null when the rule is satisfied / does not apply.
 *
 * Exported because the live submit path in src/lib/outstation/service.ts must
 * apply the SAME rule — it computes rules 1-3 upstream (distance and governorate
 * are folded into `eligibilityStatus`, the campaign cap into
 * `campaignRuleRejection`) but previously enforced the ticket mandate only as a
 * pre-submit throw that the offline path skipped, so an offline train/bus claim
 * with no ticket was auto-accepted straight into payroll. One implementation,
 * two callers: the rule can no longer be true here and false in production.
 *
 * `hasTicketAttachments` MUST be derived from files the server actually stored,
 * never from a client-supplied boolean.
 */
export function outstationTicketEvidenceRejection(input: {
  hasTicketAttachments: boolean;
  requiresTicketAttachment: boolean;
  transportationType: OutstationTransportationType;
}): string | null {
  const isTicketBasedTransport =
    input.transportationType === "train" || input.transportationType === "bus";
  if (!isTicketBasedTransport) return null;
  if (!input.requiresTicketAttachment) return null;
  if (input.hasTicketAttachments) return null;
  return "Train or bus expenses require an attached ticket before they can be accepted.";
}

/**
 * Pure system decision for an outstation expense request. Rules, in order:
 *   1. Distance floor — must meet the policy minimum (60 km, 58 km tolerance).
 *   2. Governorate — the destination must be OUTSIDE the residence governorate.
 *      Only rejects when both governorates are known and identical (fail-open on
 *      an unresolved governorate; a Super Admin can still reject manually).
 *   3. Campaign cap — TRAVELING expenses for District/Training Managers only:
 *      the trip needs at least one double-visit and at most 2 campaign visits
 *      (the rest regular). Meeting/other expense types and all other roles skip this.
 *   4. Ticket evidence — train/bus expenses that require a ticket must have one.
 * Anything that passes all four is accepted.
 */
export function decideOutstationRequest(input: OutstationDecisionInput): OutstationDecision {
  // 1. Distance floor. Only a confirmed below-minimum distance rejects here;
  // tolerance / unmeasured distances fall through (a Super Admin can override).
  const distance = classifyOutstationExpenseEligibility({
    actualDistanceKm: input.actualDistanceKm,
    policy: input.policy,
  });
  if (distance.classification === "not_eligible") {
    return { status: "rejected_by_system", reason: distance.reason };
  }

  // 2. Governorate must differ from the residence governorate.
  if (
    input.destinationGovernorate &&
    input.residenceGovernorate &&
    input.destinationGovernorate === input.residenceGovernorate
  ) {
    return {
      status: "rejected_by_system",
      reason: `Destination is within the same governorate as your residence (${input.residenceGovernorate}) and is not eligible for an outstation expense.`,
    };
  }

  // 3. Campaign-visit cap — traveling expenses for District/Training Managers only.
  if (input.expenseType === "traveling" && CAMPAIGN_RULE_ROLES.has(input.role)) {
    if (input.totalDvVisits <= 0) {
      return {
        status: "rejected_by_system",
        reason:
          "No double-visit activity was recorded for this trip; a traveling expense for this role requires field double-visits.",
      };
    }
    if (input.campaignVisits > MAX_CAMPAIGN_VISITS) {
      return {
        status: "rejected_by_system",
        reason: `A traveling expense allows at most ${MAX_CAMPAIGN_VISITS} campaign double-visits; this trip has ${input.campaignVisits}. The rest must be regular visits.`,
      };
    }
  }

  // 4. Ticket-based transport must carry ticket evidence.
  const ticketRejection = outstationTicketEvidenceRejection({
    hasTicketAttachments: input.hasTicketAttachments,
    requiresTicketAttachment: input.requiresTicketAttachment,
    transportationType: input.transportationType,
  });
  if (ticketRejection) {
    return { status: "rejected_by_system", reason: ticketRejection };
  }

  return {
    status: "accepted_by_system",
    reason: "Meets the distance, governorate, and role eligibility rules.",
  };
}
