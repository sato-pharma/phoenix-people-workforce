import type { PayrollExpenseApproval, ExpenseTripRecord } from "@/lib/payroll/types";
import type { OutstationExpenseRequest } from "@/lib/outstation/types";
import { outstationClaimRevision } from "@/lib/outstation/claim-revision";
import { normalizeExpenseType, normalizeTransportation } from "@/lib/outstation/expense-taxonomy";
import { nextPayrollPeriod } from "@/lib/outstation/payroll-period";

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
 * The ONE rule for reading an outstation trip's AM/PM workload — the resolved
 * `am_workload`/`pm_workload` columns, never the `report_*_workload` pair.
 *
 * The workload columns look like the money columns above and are NOT the same shape.
 * `report_am_workload`/`report_pm_workload` are `double precision NOT NULL DEFAULT 0` in
 * production, so they can never be NULL: a `!= null` fallback to the resolved column can never
 * fire, which makes "prefer the override" unconditional. And in practice no client sends a value
 * into them — the mobile wizard's editable "AM Workload"/"PM Workload" inputs were removed
 * precisely because a rep who left them blank (as the adjacent "resolved automatically" note tells
 * them to) sent 0; the admin modal's fields are read-only and echo back the raw value; and #2958
 * banned amWorkload/pmWorkload from both employee submit paths. Measured on production
 * ozucdzovmcqvepbozvqf, 2026-09-03: all 80 rows carry
 * `report_am_workload = report_pm_workload = 0` — 0 NULL, 0 positive — while 39 carry a real
 * `am_workload` and 50 a real `pm_workload`.
 *
 * They are still WRITABLE, so do not read "always zero" as "dead column and safe to drop":
 * `/api/outstation/calculate` and the admin manager-expense create path both still accept an
 * `amWorkload`/`pmWorkload` and write it here (service.ts, via the calculation and via
 * createManagerExpenseAsAdmin). What is guaranteed is not that nobody writes them — it is that
 * NEITHER payroll mapper reads them, deliberately, which is what keeps a planted value inert.
 *
 * `am_workload`/`pm_workload` are the truth: every write path runs
 * `resolveOutstationWorkloadPayload` and overwrites them from the published Double Visit Analytics
 * snapshot, the retry capture path writes them, and the Super Admin manual-override path writes
 * them (with an audit row). None of those three touch `report_*_workload`.
 *
 * Before 2026-09-03 the two mappers below disagreed here — same class as the total divergence
 * (PR #2951), the component divergence (PR #2957) and the zeroed-override divergence (PR #2960).
 * The DISPLAY mapper preferred the always-zero override, so the payroll approval table AND the
 * employee portal showed "AM 0 · PM 0" for every outstation trip in production (39 rows with a
 * real AM count, 50 with a real PM count), while the PUSH mapper sent payroll the real figures.
 * The push mapper was the correct one, so this resolves toward it: routing both through
 * `outstationReportOverride` instead would have replaced the real counts with 0 on the payroll
 * record for all 80 rows, destroying the very evidence that justifies the claim.
 *
 * Takes `unknown` so a mapped `OutstationExpenseRequest` field and a raw database row value
 * resolve through the exact same code path.
 */
export function outstationWorkloadCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The trip's third workload figure — THE AM · PM · PHARMACIES GOLDEN RULE (owner, 2026-09-21).
 *
 * Unlike AM and PM this is NULLABLE, and NULL is not zero: it means no separate pharmacy figure
 * was recorded — the trip was stamped before the split (its pharmacy visits still sit inside AM/PM,
 * and the stored record never kept which period each fell in, so it cannot be split after the
 * fact), or the workload was typed by hand as AM and PM. A display prints "not counted separately"
 * for it, never a 0 that would read as "he visited no pharmacy".
 */
export function outstationPharmacyWorkload(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  // A meeting-type trip with no explicit meeting figure files its cost as "meeting" — but only
  // the RESIDUAL, the part of the server's own total that the trip's other components do not
  // already account for. Never the claim, and never the whole expected total.
  //
  // Falling back to the whole `expected` double-counted every meeting trip that also carried
  // travel, because `expected` is itself travel + meeting + allowance + other (see
  // `reportExpectedTotal` in service.ts): the trip's own total was added on top of the very
  // components it was computed from. Request 72 (Dina Hamdy Fadel Mohamed Bdair, B-12,
  // 12 August 2026 — LIVE, production ozucdzovmcqvepbozvqf) priced 323.14 of fuel with a zero
  // meeting amount, and reached payroll at 646.28 against the 323.14 the Expense Approvals page
  // showed the approver. The residual is 0 there, so both sides now read 323.14.
  //
  // sync-offline/route.ts already documents the MIRROR of this — a client-sent `tripType` of
  // "meeting" doubling the APPROVER's total — and defends against it by refusing the field. The
  // same arithmetic reached the push side through the row's own `expense_type` instead, where no
  // gate could see it. Fixing it here closes both directions at the shared formula.
  const nonMeetingComponents = roundMoney(
    input.travelCost + input.allowanceAmount + input.otherAmount,
  );
  const meetingResidual = input.isMeetingTrip
    ? Math.max(0, roundMoney(expected - nonMeetingComponents))
    : 0;
  const meetingAmount = input.meetingAmount || meetingResidual;
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

/**
 * A trip's own figures, shaped for `outstation_expenses`.
 *
 * The `hr` / `hrApproved` / `status` fields below are a DEFAULT, not a decision: they say what a
 * trip reaching payroll for the FIRST time should look like. Every caller here re-pushes the same
 * trip whenever its figures move — an employee adding an extra ticket, an admin editing the
 * destination — and none of those is HR deciding anything, so the record carries
 * `preserveExistingDecision: true` and savePayrollExpenseApprovals keeps whatever HR already
 * decided on the row (see resolveExpenseDecisionWrite). Without it a re-push wrote
 * approved_amount = NULL / hr_approved = true / status = "Approved" over HR's own reduction or
 * rejection, and payroll went back to paying the full claim.
 *
 * A caller that IS the decision passes `preserveExistingDecision: false`.
 */
export function mapOutstationRequestToPayrollExpenseRecord(
  request: OutstationExpenseRequest,
  options: {
    hrComment?: string | null;
    /** Default true — see above. Only an HR decision may set this false. */
    preserveExistingDecision?: boolean;
    reportId?: string | null;
  } = {},
): ExpenseTripRecord & {
  hrApproved: boolean;
  hrComment: string;
  hrId: string;
  preserveExistingDecision: boolean;
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
    amWorkload: outstationWorkloadCount(request.amWorkload),
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
    other: outstationReportOverride(request.reportOtherAmount, request.otherAmount),
    pharmacyVisits: snapshotKindCount(request.workloadEvidenceSnapshot, "pharmacyVisits"),
    pharmacyWorkload: outstationPharmacyWorkload(request.pharmacyWorkload),
    pmWorkload: outstationWorkloadCount(request.pmWorkload),
    preserveExistingDecision: options.preserveExistingDecision ?? true,
    reportId: options.reportId ?? undefined,
    requestType: "Outstation",
    row: 1,
    // What outstation_expenses STORES and payroll reads (automated-payroll/recommend.ts), so it takes
    // the record's full name. `employeeName` is the display name on a request read through a live
    // overlay (owner, 2026-11-03), and that must never be stamped onto the ledger.
    specialist: request.employeeRecordName || request.employeeName,
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
  // Workload is NOT resolved like the money columns above — see outstationWorkloadCount for why
  // report_am_workload/report_pm_workload are never read on either side.
  const amWorkload = outstationWorkloadCount(row.am_workload);
  const pharmacyWorkload = outstationPharmacyWorkload(row.pharmacy_workload);
  const pmWorkload = outstationWorkloadCount(row.pm_workload);
  // The HR Status column is the request's own decision — Approved, Rejected or Pending — the same
  // value claims-read.ts gives a claim and the push mapper stamps on an approved trip. Until
  // 2026-09-19 it fell back to the EMPLOYEE'S NAME (audit F-26), because the report_hr_status
  // column it preferred was never filled; that column is dropped now, and a name is not a status.
  const hrStatus = status;
  const hrNotes = toText(row.eligibility_reason);
  // The LABEL, and only the label. `report_trip_type` is the report-facing stay/duration wording
  // ("Return same day", "Overnight / 3 days") that `reportTripTypeLabel` in service.ts derives
  // from the trip's own dates — the approvals report renders it under "Travel Stay Type", which
  // is why this preference stays exactly as it was.
  const tripType = toText(row.report_trip_type) || toText(row.expense_type) || "traveling";

  // ...but the MEETING CLASSIFICATION must never be read off that label. `expense_type` is the
  // column that says what kind of expense this is, and it is the one the push mapper reads
  // (`request.expenseType === "meeting"`). Deriving the classification from `tripType` instead
  // meant the duration string always won: all 93 live rows carry one, so the display side NEVER
  // once resolved to "meeting" while the push side did — and on request 72 (Dina Hamdy Fadel
  // Mohamed Bdair, B-12, 12 August 2026) the two priced the same trip at 323.14 and 646.28.
  //
  // A label and a classification are two different things; keeping them one expression is what
  // let a display change silently move money. Same divergence class as PR #2951 (total), #2957
  // (components), #2960 (zeroed override) and #2963 (workload).
  const isMeetingTrip = toText(row.expense_type).toLowerCase() === "meeting";

  const { meetingAmount, total } = outstationPayableTotal({
    allowanceAmount: allowance,
    expectedTotalAmount: expectedTotal,
    isMeetingTrip,
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
    other,
    payoutMonth: payout.month,
    payoutYear: payout.year,
    pharmacyWorkload,
    pmWorkload,
    reportId: null,
    // The version the reviewer is looking at. Posted back with a decision so a claim that moved
    // after the queue loaded (an extra ticket, a journey stop) is refused, not approved unseen.
    requestRevision: outstationClaimRevision(row.updated_at),
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
