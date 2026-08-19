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

  if (isGrandfathered(evidenceGateStatus, workloadGateStatus)) {
    return {
      blocker: null,
      isPayrollEligible: true,
      message: "Submitted before the two-photo rule — exempt from it, not checked against it.",
    };
  }

  // Owner waiver (2026-08-19): the three roles in evidence-waiver.ts owe no photo at all, so
  // neither photo may block them — and the check has to sit ABOVE both photo tests, because the
  // arrival test alone would hold the request before the departure test ever ran.
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
  hasArrivalPhoto: boolean;
  hasDeparturePhoto: boolean;
}): OutstationEvidenceGateStatus {
  if (!input.hasArrivalPhoto) return "pending_arrival_photo";
  if (!input.hasDeparturePhoto) return "pending_departure_photo";
  return "complete";
}
