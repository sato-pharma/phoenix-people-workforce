/**
 * The two-photo + workload gate: what an outstation request is still waiting for, and whether
 * it may reach payroll yet.
 *
 * Owner request (2026-08-04). A request now walks three checkpoints before it re-enters the
 * normal approval flow:
 *
 *   1. ARRIVAL photo   — captured at submit time, after the GPS capture, for EVERY transport
 *                        type (it used to be car-only).
 *   2. DEPARTURE photo — captured before the employee leaves the destination.
 *   3. AM/PM WORKLOAD  — captured per trip day from the CRM visit record.
 *
 * Owner decision, same date: NOTHING reaches payroll until all three are satisfied.
 *
 * Pure and synchronous on purpose — this is the rule that decides whether real money moves, so
 * it must be assertable without a database, a CRM, or a photo.
 */

import { isOutstationEvidenceWaivedRole } from "@/lib/outstation/evidence-waiver";
import {
  OUTSTATION_NO_HOLD_GATE_MESSAGE,
  isOutstationNoHoldRole,
} from "@/lib/outstation/nsm-no-hold";
import type {
  OutstationEvidenceGateStatus,
  OutstationWorkloadGateStatus,
} from "@/lib/outstation/types";

/** What the request is waiting for right now. `null` means nothing — it may proceed. */
export type OutstationGateBlocker = "arrival_photo" | "departure_photo" | "workload" | "inconsistent";

/**
 * True only when the expense actually reached a payroll BATCH.
 *
 * The existence of an `outstation_expenses` row is NOT the same thing. That row is written when
 * the claim is first pushed to the payroll queue and then sits there, unimported, until a batch
 * picks it up. So testing the row's mere existence reads "queued" as "already paid".
 *
 * This lives here, beside the gate it belongs to, because that distinction was drawn correctly in
 * five places in service.ts and wrongly in one: releaseOutstationRequestToPayrollIfReady tested
 * the row's existence and so answered "The request is already in payroll." for every request that
 * had a queued-but-unimported row — which was ALL of them. All 360 rows in production carry a null
 * `imported_payroll_batch_id`. Held claims could therefore never be released, and the reason given
 * actively misdirected whoever read it. One definition, so the two readings cannot drift again.
 */
/**
 * A SECOND APPROVE OF A CLAIM ALREADY ACCEPTED, WITH NOTHING NEW TO SAY, CHANGES NOTHING (F-PAY-015).
 *
 * Approving re-ran the whole accept on a claim that was already accepted: a fresh status write, a
 * second push into payroll and a second "accepted and added to payroll" audit row, for a claim
 * nobody had changed. The push is keyed on the request, so it did not double the money, but the
 * record said the claim was approved twice and the payroll row was rewritten each time.
 *
 * Unchanged means: the same accepted status this approver would write, no new comment, and either
 * the claim already has its payroll row or the evidence gate is still holding it out (the release
 * path delivers that row when the evidence lands, not a second approve). Anything else — a system
 * acceptance an admin now confirms, a comment, an accepted claim whose row is missing — still runs.
 */
export function isUnchangedOutstationReapproval(input: {
  currentStatus: string;
  acceptedStatus: string;
  typedComment: string | null;
  alreadyPushed: boolean;
  payrollEligible: boolean;
}): boolean {
  if (input.currentStatus !== input.acceptedStatus) return false;
  if (input.typedComment) return false;
  return input.alreadyPushed || !input.payrollEligible;
}

export function isOutstationExpenseInPayroll(
  linked: { importedPayrollBatchId: string | null; importedToPayrollAt: string | null } | null,
): boolean {
  return Boolean(linked?.importedPayrollBatchId || linked?.importedToPayrollAt);
}

export type OutstationGateState = {
  /** The single next thing required, or null when the gate is satisfied. */
  blocker: OutstationGateBlocker | null;
  /** Owner rule: false unless BOTH gates are satisfied. Never true on an inconsistent row. */
  isPayrollEligible: boolean;
  /** Employee-facing sentence. Always says what is missing, never just "incomplete". */
  message: string;
};

/**
 * A pre-gate request, from before 2026-08-04. It can never satisfy a gate — the trip is over and
 * cannot now be photographed — so it is exempt rather than blocked. Kept as a distinct state from
 * "complete" precisely so the two are never confused: an un-photographable July trip and a fully
 * evidenced August one must not read the same.
 */
function isGrandfathered(
  evidence: OutstationEvidenceGateStatus,
  workload: OutstationWorkloadGateStatus,
): boolean {
  return evidence === "grandfathered" || workload === "grandfathered";
}

/**
 * Resolve the gate.
 *
 * The stored gate status and the actual evidence are BOTH consulted, and disagreement fails
 * closed. A row claiming `evidence_gate_status = 'complete'` with no departure photo on it is
 * not a complete request — it is a corrupt one, and the one thing it must never do is pay out.
 * Trusting the status column alone would make a single bad write silently bypass the whole gate.
 */
export function resolveOutstationGateState(input: {
  employeeRole: string;
  evidenceGateStatus: OutstationEvidenceGateStatus;
  hasArrivalPhoto: boolean;
  hasDeparturePhoto: boolean;
  workloadGateStatus: OutstationWorkloadGateStatus;
}): OutstationGateState {
  const { employeeRole, evidenceGateStatus, hasArrivalPhoto, hasDeparturePhoto, workloadGateStatus } =
    input;

  // Owner rule (2026-08-28): a National Sales Manager is never held, for any reason. This sits
  // ABOVE every other test on purpose — it is the strongest rule in this function, and putting
  // it anywhere lower would leave the reading of a claim depending on which check ran first.
  //
  // The workload gate is the one that actually bites here: it matches AM/PM visits out of the
  // CRM, an NSM generates none, so the gate could never clear and the claim could never be paid
  // without a Super Admin typing a workload in by hand. See nsm-no-hold.ts for the full rule.
  if (isOutstationNoHoldRole(employeeRole)) {
    return {
      blocker: null,
      isPayrollEligible: true,
      message: OUTSTATION_NO_HOLD_GATE_MESSAGE,
    };
  }

  if (isGrandfathered(evidenceGateStatus, workloadGateStatus)) {
    return {
      blocker: null,
      isPayrollEligible: true,
      message: "Submitted before the two-photo rule — exempt from it, not checked against it.",
    };
  }

  // Owner waiver (2026-08-19, widened to the Training Manager 2026-10-26): the roles in
  // evidence-waiver.ts owe no photo at all, so neither photo may block them — and the check has
  // to sit ABOVE both photo tests, because the arrival test alone would hold the request before
  // the departure test ever ran.
  //
  // The WORKLOAD gate is untouched. Only the photographs were waived; a trip still has to show
  // the day's work before it is paid, and quietly folding that into the same exemption would
  // have released these roles from a rule the owner did not mention.
  if (isOutstationEvidenceWaivedRole(employeeRole)) {
    if (workloadGateStatus === "pending_workload") {
      return {
        blocker: "workload",
        isPayrollEligible: false,
        message:
          "Photo evidence is not required for this role. Waiting for the AM/PM workload for every trip day to be captured from the CRM.",
      };
    }
    return {
      blocker: null,
      isPayrollEligible: true,
      message:
        workloadGateStatus === "manual"
          ? "Complete — photo evidence is not required for this role, and the workload was entered by hand by a system administrator."
          : "Complete — photo evidence is not required for this role, and the trip workload was matched from the CRM.",
    };
  }

  if (!hasArrivalPhoto) {
    return {
      blocker: "arrival_photo",
      isPayrollEligible: false,
      message: "Waiting for the arrival photo. Capture it in the app at your destination.",
    };
  }

  if (!hasDeparturePhoto) {
    return {
      blocker: "departure_photo",
      isPayrollEligible: false,
      message: "Waiting for the departure photo. Capture it before you leave the destination.",
    };
  }

  // Both photos are physically present. Only now may the evidence gate claim to be complete —
  // and if the stored status still says otherwise, the row is inconsistent and is held.
  if (evidenceGateStatus !== "complete") {
    return {
      blocker: "inconsistent",
      isPayrollEligible: false,
      message:
        `Both photos are stored but the evidence gate still reads "${evidenceGateStatus}". ` +
        "Held for a system administrator — this is a data fault, not a missing photo.",
    };
  }

  if (workloadGateStatus === "pending_workload") {
    return {
      blocker: "workload",
      isPayrollEligible: false,
      message: "Waiting for the AM/PM workload for every trip day to be captured from the CRM.",
    };
  }

  return {
    blocker: null,
    isPayrollEligible: true,
    message:
      workloadGateStatus === "manual"
        ? "Complete — workload was entered by hand by a system administrator, not matched from the CRM."
        : "Complete — both photos captured and the trip workload matched from the CRM.",
  };
}

/**
 * Convenience for the many call sites that only need the yes/no. Deliberately delegates rather
 * than re-implementing the condition: two copies of a payroll gate is how they drift apart.
 */
export function outstationRequestMayReachPayroll(input: {
  employeeRole: string;
  evidenceGateStatus: OutstationEvidenceGateStatus;
  hasArrivalPhoto: boolean;
  hasDeparturePhoto: boolean;
  workloadGateStatus: OutstationWorkloadGateStatus;
}): boolean {
  return resolveOutstationGateState(input).isPayrollEligible;
}

/**
 * Should this request appear in the repair panel — the list of what the GATE is holding?
 *
 * Pure, and kept here beside the gate itself, because it decides what a human is shown about
 * money that has not moved. Three exclusions, each for a different reason:
 *
 *   1. The gate is satisfied. There is nothing to repair.
 *   2. The request was REJECTED. It is held by a DECISION, not by evidence, and nothing offered
 *      in this panel may override that — the same reasoning, and the same rule, as
 *      releaseOutstationRequestToPayrollIfReady.
 *   3. The trip has not ENDED yet. The departure photo is taken before leaving the destination,
 *      so a request whose trip is still running is not held — it is in progress. Listing it under
 *      "Held out of payroll — the employee is not paid until each one clears", beside a button
 *      offering to waive the photo permanently, invites an administrator to waive a photo that is
 *      not yet due. This is not hypothetical: request 93 was submitted at 20:32 Cairo on the day
 *      of its own trip, and would have been the newest row in the list.
 *
 * What is deliberately NOT excluded is a request still awaiting approval. Until 2026-08-19 this
 * list required `status.startsWith("accepted")`, mirroring the release rule — but that rule is
 * about who may be PAID, and borrowing it here made the panel permanently empty. Since the
 * owner's 2026-08-08 change every submission persists as `submitted` and waits for a human;
 * production has carried 57 requests across two months without one ever reaching an `accepted_*`
 * status. So the panel built to make a failed CRM grab visible could never show anything, and
 * the 2026-08-19 repair had to be run from a script instead of from the screen built for it.
 *
 * Widening this list does not widen who gets paid. Every action the panel offers still ends in
 * releaseOutstationRequestToPayrollIfReady, which goes on refusing anything not `accepted_*`.
 */
/**
 * Is the departure-photo reminder due for this request today?
 *
 * **Exactly one day is reminded: the trip's last day.** Not before it, and — since 2026-08-19 —
 * not after it either.
 *
 * The "after" half used to send too, worded as overdue, and the owner ended it that evening with
 * the right question: what does that email add? The departure photo is a live camera capture,
 * taken at the destination, before the employee leaves. Once he is home there is no photo left
 * for him to take. He can still technically submit one — the trip window is enforced only on a
 * RETAKE (see the capture path in service.ts) — but it would be captured wherever he now is, days
 * late, and come back flagged `far_from_arrival` and `outside_trip_window`. So the overdue mail
 * asked a man whose money was stuck either to ignore it or to manufacture evidence that reads as
 * suspicious for a trip that genuinely happened. Neither is worth sending.
 *
 * A request whose window has closed is not chased. It is released by a Super Admin, with a
 * reason, which is what departure-evidence.ts always said should happen to it.
 *
 * Worth knowing when reading production history: the overdue branch is the only one that ever
 * fired. The last-day reminder could not reach a same-day trip until the submit path started
 * raising it (#2222, the same evening), because the 06:36 daily job cannot see a request that
 * will not exist until the afternoon. So every departure-photo reminder sent before 2026-08-19
 * was the kind this rule no longer sends.
 *
 * Pure, so the timing can be asserted without a database or a notification provider. Both dates
 * must be real YYYY-MM-DD: they are compared as STRINGS, so any other text sorts above a "2026-…"
 * date and would silently read as a future trip.
 */
export function outstationDeparturePhotoReminderDue(input: {
  gateBlocker: OutstationGateBlocker | null;
  todayCairo: string;
  tripEndDate: string | null;
}): { due: boolean } {
  const notDue = { due: false };
  if (input.gateBlocker !== "departure_photo") return notDue;

  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const lastDay = String(input.tripEndDate ?? "").slice(0, 10);
  const today = String(input.todayCairo ?? "").slice(0, 10);
  if (!isoDay.test(lastDay) || !isoDay.test(today)) return notDue;

  // The whole rule, in one line: the day he is still there, and no other day.
  return { due: lastDay === today };
}

export function isOutstationRequestHeldForRepair(input: {
  /** Today in Africa/Cairo as YYYY-MM-DD. Injected so the in-progress test is assertable. */
  cairoTodayIso: string;
  gate: OutstationGateState;
  status: string;
  tripEndDate: string | null;
}): boolean {
  if (input.gate.isPayrollEligible) return false;
  if (String(input.status ?? "").startsWith("rejected")) return false;

  // A missing or unreadable trip end cannot prove the trip is over, but it must not hide a
  // genuinely stuck request either — so it is shown. This test only ever removes a LIVE trip.
  //
  // The shape check is load-bearing, not defensive noise. These are compared as STRINGS, and any
  // non-date text sorts above a "2026-…" date — so without it a malformed value would read as a
  // trip far in the future and silently hide the request, which is the one outcome this whole
  // panel exists to prevent.
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const tripEnd = String(input.tripEndDate ?? "").slice(0, 10);
  const today = String(input.cairoTodayIso ?? "").slice(0, 10);
  if (isoDay.test(tripEnd) && isoDay.test(today) && tripEnd >= today) return false;

  return true;
}

/**
 * Validate a hand-entered AM/PM workload before it is allowed to release money.
 *
 * Extracted from setOutstationWorkloadManually so it can be asserted without a database. This is
 * the last check standing between a typed number and a payroll row, and every rule in it exists
 * because the alternative silently pays the wrong amount:
 *
 *   - A REASON is mandatory. This figure is entered by hand and releases a payment; six months
 *     later an unexplained one is indistinguishable from a mistake.
 *   - Non-finite input is REFUSED, not coerced. `Number("abc")` is NaN, and NaN written to the
 *     column would make the request's workload unreadable rather than wrong-but-visible.
 *   - Negatives are REFUSED, not clamped to zero. A negative is a typo or a bad payload; quietly
 *     turning it into 0 would record "he did no work" as though it had been measured.
 *   - Fractions are refused for the same reason: half a visit is not a thing, so a 2.5 means the
 *     caller meant something else.
 */
export type ManualWorkloadValidation =
  | { amWorkload: number; ok: true; pmWorkload: number; reason: string }
  | { message: string; ok: false };

export function validateManualWorkloadInput(input: {
  amWorkload: unknown;
  pmWorkload: unknown;
  reason: unknown;
}): ManualWorkloadValidation {
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    return { message: "A reason is required when entering the workload by hand.", ok: false };
  }

  const parsed: Record<"amWorkload" | "pmWorkload", number> = { amWorkload: 0, pmWorkload: 0 };
  for (const field of ["amWorkload", "pmWorkload"] as const) {
    const raw = input[field];
    // An empty string is a genuinely absent value, not a zero — Number("") is 0, which would let
    // a blank box record a measured zero.
    if (raw === "" || raw === null || raw === undefined) {
      return { message: `The ${field === "amWorkload" ? "AM" : "PM"} workload is required.`, ok: false };
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      return { message: `The ${field === "amWorkload" ? "AM" : "PM"} workload must be a number.`, ok: false };
    }
    if (value < 0) {
      return { message: "The workload cannot be negative.", ok: false };
    }
    if (!Number.isInteger(value)) {
      return { message: "The workload must be a whole number of visits.", ok: false };
    }
    parsed[field] = value;
  }

  return { amWorkload: parsed.amWorkload, ok: true, pmWorkload: parsed.pmWorkload, reason };
}

/**
 * The gate status a request should carry once a given photo lands. Kept next to the resolver so
 * the write path and the read path cannot disagree about what "complete" means.
 */
export function nextEvidenceGateStatus(input: {
  grandfathered?: boolean;
  hasArrivalPhoto: boolean;
  hasDeparturePhoto: boolean;
}): OutstationEvidenceGateStatus {
  if (input.grandfathered) return "grandfathered";
  if (!input.hasArrivalPhoto) return "pending_arrival_photo";
  if (!input.hasDeparturePhoto) return "pending_departure_photo";
  return "complete";
}
