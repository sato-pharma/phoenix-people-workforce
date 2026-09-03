import type { PayrollExpenseApproval, ExpenseTripRecord } from "@/lib/payroll/types";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import { normalizeExpenseType, normalizeTransportation } from "@/lib/outstation/expense-taxonomy";
import { currentCairoDateParts } from "@/lib/i18n/format";

function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isoDate(value: unknown) {
  const raw = toText(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function nextPayrollPeriod(dateValue: string) {
  const date = new Date(dateValue);
  let base: Date;
  if (Number.isNaN(date.getTime())) {
    // Unparseable date: fall back to "now" anchored to Africa/Cairo's calendar day
    // (not the server runtime's own timezone).
    const cairo = currentCairoDateParts();
    base = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day));
  } else {
    base = date;
  }
  const month = base.getUTCMonth() + 2;

  if (month > 12) {
    return { month: 1, year: base.getUTCFullYear() + 1 };
  }

  return { month, year: base.getUTCFullYear() };
}

export function outstationPayrollTripId(requestId: number | string) {
  return `OUTSTATION-${requestId}`;
}

export function outstationStatusLabel(value: unknown) {
  const normalized = toText(value).toLowerCase();
  if (normalized.includes("accept") || normalized.includes("approve") || normalized.includes("confirm")) return "Approved";
  if (normalized.includes("reject") || normalized.includes("decline")) return "Rejected";
  return "Pending";
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * The ONE rule for reading a `report_*` money override: `null`/absent means "no override was
 * recorded" and the raw column stands; an explicit `0` is a real override and wins.
 *
 * Before 2026-09-03 the two mappers below spelled this differently — the DISPLAY mapper null-checked
 * while the PUSH mapper used a `||` falsy-fallback — so a row with `report_other_amount = 0` over an
 * `other_amount` of 50 DISPLAYED 0 and PAID 50. Same class as the total divergence (PR #2951) and the
 * component divergence (PR #2957): two formulas for one figure. The push mapper could not null-check
 * until `mapOutstationRequestRow` stopped collapsing NULL to 0 for these columns — it now maps them
 * with `nullableNumber`, so `OutstationExpenseRequest.report{Meeting,Other}Amount` is `number | null`
 * and "column was NULL" is finally distinguishable from "override is genuinely zero".
 *
 * Takes `unknown` so a mapped `OutstationExpenseRequest` field and a raw database row value resolve
 * through the exact same code path.
 */
export function outstationReportOverride(override: unknown, raw: number): number {
  if (override === null || override === undefined) return raw;
  const parsed = Number(override);
  return Number.isFinite(parsed) ? parsed : raw;
}

/**
 * The ONE payable total for an outstation trip — shared by `mapOutstationRequestToPayrollExpenseRecord`
 * (what gets PUSHED to payroll) and `mapOutstationRequestRowToPayrollApproval` (what the admin table
 * and employee portal DISPLAY). Before 2026-09-03 they used two different formulas and disagreed on
 * live rows 52 and 99 — the push mapper preferred the client-posted `claimed_total_amount` the moment
 * a client posted anything greater than zero, silently underpaying both (request 52: paid 364 against
 * an 800 the row's own allowance column and the employee's own portal card both said; request 99: paid
 * 341.90 against 541.90). Nothing bounded the reverse case either.
 *
 * Owner ruling, 2026-09-03: the server's own priced total is authoritative. A client-posted claim is
 * recorded and shown separately (see `outstationClaimedTotal`) but must never become the payable
 * figure.
 *
 * Recomputes travel + meeting + allowance + other first — that self-heals a row whose stored
 * `expected_total_amount` has gone stale relative to its own report_* override columns (see the
 * "stale ticket columns" case in tests/outstation-manual-expense-ticket-plus-allowance.test.ts) — and
 * falls back to the stored `expected_total_amount` only when there is nothing to sum. Never falls
 * back to the claim.
 */
export function outstationPayableTotal(input: {
  allowanceAmount: number;
  expectedTotalAmount: number;
  isMeetingTrip: boolean;
  meetingAmount: number;
  otherAmount: number;
  travelCost: number;
}): { meetingAmount: number; total: number } {
  const expected =
    Number.isFinite(input.expectedTotalAmount) && input.expectedTotalAmount > 0
      ? roundMoney(input.expectedTotalAmount)
      : 0;
  // A meeting-type trip with no explicit meeting figure files its whole cost as "meeting" —
  // fall back to the server's own total, never the claim.
  const meetingAmount = input.meetingAmount || (input.isMeetingTrip ? expected : 0);
  const componentTotal = roundMoney(
    input.travelCost + meetingAmount + input.allowanceAmount + input.otherAmount,
  );
  return { meetingAmount, total: componentTotal > 0 ? componentTotal : expected };
}

/** Reads one of the doctor/pharmacy/institution totals out of a stored workload snapshot.
 * Pre-pharmacy-split snapshots don't carry them — undefined, never 0, so "not recorded" stays
 * distinguishable from "recorded zero" on every display surface. */
function snapshotKindCount(
  snapshot: OutstationExpenseRequest["workloadEvidenceSnapshot"],
  key: "doctorVisits" | "institutionVisits" | "pharmacyVisits",
): number | undefined {
  const value = (snapshot as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function mapOutstationRequestToPayrollExpenseRecord(
  request: OutstationExpenseRequest,
  options: {
    hrComment?: string | null;
    reportId?: string | null;
  } = {},
): ExpenseTripRecord & {
  hrApproved: boolean;
  hrComment: string;
  hrId: string;
  reportId?: string | null;
} {
  const tripStartDate = request.tripStartDate ? request.tripStartDate.slice(0, 10) : "";
  const tripEndDate = request.tripEndDate ? request.tripEndDate.slice(0, 10) : tripStartDate;
  // Prefer the override (survives an extra-ticket append, which updates report_travel_cost
  // without touching fuel_amount/ticket_amount) over the raw fuel+ticket sum.
  const travelCost = request.reportTravelCost ?? request.fuelAmount + request.ticketAmount;
  const { meetingAmount, total } = outstationPayableTotal({
    allowanceAmount: request.allowanceAmount,
    expectedTotalAmount: request.expectedTotalAmount,
    isMeetingTrip: request.expenseType === "meeting",
    meetingAmount: outstationReportOverride(request.reportMeetingAmount, request.meetingAmount),
    otherAmount: outstationReportOverride(request.reportOtherAmount, request.otherAmount),
    travelCost,
  });

  return {
    allowance: request.allowanceAmount,
    amWorkload: request.amWorkload ?? 0,
    capturedLatitude: request.capturedLatitude,
    capturedLongitude: request.capturedLongitude,
    // Pass through only — this mapper stays sync, so it never resolves geography itself
    // (see captured-location.ts). Present when the caller already enriched `request`.
    capturedLocation: request.capturedLocation ?? null,
    date: tripStartDate,
    description: request.notes ?? request.approvalReason ?? "Approved outstation expense",
    doctorVisits: snapshotKindCount(request.workloadEvidenceSnapshot, "doctorVisits"),
    from: request.residenceCity ?? request.residenceArea ?? "Residence",
    hr: "Approved",
    hrApproved: true,
    hrComment: options.hrComment ?? "Approved from outstation workflow.",
    hrId: request.employeeHrId,
    hrNotes: request.approvalReason,
    institutionVisits: snapshotKindCount(request.workloadEvidenceSnapshot, "institutionVisits"),
    km: request.distanceFromResidenceKm ?? 0,
    location: request.toLabel ?? request.toCity ?? request.toArea ?? "",
    meetingAmount,
    open: "",
    other: outstationReportOverride(request.reportOtherAmount, request.otherAmount),
    pharmacyVisits: snapshotKindCount(request.workloadEvidenceSnapshot, "pharmacyVisits"),
    pmWorkload: request.pmWorkload ?? 0,
    reportId: options.reportId ?? undefined,
    requestType: "Outstation",
    row: 1,
    specialist: request.employeeName,
    status: "Approved",
    to: request.toLabel ?? request.toCity ?? request.toArea ?? "",
    toDate: tripEndDate,
    total,
    transportationType: request.transportationType,
    travelCost,
    tripId: outstationPayrollTripId(request.id),
    tripType: request.expenseType,
  };
}

export function mapOutstationRequestRowToPayrollApproval(
  row: Record<string, unknown>,
): PayrollExpenseApproval {
  const status = outstationStatusLabel(row.status);
  const requestId = toText(row.id) || "request";
  const tripStartDate = isoDate(row.trip_start_date || row.created_at);
  const tripEndDate = isoDate(row.trip_end_date || row.trip_start_date || row.created_at);
  const destination =
    toText(row.to_label) ||
    [row.to_area, row.to_city].map(toText).filter(Boolean).join(", ");
  const origin =
    toText(row.residence_address) ||
    [row.residence_area, row.residence_city].map(toText).filter(Boolean).join(", ");
  const payout = nextPayrollPeriod(tripStartDate);
  const allowance = toNumber(row.allowance_amount);
  const expectedTotal = toNumber(row.expected_total_amount);

  // Use report_* override columns when set; fall back to original columns.
  const travelCost =
    row.report_travel_cost != null
      ? toNumber(row.report_travel_cost)
      : toNumber(row.fuel_amount) + toNumber(row.ticket_amount);
  const rawMeetingAmount = outstationReportOverride(
    row.report_meeting_amount,
    toNumber(row.meeting_amount),
  );
  const other = outstationReportOverride(row.report_other_amount, toNumber(row.other_amount));
  const amWorkload =
    row.report_am_workload != null ? toNumber(row.report_am_workload) : toNumber(row.am_workload);
  const pmWorkload =
    row.report_pm_workload != null ? toNumber(row.report_pm_workload) : toNumber(row.pm_workload);
  const hrStatus = toText(row.report_hr_status) || toText(row.employee_name);
  const hrNotes = toText(row.report_hr_notes) || toText(row.eligibility_reason);
  const tripType = toText(row.report_trip_type) || toText(row.expense_type) || "traveling";

  const { meetingAmount, total } = outstationPayableTotal({
    allowanceAmount: allowance,
    expectedTotalAmount: expectedTotal,
    isMeetingTrip: tripType.toLowerCase() === "meeting",
    meetingAmount: rawMeetingAmount,
    otherAmount: other,
    travelCost,
  });

  return {
    allowance,
    amWorkload,
    // Phoenix-submitted requests live in outstation_expense_requests, which has no
    // approved_amount column — HR adjusts amounts on the uploaded expense rows, not here.
    approvedAmount: null,
    approvedAt: null,
    approvedBy: null,
    capturedLatitude: toNumber(row.captured_latitude),
    capturedLongitude: toNumber(row.captured_longitude),
    date: tripStartDate,
    description: toText(row.notes) || "Outstation expense request",
    from: origin || "Residence",
    hr: hrStatus,
    hrApproved: status === "Approved",
    hrComment: toText(row.approval_reason),
    hrId: toText(row.employee_hr_id) || null,
    hrNotes,
    km: toNumber(row.distance_km ?? row.distance_from_residence_km),
    location: destination,
    meetingAmount,
    open: "",
    other,
    payoutMonth: payout.month,
    payoutYear: payout.year,
    pmWorkload,
    reportId: null,
    requestType: "Outstation",
    row: Number(row.id ?? 0),
    sourceFileName: "Outstation Requests",
    specialist: toText(row.employee_name),
    status,
    to: destination,
    toDate: tripEndDate,
    total,
    transportationType: normalizeTransportation(toText(row.transportation_type), tripType, meetingAmount),
    travelCost,
    tripId: outstationPayrollTripId(requestId),
    tripType: normalizeExpenseType(tripType),
  };
}
