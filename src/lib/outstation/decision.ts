import {
  classifyOutstationExpenseEligibility,
  type OutstationDistanceEligibilityPolicy,
} from "@/lib/outstation/classification";
import { isOutstationTicketWaivedRole } from "@/lib/outstation/evidence-waiver";
import type {
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";

// The system's automatic decision for an outstation expense request.
// A Super Admin can later override it (→ accepted_by_admin / rejected_by_admin).
//
// `held_for_review` is NOT a soft rejection: it means a rule could not be evaluated yet, so the
// claim goes to the pending queue for a human instead of being decided against the employee on
// evidence that does not exist yet.
export type OutstationSystemDecisionStatus =
  | "accepted_by_system"
  | "held_for_review"
  | "rejected_by_system";

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
  // Whether an EMPTY double-visit record may be read as a measured zero yet — see
  // outstationDvEvidenceWindowClosed(). Required, not optional: a caller that forgets it must
  // fail to compile rather than silently disable a live rejection rule.
  dvEvidenceWindowClosed: boolean;
};

export type OutstationDecision = {
  status: OutstationSystemDecisionStatus;
  reason: string;
};

// Only District Managers and Training Managers are subject to the unplanned-visit cap (it was the
// campaign-visit cap until 7 Nov 2026 — owner: "replace campaign with unplanned visits").
export const CAMPAIGN_RULE_ROLES: ReadonlySet<string> = new Set([
  "District Manager",
  "Training Manager",
]);
export const MAX_CAMPAIGN_VISITS = 2;

/**
 * How long after a trip's last day an EMPTY double-visit record may be read as a measured zero.
 *
 * Reps enter their visits into iReports360 through and after the working day, not as they happen:
 * on 2026-08-08, 647 visits were recorded for the day and only 3 of them were saved before 11:00,
 * with the bulk landing 12:00-23:00 and a further ~100 saved after midnight. So a trip submitted
 * on its own morning ALWAYS reads zero double-visits, and rejecting on that reads an unwritten
 * record as proof the employee did no field work. It rejected two genuine Tanta claims from the
 * Training Manager (A-7) at 10:28 and 10:30 on 2026-08-09, which is how this was found.
 *
 * One full day of grace covers the after-midnight tail; from the second day after the trip ends,
 * an empty record is a real zero again and the rule bites as before.
 */
export const DV_EVIDENCE_GRACE_DAYS = 1;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `dateIso` shifted by whole days, as YYYY-MM-DD. Pure — no clock is read. */
function shiftIsoDate(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Has the CRM had a fair chance to record this trip's double-visits yet?
 *
 * `false` while the evidence may still be arriving — an empty record then means "not written yet",
 * not "none happened". Both dates are Africa/Cairo CALENDAR days (the CRM records Cairo wall-clock
 * and the owner's reporting rule is Cairo throughout); pass `cairoTodayIso()` from crm/dates.ts.
 *
 * Fails CLOSED on an unreadable date: an unparseable trip date returns `true`, so a bad value can
 * never switch the campaign rule off. The cost of failing closed here is a rejection a Super Admin
 * can override; the cost of failing open is a rule that silently stops running.
 */
export function outstationDvEvidenceWindowClosed(input: {
  cairoTodayIso: string;
  tripEndDate: string;
}): boolean {
  const tripEnd = String(input.tripEndDate ?? "").slice(0, 10);
  const today = String(input.cairoTodayIso ?? "").slice(0, 10);
  if (!ISO_DATE.test(tripEnd) || !ISO_DATE.test(today)) return true;
  return today > shiftIsoDate(tripEnd, DV_EVIDENCE_GRACE_DAYS);
}

/** What the campaign rule concluded. `null` = the rule does not apply, or it passed. */
export type OutstationCampaignRuleOutcome =
  | { kind: "hold"; reason: string }
  | { kind: "reject"; reason: string }
  | null;

export const DV_EVIDENCE_PENDING_HOLD_REASON =
  "The field visits for this trip are not in Phoenix CRM yet — visits are entered through and after the working day — so this claim is held for review instead of being rejected on evidence that has not been written yet. Re-check the visits once the day's visits are in.";

/**
 * Rule 3 in isolation: the unplanned-visit cap for traveling District/Training Manager claims.
 *
 * What it counts (owner, 6 Nov 2026): the manager's field visits both ways — the double visits a rep
 * logged with him on them, and the single visits he logged himself. `totalDvVisits` and
 * `campaignVisits` are those totals (the names are kept so every stored snapshot and caller still
 * fits); "campaign" now means UNPLANNED (isUnplannedFieldVisit).
 *
 * Exported for the same reason as {@link outstationTicketEvidenceRejection} — the live submit path
 * in src/lib/outstation/service.ts must apply the SAME rule rather than keep a second copy that
 * can drift. One implementation, two callers.
 *
 * Two outcomes are deliberately distinguished:
 *
 *   - ZERO double-visits is a REJECT only once the evidence window has closed. Inside the window
 *     it is a HOLD, because the number is unmeasured rather than zero. This mirrors the rule
 *     workload-capture.ts already states for the AM/PM figure: a workload that cannot be read must
 *     leave the request waiting, never silently record zero.
 *   - OVER the cap rejects either way. A partial count already above the cap can only grow as more
 *     visits are entered, so waiting cannot change the answer.
 */
export function outstationCampaignRuleOutcome(input: {
  /** The trip's UNPLANNED visits: his double visits' and his own. */
  campaignVisits: number;
  dvEvidenceWindowClosed: boolean;
  expenseType: OutstationExpenseType;
  /**
   * His own visits could not be read, so a zero total is unmeasured: it HOLDS, never rejects. Optional and
   * false by default, so a caller that never read them decides exactly as before.
   */
  ownVisitsUnmeasured?: boolean;
  role: string;
  /** Every field visit of the trip: his double visits and his own. */
  totalDvVisits: number;
}): OutstationCampaignRuleOutcome {
  if (input.expenseType !== "traveling" || !CAMPAIGN_RULE_ROLES.has(input.role)) return null;

  if (input.campaignVisits > MAX_CAMPAIGN_VISITS) {
    return {
      kind: "reject",
      reason: `A traveling expense allows at most ${MAX_CAMPAIGN_VISITS} unplanned visits; this trip has ${input.campaignVisits}. The rest must be planned visits.`,
    };
  }

  if (input.totalDvVisits <= 0) {
    return input.dvEvidenceWindowClosed && !input.ownVisitsUnmeasured
      ? {
          kind: "reject",
          reason:
            "No field visits were recorded for this trip — no double visit with a rep and no own visit; a traveling expense for this role requires field visits.",
        }
      : { kind: "hold", reason: DV_EVIDENCE_PENDING_HOLD_REASON };
  }

  return null;
}

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
 *
 * Waived on 2026-08-19 (owner request) for the roles in evidence-waiver.ts: they MAY
 * attach the ticket — as a PDF or an image — but a train or bus claim without one is accepted.
 * The waiver is applied here rather than by clearing `requiresTicketAttachment` upstream so that
 * the admin policy editor keeps saying what the policy actually is for everyone else; a role
 * exemption that showed up as "no policy requires a ticket" would be a lie on the policy screen.
 *
 * `role` is the canonical job-function role and is REQUIRED, for the same reason it is required
 * on validateLiveArrivalEvidence: forgetting it must break the build, not the rule.
 */
export function outstationTicketEvidenceRejection(input: {
  hasTicketAttachments: boolean;
  requiresTicketAttachment: boolean;
  role: string;
  transportationType: OutstationTransportationType;
}): string | null {
  const isTicketBasedTransport =
    input.transportationType === "train" || input.transportationType === "bus";
  if (!isTicketBasedTransport) return null;
  if (isOutstationTicketWaivedRole(input.role)) return null;
  if (!input.requiresTicketAttachment) return null;
  if (input.hasTicketAttachments) return null;
  return "Train or bus expenses require an attached ticket before they can be accepted.";
}

/**
 * The admin-editable GPS accuracy limit on a submitted outstation claim. A fix whose reported
 * accuracy is above the limit is held for Super Admin review, and so is a claim whose device
 * reported no accuracy at all (owner, 2026-09-18): nothing shows it is inside the limit. Neither
 * rejects: a fuzzy or unreported fix is a review signal, not proof of abuse. A limit of 0 or less
 * switches the check off, as it always has.
 *
 * `capturedAccuracyMeters` must come from readAccuracyInput (src/lib/geo/coordinate-input.ts), so
 * null means "the device reported none". It used to be `Number(body.capturedAccuracyMeters)`, and
 * `Number(null)`, `Number("")` and `Number(" ")` are all 0: a claim with no accuracy read as a
 * perfect 0 m fix and passed this limit.
 *
 * The result joins detectedHoldReasons in submitOutstationRequest, so a National Sales Manager's
 * claim still carries the flag but is never held (nsm-no-hold.ts).
 */
export function outstationGpsAccuracyHoldReason(input: {
  capturedAccuracyMeters: number | null;
  gpsAccuracyLimitMeters: number;
}): string | null {
  const limit = input.gpsAccuracyLimitMeters;
  if (limit <= 0) return null;
  if (input.capturedAccuracyMeters === null) {
    return `The device did not report its GPS accuracy, so the ${limit} m policy limit could not be checked and this request is held for Super Admin review before it moves to payroll.`;
  }
  if (input.capturedAccuracyMeters > limit) {
    return `The captured GPS accuracy (${Math.round(input.capturedAccuracyMeters)} m) is outside the ${limit} m policy limit, so this request is held for Super Admin review before it moves to payroll.`;
  }
  return null;
}

/**
 * Pure system decision for an outstation expense request. Rules, in order:
 *   1. Distance floor — must meet the policy minimum (60 km, 58 km tolerance).
 *   2. Governorate — the destination must be OUTSIDE the residence governorate.
 *      Only rejects when both governorates are known and identical (fail-open on
 *      an unresolved governorate; a Super Admin can still reject manually).
 *   3. Unplanned cap — TRAVELING expenses for District/Training Managers only:
 *      the trip needs at least one field visit (a double visit with a rep, or his own)
 *      and at most 2 unplanned visits (the rest planned). Meeting/other expense types and all other roles skip this.
 *      A trip whose double-visit evidence window is still open HOLDS rather than
 *      rejects on a zero count — see outstationCampaignRuleOutcome().
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

  // 3. Unplanned-visit cap — traveling expenses for District/Training Managers only.
  const campaign = outstationCampaignRuleOutcome({
    campaignVisits: input.campaignVisits,
    dvEvidenceWindowClosed: input.dvEvidenceWindowClosed,
    expenseType: input.expenseType,
    role: input.role,
    totalDvVisits: input.totalDvVisits,
  });
  if (campaign?.kind === "reject") {
    return { status: "rejected_by_system", reason: campaign.reason };
  }
  if (campaign?.kind === "hold") {
    return { status: "held_for_review", reason: campaign.reason };
  }

  // 4. Ticket-based transport must carry ticket evidence.
  const ticketRejection = outstationTicketEvidenceRejection({
    hasTicketAttachments: input.hasTicketAttachments,
    requiresTicketAttachment: input.requiresTicketAttachment,
    role: input.role,
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
