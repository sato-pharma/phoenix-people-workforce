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

function outstationExpenseTotal(input: {
  claimedTotalAmount: number;
  expectedTotalAmount: number;
}) {
  return input.claimedTotalAmount > 0 ? input.claimedTotalAmount : input.expectedTotalAmount;
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
  const total = outstationExpenseTotal({
    claimedTotalAmount: request.claimedTotalAmount,
    expectedTotalAmount: request.expectedTotalAmount,
  });

  return {
    allowance: request.allowanceAmount,
    amWorkload: request.amWorkload ?? 0,
    date: tripStartDate,
    description: request.notes ?? request.approvalReason ?? "Approved outstation expense",
    from: request.residenceCity ?? request.residenceArea ?? "Residence",
    hr: "Approved",
    hrApproved: true,
    hrComment: options.hrComment ?? "Approved from outstation workflow.",
    hrId: request.employeeHrId,
    hrNotes: request.approvalReason,
    km: request.distanceFromResidenceKm ?? 0,
    location: request.toLabel ?? request.toCity ?? request.toArea ?? "",
    meetingAmount: request.meetingAmount ?? (request.expenseType === "meeting" ? total : 0),
    open: "",
    other: request.otherAmount ?? 0,
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
    travelCost: request.fuelAmount + request.ticketAmount,
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
  const claimedTotal = toNumber(row.claimed_total_amount);
  const expectedTotal = toNumber(row.expected_total_amount);
  const fallbackTotal = claimedTotal > 0 ? claimedTotal : expectedTotal;

  // Use report_* override columns when set; fall back to original columns.
  const travelCost =
    row.report_travel_cost != null
      ? toNumber(row.report_travel_cost)
      : toNumber(row.fuel_amount) + toNumber(row.ticket_amount);
  const rawMeetingAmount =
    row.report_meeting_amount != null
      ? toNumber(row.report_meeting_amount)
      : toNumber(row.meeting_amount);
  const other =
    row.report_other_amount != null
      ? toNumber(row.report_other_amount)
      : toNumber(row.other_amount);
  const amWorkload =
    row.report_am_workload != null ? toNumber(row.report_am_workload) : toNumber(row.am_workload);
  const pmWorkload =
    row.report_pm_workload != null ? toNumber(row.report_pm_workload) : toNumber(row.pm_workload);
  const hrStatus = toText(row.report_hr_status) || toText(row.employee_name);
  const hrNotes = toText(row.report_hr_notes) || toText(row.eligibility_reason);
  const tripType = toText(row.report_trip_type) || toText(row.expense_type) || "traveling";

  // For meeting-type requests with no explicit amount, fall back to the claimed/expected total.
  const meetingAmount = rawMeetingAmount || (tripType.toLowerCase() === "meeting" ? fallbackTotal : 0);
  const componentTotal = travelCost + meetingAmount + allowance + other;
  const total = componentTotal > 0 ? componentTotal : fallbackTotal;

  return {
    allowance,
    amWorkload,
    // Phoenix-submitted requests live in outstation_expense_requests, which has no
    // approved_amount column — HR adjusts amounts on the uploaded expense rows, not here.
    approvedAmount: null,
    approvedAt: null,
    approvedBy: null,
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
