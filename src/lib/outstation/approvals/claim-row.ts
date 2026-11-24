/**
 * One claim row of `outstation_expense_requests`, turned into what the desk draws.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). Three things live here and nowhere else:
 *
 *   - `DESK_CLAIM_COLUMNS` — the columns the desk reads. Never `select("*")`: the row also carries
 *     the route polyline, the route alternatives, the allowance breakdown and the workload
 *     snapshot, which the old page pulled for all 694 trips to draw a list.
 *   - `claimFactsFromRow` — the stored facts the checks read (photos, tickets, eligibility).
 *   - `buildDeskClaim` — the row a lane prints. Its money comes from the ONE payroll mapper
 *     (`mapOutstationRequestRowToPayrollApproval`) and the stored ledger row; nothing here
 *     re-derives a total, and an amount he typed is never replaced by the claim's total.
 *
 * Synchronous and database-free, so `queue.ts`, `history.ts` and `decide.ts` build the same claim
 * from the same row and the tests pin it without a read.
 */

import { claimPreCut, isTripClaim, judgeClaim, shortDay, type ClaimCheckFacts, type FieldWorkReading } from "@/lib/outstation/approvals/checks";
import { claimKindOf } from "@/lib/outstation/approvals/claim-kind";
import { readTripStanding, type PayoutPeriod } from "@/lib/outstation/approvals/standing";
import type { ClaimVerdict, DeskClaim } from "@/lib/outstation/approvals/types";
import { usablePosition } from "@/lib/outstation/captured-coordinates";
import { cairoDateOnly } from "@/lib/outstation/departure-evidence";
import { resolveOutstationGateState } from "@/lib/outstation/expense-gate";
import { ticketReceiptFingerprint } from "@/lib/outstation/duplicate-ticket-guard";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { mapOutstationRequestRowToPayrollApproval, outstationPayrollTripId, outstationReportOverride } from "@/lib/outstation/payroll-expense-mapping";
import { odometerFromValue, odometerOfMetadata, type OutstationOdometerRecord } from "@/lib/outstation/odometer-scan-rules";
import { frameOfMetadata } from "@/lib/outstation/blank-frame";
import { returnTicketState } from "@/lib/outstation/return-ticket";
import { distanceVisitWords, isDistrictManagerRole, isTripExpense, readDistanceBasis } from "@/lib/outstation/dm-double-visit-distance";
import { readNoTicketFare } from "@/lib/outstation/train-fare";
import type { OutstationEvidenceGateStatus, OutstationWorkloadGateStatus } from "@/lib/outstation/types";
import { addDaysIso } from "@/lib/crm/dates";
import { readHrAmounts } from "@/lib/outstation/hr-amounts";

export type ClaimRow = Record<string, unknown>;

/** The stored payroll row that carries an accepted claim (`trip_id = OUTSTATION-<id>`). */
export type LedgerRow = {
  approved_amount: number | null;
  approved_at: string | null;
  imported_payroll_batch_id: string | null;
  imported_to_payroll_at: string | null;
  payout_month: number | null;
  payout_year: number | null;
  total: number | null;
  trip_id: string;
};

export const LEDGER_COLUMNS =
  "trip_id, total, approved_amount, approved_at, payout_month, payout_year, imported_payroll_batch_id, imported_to_payroll_at";

/** Every column the mapper, the checks and the row read — and none of the heavy ones. */
export const DESK_CLAIM_COLUMNS = [
  "id", "status", "created_at", "updated_at", "trip_start_date", "trip_end_date",
  "employee_hr_id", "employee_name", "employee_role",
  "to_label", "to_area", "to_city", "residence_address", "residence_area", "residence_city",
  "residence_latitude", "residence_longitude", "captured_latitude", "captured_longitude",
  "distance_km", "distance_from_residence_km",
  "allowance_amount", "expected_total_amount", "fuel_amount", "ticket_amount", "meeting_amount", "other_amount",
  "report_travel_cost", "report_meeting_amount", "report_other_amount", "report_trip_type",
  "go_ticket_amount", "return_ticket_amount", "ticket_attachment_metadata", "attachment_count", "meeting_invoice_path",
  "no_ticket_fare", "am_workload", "pm_workload", "pharmacy_workload", "workload_match_status",
  "expense_type", "transportation_type", "notes", "approval_reason", "eligibility_status", "eligibility_reason",
  "car_evidence_image_path", "car_evidence_metadata", "departure_evidence_image_path", "departure_evidence_metadata",
  "evidence_gate_status", "workload_gate_status", "system_lane_at_decision", "system_verdict_at_decision",
  "distance_basis", "hr_amounts",
].join(", ");

/**
 * What the tiles (and their filters: the name, kind and trip dates), the duplicate check, the odometer chain and the agreement meter need of a DECIDED
 * claim. The two odometer readings are read out of the photo metadata by path, so the rest of that
 * JSON (positions, retakes, summaries) is not pulled for every claim ever decided.
 */
export const DECIDED_CLAIM_COLUMNS = [
  "id", "status", "created_at", "updated_at", "trip_start_date", "trip_end_date", "employee_hr_id", "employee_name",
  "to_label", "to_area", "to_city", "captured_latitude", "captured_longitude", "expense_type",
  "go_ticket_amount", "return_ticket_amount", "other_amount", "report_other_amount", "ticket_attachment_metadata",
  "transportation_type", "distance_km", "distance_from_residence_km",
  "arrival_odometer:car_evidence_metadata->odometer", "departure_odometer:departure_evidence_metadata->odometer",
  "system_lane_at_decision", "system_verdict_at_decision",
].join(", ");

/** No real outstation trip is longer; a bad end date must not build a year of days. */
const MAX_TRIP_DAYS = 31;

const text = (value: unknown): string => String(value ?? "").trim();

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The trip's Cairo days, first to last. Empty when the row carries no start. */
export function tripDatesOfRow(row: ClaimRow): string[] {
  const start = cairoDateOnly(text(row.trip_start_date) || null);
  if (!start) return [];
  const end = cairoDateOnly(text(row.trip_end_date) || null) ?? start;
  const dates: string[] = [];
  for (let day = start; day <= end && dates.length < MAX_TRIP_DAYS; day = addDaysIso(day, 1)) dates.push(day);
  return dates.length > 0 ? dates : [start];
}

export function requestIdOfRow(row: ClaimRow): number {
  return Number(row.id ?? 0);
}

/** The ticket photos' fingerprints, for the "same ticket" check. */
export function receiptPrintsOfRow(row: ClaimRow): string[] {
  if (!Array.isArray(row.ticket_attachment_metadata)) return [];
  return (row.ticket_attachment_metadata as unknown[])
    .map(object)
    .filter((file): file is Record<string, unknown> => file !== null)
    .map((file) => ticketReceiptFingerprint({ name: typeof file.name === "string" ? file.name : null, size: num(file.size) ?? 0 }))
    .filter((print): print is string => Boolean(print));
}

/**
 * The odometer readings kept beside a car trip's photos (odometer-scan-rules.ts): from the path-read
 * columns of a decided claim, or from the whole metadata of a waiting one. `undefined` = never read
 * (a photo taken before the rule, or no photo).
 */
export function odometerReadingsOfRow(row: ClaimRow): {
  arrival: OutstationOdometerRecord | undefined;
  departure: OutstationOdometerRecord | undefined;
} {
  return {
    arrival: "arrival_odometer" in row ? odometerFromValue(row.arrival_odometer) : odometerOfMetadata(row.car_evidence_metadata),
    departure: "departure_odometer" in row ? odometerFromValue(row.departure_odometer) : odometerOfMetadata(row.departure_evidence_metadata),
  };
}

/** The one-way kilometres the trip's fuel was priced on; null when the row carries none. */
export function oneWayKmOfRow(row: ClaimRow): number | null {
  const km = num(row.distance_from_residence_km) ?? num(row.distance_km);
  return km !== null && km >= 0 ? km : null;
}

/** A destination in words, exactly as the mapper names it. */
export function destinationOfRow(row: ClaimRow): string {
  return text(row.to_label) || [row.to_area, row.to_city].map(text).filter(Boolean).join(", ");
}

/** Where a car trip's odometer stands against the employee's earlier car trips (queue.ts, `findOdometerChains`). */
export type OdometerChain = {
  anchor: { date: string; km: number } | null;
  paidKmSinceAnchor: number | null;
};

export type ClaimContext = {
  duplicateTickets?: string[];
  duplicateTrips?: string[];
  /** undefined = not read for this claim (a decided one); null = Phoenix CRM could not be read. */
  fieldWork?: FieldWorkReading | null;
  /** The newest payout month a payroll has paid (queue.ts, `readLastPaidPayout`); absent = not read. */
  lastPaidPayout?: PayoutPeriod | null;
  odometerChain?: OdometerChain;
  sharedTripDays?: string[];
  today: string;
};

/** The stored facts the checks read. Reads the row only; the context brings what other reads found. */
export function claimFactsFromRow(row: ClaimRow, context: ClaimContext): ClaimCheckFacts {
  const arrivalMeta = object(row.car_evidence_metadata);
  const departureMeta = object(row.departure_evidence_metadata);
  const arrivalOnFile = Boolean(text(row.car_evidence_image_path));
  const departureOnFile = Boolean(text(row.departure_evidence_image_path));
  const tickets = Array.isArray(row.ticket_attachment_metadata) ? row.ticket_attachment_metadata.length : 0;
  const attachments = Math.max(num(row.attachment_count) ?? 0, tickets + (text(row.meeting_invoice_path) ? 1 : 0));
  const fileTakenAt = arrivalMeta && "fileTakenAt" in arrivalMeta ? arrivalMeta.fileTakenAt : undefined;
  const odometer = odometerReadingsOfRow(row);
  const reading = (record: OutstationOdometerRecord) => ({ km: record.km, status: record.status });

  return {
    arrival: {
      blank: arrivalOnFile ? frameOfMetadata(arrivalMeta)?.blank : undefined,
      capturedOn: cairoDateOnly(text(arrivalMeta?.capturedAt) || null),
      fileTakenOn: fileTakenAt === undefined ? undefined : cairoDateOnly(text(fileTakenAt) || null),
      hasPosition: arrivalOnFile && usablePosition(num(arrivalMeta?.capturedLatitude), num(arrivalMeta?.capturedLongitude)) !== null,
      onFile: arrivalOnFile,
      uploaded: arrivalMeta?.source === "upload",
    },
    attachments,
    departure: {
      blank: departureOnFile ? frameOfMetadata(departureMeta)?.blank : undefined,
      capturedOn: cairoDateOnly(text(departureMeta?.capturedAt) || null),
      flags: Array.isArray(departureMeta?.flags) ? (departureMeta.flags as unknown[]).map(String) : [],
      hasPosition:
        departureOnFile && usablePosition(num(departureMeta?.capturedLatitude), num(departureMeta?.capturedLongitude)) !== null,
      kmFromArrival: num(departureMeta?.distanceFromArrivalKm),
      minutesAfterArrival: num(departureMeta?.minutesAfterArrival),
      onFile: departureOnFile,
    },
    // Read only for a District Manager's trip: the rule is his alone (dm-double-visit-distance.ts).
    distanceBasis:
      isDistrictManagerRole(text(row.employee_role)) && isTripExpense(text(row.expense_type))
        ? readDistanceBasis(row.distance_basis)
        : undefined,
    duplicateTickets: context.duplicateTickets ?? [],
    duplicateTrips: context.duplicateTrips ?? [],
    eligibilityReason: text(row.eligibility_reason) || null,
    eligibilityStatus: text(row.eligibility_status) || null,
    evidenceGateStatus: text(row.evidence_gate_status) || null,
    expenseType: text(row.expense_type) || "traveling",
    fieldWork: context.fieldWork ?? null,
    hasNoTicketFare: readNoTicketFare(row.no_ticket_fare) !== null,
    // The meeting amount as payroll reads it: HR's override when there is one, else the claim's own.
    meetingCost: outstationReportOverride(row.report_meeting_amount, num(row.meeting_amount) ?? 0),
    noTicketFareLine: text(object(row.no_ticket_fare)?.line) || null,
    odometer:
      odometer.arrival === undefined
        ? undefined
        : {
            anchor: context.odometerChain?.anchor ?? null,
            arrival: reading(odometer.arrival),
            departure: odometer.departure ? reading(odometer.departure) : null,
            paidKmSinceAnchor: context.odometerChain?.paidKmSinceAnchor ?? null,
          },
    returnAmount: num(row.return_ticket_amount) ?? 0,
    returnTicket: returnTicketState({
      returnAmount: num(row.return_ticket_amount),
      tickets: row.ticket_attachment_metadata,
      transportation: row.transportation_type,
    }),
    role: text(row.employee_role) || null,
    sharedTripDays: context.sharedTripDays ?? [],
    today: context.today,
    transportation: text(row.transportation_type),
    tripDates: tripDatesOfRow(row),
  };
}

/**
 * The verdict a DECIDED claim shows: the one kept when he decided it, or — for every claim decided
 * before the rebuild — nothing, said as nothing. The past was decided on checks nobody kept.
 */
export function storedVerdictOfRow(row: ClaimRow): ClaimVerdict {
  const stored = object(row.system_verdict_at_decision);
  const lane = text(row.system_lane_at_decision);
  const checks = Array.isArray(stored?.checks) ? (stored.checks as ClaimVerdict["checks"]) : [];
  if ((lane === "ready" || lane === "your_call") && checks.length > 0) {
    return { checks, idleDates: [], lane, reason: lane === "ready" ? null : text(stored?.reason) || null };
  }
  return { checks: [], idleDates: [], lane: "your_call", reason: "Decided before the checks were kept." };
}

/**
 * Why approving this claim would NOT reach payroll yet, in the gate's own words — null when it
 * would. The payroll gate decides (`resolveOutstationGateState`, the function the approve path
 * itself asks); this only reads it early, so the row can say "held" before the press and a reduced
 * amount — which a held trip has no payroll row to carry — is refused instead of lost.
 */
export function holdReasonOfRow(row: ClaimRow): string | null {
  const gate = resolveOutstationGateState({
    employeeRole: text(row.employee_role),
    // The same fallbacks the service reads a row with: an unstamped row is a pre-gate one.
    evidenceGateStatus: (text(row.evidence_gate_status) as OutstationEvidenceGateStatus) || "grandfathered",
    hasArrivalPhoto: Boolean(text(row.car_evidence_image_path)),
    hasDeparturePhoto: Boolean(text(row.departure_evidence_image_path)),
    workloadGateStatus: (text(row.workload_gate_status) as OutstationWorkloadGateStatus) || "grandfathered",
  });
  return gate.isPayrollEligible ? null : gate.message;
}

export function daysBetween(fromIso: string | null, now: Date): number {
  const from = fromIso ? Date.parse(fromIso) : Number.NaN;
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, Math.floor((now.getTime() - from) / 86_400_000));
}

/** A District Manager trip's two distances, as the opened trip prints them; null for anyone else or before pricing. */
export function deskDistanceOfRow(row: ClaimRow): DeskClaim["distance"] {
  if (!isDistrictManagerRole(text(row.employee_role)) || !isTripExpense(text(row.expense_type))) return null;
  const basis = readDistanceBasis(row.distance_basis);
  if (!basis) return null;
  return {
    basis: basis.basis,
    capturedKm: basis.capturedKm,
    visitKm: basis.basis === "first_double_visit" ? (basis.visit?.km ?? null) : null,
    minimumKm: basis.minimumKm,
    visitWords: basis.visit ? distanceVisitWords(basis.visit) : null,
  };
}

export function buildDeskClaim(input: {
  context: ClaimContext;
  ledger: LedgerRow | null;
  now: Date;
  relatedRequestIds?: number[];
  row: ClaimRow;
}): DeskClaim {
  const { ledger, row } = input;
  const approval = mapOutstationRequestRowToPayrollApproval(row);
  const payoutMonth = ledger?.payout_month ?? approval.payoutMonth;
  const payoutYear = ledger?.payout_year ?? approval.payoutYear;
  const reading = readTripStanding({
    hasPayrollRow: ledger !== null,
    lastPaidPayout: input.context.lastPaidPayout ?? null,
    payoutMonth,
    payoutYear,
    payrollStamped: Boolean(ledger?.imported_payroll_batch_id || ledger?.imported_to_payroll_at),
    status: text(row.status),
  });
  const waiting = reading.standing === "waiting";
  const verdict = waiting ? judgeClaim(claimFactsFromRow(row, input.context)) : storedVerdictOfRow(row);
  // The stored row is the truth of an APPROVED claim: its own total and the amount he typed. A claim
  // still waiting reads its live figures — a payroll row left pending under it decides nothing — and
  // so does a REJECTED one: rejecting a waiting claim leaves its row behind, and approving it again
  // writes the row from the claim as it is now. "Approve EGP X" must name what payroll will pay.
  const live = waiting || reading.standing === "rejected";
  const total = live ? approval.total : (ledger?.total ?? approval.total);
  const approvedAmount = live ? null : (ledger?.approved_amount ?? null);
  const tripDates = tripDatesOfRow(row);
  const preCut =
    waiting && isTripClaim(text(row.expense_type)) && verdict.idleDates.length > 0
      ? claimPreCut({ allowance: approval.allowance, idleDays: verdict.idleDates.length, total: approval.total, tripDays: tripDates.length })
      : null;

  return {
    allowance: approval.allowance,
    approvedAmount,
    daysWaiting: waiting ? daysBetween(text(row.created_at) || null, input.now) : 0,
    declaredWorkload: {
      am: approval.amWorkload ?? 0,
      matchStatus: approval.workloadMatchStatus ?? null,
      pharmacies: approval.pharmacyWorkload ?? null,
      pm: approval.pmWorkload ?? 0,
    },
    decidedAt: waiting ? null : (ledger?.approved_at ?? (text(row.updated_at) || null)),
    distance: deskDistanceOfRow(row),
    employeeName: approval.specialist,
    employeeNote: approval.employeeNote ?? null,
    employeeRole: text(row.employee_role) || null,
    from: approval.from,
    holdReason: waiting ? holdReasonOfRow(row) : null,
    hrComment: waiting ? "" : approval.hrComment,
    hrId: approval.hrId,
    kind: claimKindOf(row.expense_type),
    locked: reading.standing === "in_payroll",
    parts: claimPartsOfRow(row),
    payable: reading.standing === "rejected" ? 0 : payableExpenseAmount(approvedAmount, total),
    payoutMonth,
    payoutYear,
    preCut,
    relatedRequestIds: input.relatedRequestIds ?? [],
    requestId: requestIdOfRow(row),
    revision: approval.requestRevision ?? "",
    standing: reading.standing,
    submittedAt: text(row.created_at) || null,
    systemNote: waiting ? approval.hrComment || null : null,
    to: approval.to,
    total,
    transportation: approval.transportationType,
    tripEnd: tripDates[tripDates.length - 1] ?? approval.toDate,
    tripId: outstationPayrollTripId(requestIdOfRow(row)),
    tripStart: tripDates[0] ?? approval.date,
    tripType: approval.tripType,
    verdict,
  };
}

/**
 * The trip's four parts as the employee claimed them — the same mapper with the edit left out — and
 * the edit itself. What the amounts box prints; the money the claim pays already follows the edit.
 */
export function claimPartsOfRow(row: ClaimRow): NonNullable<DeskClaim["parts"]> {
  const claimed = mapOutstationRequestRowToPayrollApproval({ ...row, hr_amounts: null });
  return {
    claimed: { allowance: claimed.allowance, meeting: claimed.meetingAmount, other: claimed.other, travel: claimed.travelCost },
    claimedTotal: claimed.total,
    edited: readHrAmounts(row.hr_amounts),
  };
}

/** "the claim of 19 Nov" — how a duplicate names the other claim, never by a code. */
export function claimInWords(row: ClaimRow, standingWord: string): string {
  const day = tripDatesOfRow(row)[0];
  return `the ${standingWord} claim of ${shortDay(day)}`;
}
