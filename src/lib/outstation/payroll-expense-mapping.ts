import type { PayrollExpenseApproval, ExpenseTripRecord } from "@/lib/payroll/types";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";

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
  const base = Number.isNaN(date.getTime()) ? new Date() : date;
  const month = base.getMonth() + 2;

  if (month > 12) {
    return { month: 1, year: base.getFullYear() + 1 };
  }

  return { month, year: base.getFullYear() };
}

export function outstationPayrollTripId(requestId: number | string) {
  return `OUTSTATION-${requestId}`;
}

export function outstationStatusLabel(value: unknown) {
  const normalized = toText(value).toLowerCase();
  if (normalized.includes("approve") || normalized.includes("confirm")) return "Approved";
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
    otherAmount: request.otherAmount ?? 0,
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
  const expectedTotal = toNumber(row.expected_total_amount);
  const claimedTotal = toNumber(row.claimed_total_amount);
  const total = outstationExpenseTotal({
    claimedTotalAmount: claimedTotal,
    expectedTotalAmount: expectedTotal,
  });
  const destination =
    toText(row.to_label) ||
    [row.to_area, row.to_city].map(toText).filter(Boolean).join(", ");
  const origin =
    toText(row.residence_address) ||
    [row.residence_area, row.residence_city].map(toText).filter(Boolean).join(", ");
  const payout = nextPayrollPeriod(tripStartDate);

  return {
    allowance: toNumber(row.allowance_amount),
    amWorkload: toNumber(row.am_workload),
    approvedAt: null,
    approvedBy: null,
    date: tripStartDate,
    description: toText(row.notes) || "Outstation expense request",
    from: origin || "Residence",
    hr: toText(row.employee_name),
    hrApproved: status === "Approved",
    hrComment: toText(row.approval_reason),
    hrId: toText(row.employee_hr_id) || null,
    hrNotes: toText(row.eligibility_reason),
    km: toNumber(row.distance_km ?? row.distance_from_residence_km),
    location: destination,
    meetingAmount: toNumber(row.meeting_amount) || (toText(row.expense_type).toLowerCase() === "meeting" ? total : 0),
    open: "",
    otherAmount: toNumber(row.other_amount),
    payoutMonth: payout.month,
    payoutYear: payout.year,
    pmWorkload: toNumber(row.pm_workload),
    reportId: null,
    requestType: "Outstation",
    row: Number(row.id ?? 0),
    sourceFileName: "Outstation Requests",
    specialist: toText(row.employee_name),
    status,
    to: destination,
    toDate: tripEndDate,
    total,
    transportationType: toText(row.transportation_type) || "other",
    travelCost: toNumber(row.fuel_amount) + toNumber(row.ticket_amount),
    tripId: outstationPayrollTripId(requestId),
    tripType: toText(row.expense_type) || "traveling",
  };
}
