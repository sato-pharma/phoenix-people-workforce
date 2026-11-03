/**
 * What moving on to another governorate asks of each person (owner, 2026-11-03: "what if he is trans
 * and no car what is he supposed to capture? ... rebuild the stop from scratch").
 *
 * A stop is the next place of a trip. What proves it, and what pays for the drive to it, depends on
 * how the person travelled and whether their role carries photo evidence at all:
 *
 *   - By car, with photos:    a live photo and the location. The drive is paid in fuel.
 *   - By car, photos waived:  the location alone (evidence-waiver.ts). The drive is paid in fuel.
 *   - No car, with photos:    the location and that leg's ticket. The ticket is paid, no fuel.
 *   - No car, photos waived:  the location; the ticket is optional and paid when attached. No fuel.
 *
 * A National Sales Manager's claim is accepted the moment it is submitted (nsm-no-hold.ts), so for
 * that one role a stop stays open on a claim the SYSTEM accepted — never on one a person decided. The
 * owner chose this knowing it moves money after acceptance: "Location-only stop, paid by drive".
 * Everyone else still stops at the decision (undecided-claim.ts).
 *
 * A ticket's amount is the one figure here that is typed, so it never joins a claim the system already
 * accepted: nobody would see it before payroll pays it. The same rule as an extra ticket (owner,
 * 2026-10-19: "after HR decision not able to add anything"): that stop is the location alone, and HR
 * adds the ticket through the trip edit and sees the new figure.
 *
 * Pure: the service enforces all of this, and the screens read the same answers.
 */

import { isOutstationEvidenceWaivedRole } from "@/lib/outstation/evidence-waiver";
import { isOutstationNoHoldRole } from "@/lib/outstation/nsm-no-hold";
import { OUTSTATION_UNDECIDED_STATUSES, isOutstationClaimUndecided } from "@/lib/outstation/undecided-claim";

export type JourneyStopTicketRule = "none" | "optional" | "required";

export type JourneyStopRule = {
  /** A live photo is taken with the location. */
  photo: boolean;
  /** Whether this leg carries a ticket. */
  ticket: JourneyStopTicketRule;
  /** The drive to the stop is paid in fuel; otherwise only a ticket pays. */
  paysFuel: boolean;
};

/** How a stored stop was proved. A row from before this rule has a photo and no kind. */
export type JourneyStopEvidence = "live_photo" | "location" | "location_ticket";

/** The status the system gives a claim it accepted by itself. A person's acceptance is never this. */
const SYSTEM_ACCEPTED_STATUS = "accepted_by_system";

export function journeyStopRule(input: {
  employeeRole: string | null | undefined;
  transportationType: string | null | undefined;
  /** The claim's status, when there is a claim: a system-accepted one takes no ticket. */
  status?: unknown;
}): JourneyStopRule {
  const waived = isOutstationEvidenceWaivedRole(input.employeeRole);
  if (String(input.transportationType ?? "").trim().toLowerCase() === "car") {
    return { paysFuel: true, photo: !waived, ticket: "none" };
  }
  if (String(input.status ?? "").trim() === SYSTEM_ACCEPTED_STATUS) {
    return { paysFuel: false, photo: false, ticket: "none" };
  }
  return { paysFuel: false, photo: false, ticket: waived ? "optional" : "required" };
}

/** The rule for a claim only just submitted, which a National Sales Manager's is accepted on. */
export function journeyStopRuleForNewClaim(input: {
  employeeRole: string | null | undefined;
  transportationType: string | null | undefined;
}): JourneyStopRule {
  return journeyStopRule({
    ...input,
    status: isOutstationNoHoldRole(input.employeeRole) ? SYSTEM_ACCEPTED_STATUS : null,
  });
}

/** May this claim still take a stop: undecided, or a National Sales Manager's system-accepted claim. */
export function isJourneyStopOpen(status: unknown, employeeRole: string | null | undefined): boolean {
  if (isOutstationClaimUndecided(status)) return true;
  return isOutstationNoHoldRole(employeeRole) && String(status ?? "").trim() === SYSTEM_ACCEPTED_STATUS;
}

/**
 * A person's figure on the payroll row closes the stop too. The Expense Approvals screen trims a
 * system-accepted claim without changing its status, and the system's own push stores no amount, so a
 * stored amount can only be a person's. Payroll keeps paying that figure, so a stop would move the
 * claim and leave the money behind.
 */
export function payrollRowHoldsPersonsFigure(linked: { approvedAmount: number | null } | null | undefined): boolean {
  return linked?.approvedAmount != null;
}

/**
 * The stop this capture already saved, when a retry brings it back: a lost response on a weak signal
 * must return the saved stop and never pay its ticket a second time.
 */
export function stopAlreadySavedFor<T extends { captureKey?: string }>(
  stops: readonly T[],
  captureKey: string | null | undefined,
): T | null {
  if (!captureKey) return null;
  return stops.find((stop) => stop.captureKey === captureKey) ?? null;
}

/** The same answer for the final write, so a decision landing in between leaves no row to change. */
export function journeyStopWriteStatuses(employeeRole: string | null | undefined): string[] {
  return isOutstationNoHoldRole(employeeRole)
    ? [...OUTSTATION_UNDECIDED_STATUSES, SYSTEM_ACCEPTED_STATUS]
    : [...OUTSTATION_UNDECIDED_STATUSES];
}

/** Why the evidence offered does not satisfy the rule, or null when it does. Nothing is uploaded first. */
export function journeyStopEvidenceRefusal(input: {
  rule: JourneyStopRule;
  hasPhoto: boolean;
  ticketAmount: number;
  ticketFileCount: number;
}): string | null {
  const amount = Number.isFinite(input.ticketAmount) ? input.ticketAmount : 0;
  if (input.rule.photo && !input.hasPhoto) return "A live photo is required for this stop.";
  if (input.rule.ticket === "none") {
    if (amount <= 0 && input.ticketFileCount === 0) return null;
    return input.rule.paysFuel
      ? "A stop on a car trip must not carry a ticket."
      : "A ticket can only join a claim before it is accepted. Send this one to HR, who add it to the trip.";
  }
  if (amount < 0) return "The ticket amount must be zero or more.";
  if (input.rule.ticket === "required" && (input.ticketFileCount === 0 || amount <= 0)) {
    return "The ticket for this leg and its amount are required.";
  }
  if (amount > 0 && input.ticketFileCount === 0) return "Attach the ticket for this amount: a file is required.";
  if (input.ticketFileCount > 0 && amount <= 0) return "Enter the ticket's amount: an amount is required.";
  return null;
}

/** The kind of evidence a stop was captured with. */
export function journeyStopEvidenceKind(rule: JourneyStopRule, ticketFileCount: number): JourneyStopEvidence {
  if (rule.photo) return "live_photo";
  return ticketFileCount > 0 ? "location_ticket" : "location";
}

/**
 * The tickets on a claim that are NOT a stop's own — what "this claim arrived with no ticket" must
 * count, so a leg's ticket never closes the gap on the first leg's missing one.
 */
export function ticketPathsOutsideStops(
  ticketPaths: readonly string[],
  stops: ReadonlyArray<{ ticketPaths?: readonly string[] }>,
): string[] {
  const onStops = new Set(stops.flatMap((stop) => stop.ticketPaths ?? []));
  return ticketPaths.filter((path) => !onStops.has(path));
}
