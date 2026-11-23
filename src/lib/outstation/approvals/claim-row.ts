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
import { readTripStanding, type PayoutPeriod } from "@/lib/outstation/approvals/standing";
import type { ClaimVerdict, DeskClaim } from "@/lib/outstation/approvals/types";
import { usablePosition } from "@/lib/outstation/captured-coordinates";
import { cairoDateOnly } from "@/lib/outstation/departure-evidence";
import { resolveOutstationGateState } from "@/lib/outstation/expense-gate";
import { ticketReceiptFingerprint } from "@/lib/outstation/duplicate-ticket-guard";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { mapOutstationRequestRowToPayrollApproval, outstationPayrollTripId } from "@/lib/outstation/payroll-expense-mapping";
import { readNoTicketFare } from "@/lib/outstation/train-fare";
import type { OutstationEvidenceGateStatus, OutstationWorkloadGateStatus } from "@/lib/outstation/types";
import { addDaysIso } from "@/lib/crm/dates";

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
].join(", ");

/** What the tiles, the duplicate check and the agreement meter need of a DECIDED claim. */
export const DECIDED_CLAIM_COLUMNS = [
  "id", "status", "created_at", "updated_at", "trip_start_date", "trip_end_date", "employee_hr_id",
  "to_label", "to_area", "to_city", "captured_latitude", "captured_longitude", "expense_type",
  "go_ticket_amount", "return_ticket_amount", "other_amount", "report_other_amount", "ticket_attachment_metadata",
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

/** A destination in words, exactly as the mapper names it. */
export function destinationOfRow(row: ClaimRow): string {
  return text(row.to_label) || [row.to_area, row.to_city].map(text).filter(Boolean).join(", ");
}

export type ClaimContext = {
  duplicateTickets?: string[];
  duplicateTrips?: string[];
  /** undefined = not read for this claim (a decided one); null = Phoenix CRM could not be read. */
  fieldWork?: FieldWorkReading | null;
  /** The newest payout month a payroll has paid (queue.ts, `readLastPaidPayout`); absent = not read. */
  lastPaidPayout?: PayoutPeriod | null;
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

  return {
    arrival: {
      capturedOn: cairoDateOnly(text(arrivalMeta?.capturedAt) || null),
      fileTakenOn: fileTakenAt === undefined ? undefined : cairoDateOnly(text(fileTakenAt) || null),
      hasPosition: arrivalOnFile && usablePosition(num(arrivalMeta?.capturedLatitude), num(arrivalMeta?.capturedLongitude)) !== null,
      onFile: arrivalOnFile,
      uploaded: arrivalMeta?.source === "upload",
    },
    attachments,
    departure: {
      capturedOn: cairoDateOnly(text(departureMeta?.capturedAt) || null),
      flags: Array.isArray(departureMeta?.flags) ? (departureMeta.flags as unknown[]).map(String) : [],
      hasPosition:
        departureOnFile && usablePosition(num(departureMeta?.capturedLatitude), num(departureMeta?.capturedLongitude)) !== null,
      kmFromArrival: num(departureMeta?.distanceFromArrivalKm),
      minutesAfterArrival: num(departureMeta?.minutesAfterArrival),
      onFile: departureOnFile,
    },
    duplicateTickets: context.duplicateTickets ?? [],
    duplicateTrips: context.duplicateTrips ?? [],
    eligibilityReason: text(row.eligibility_reason) || null,
    eligibilityStatus: text(row.eligibility_status) || null,
    evidenceGateStatus: text(row.evidence_gate_status) || null,
    expenseType: text(row.expense_type) || "traveling",
    fieldWork: context.fieldWork ?? null,
    hasNoTicketFare: readNoTicketFare(row.no_ticket_fare) !== null,
    noTicketFareLine: text(object(row.no_ticket_fare)?.line) || null,
    role: text(row.employee_role) || null,
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
  // The stored row is the truth of a DECIDED claim: its own total and the amount he typed. A claim
  // still waiting reads its live figures — a payroll row left pending under it decides nothing.
  const total = waiting ? approval.total : (ledger?.total ?? approval.total);
  const approvedAmount = waiting ? null : (ledger?.approved_amount ?? null);
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
    employeeName: approval.specialist,
    employeeNote: approval.employeeNote ?? null,
    employeeRole: text(row.employee_role) || null,
    from: approval.from,
    holdReason: waiting ? holdReasonOfRow(row) : null,
    hrComment: waiting ? "" : approval.hrComment,
    hrId: approval.hrId,
    locked: reading.standing === "in_payroll",
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

/** "the claim of 19 Nov" — how a duplicate names the other claim, never by a code. */
export function claimInWords(row: ClaimRow, standingWord: string): string {
  const day = tripDatesOfRow(row)[0];
  return `the ${standingWord} claim of ${shortDay(day)}`;
}
