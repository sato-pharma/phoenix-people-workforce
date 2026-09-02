import assert from "node:assert/strict";

import {
  mapOutstationRequestRowToPayrollApproval,
  mapOutstationRequestToPayrollExpenseRecord,
} from "../src/lib/outstation/payroll-expense-mapping.ts";
import type { OutstationExpenseRequest } from "../src/lib/outstation/types.ts";

// A minimal but complete OutstationExpenseRequest — every field mapOutstationRequestToPayrollExpenseRecord
// might read, filled with inert defaults so a test case only has to override what it cares about.
function baseRequest(overrides: Partial<OutstationExpenseRequest>): OutstationExpenseRequest {
  return {
    allowanceAmount: 0,
    allowanceBreakdown: null,
    attachmentCount: 0,
    approvalRecommendation: "auto_approve",
    approvalReason: "",
    capturedAccuracyMeters: 0,
    capturedAt: "2026-08-05T00:00:00.000Z",
    capturedLatitude: 0,
    capturedLongitude: 0,
    carEvidenceImagePath: null,
    carEvidenceImageUrl: null,
    carEvidenceMetadata: null,
    departureCapturedAt: null,
    departureEvidenceImagePath: null,
    departureEvidenceMetadata: null,
    evidenceGateStatus: "grandfathered",
    workloadCaptureAttempts: 0,
    workloadLastAttemptAt: null,
    workloadLastAttemptError: null,
    workloadGateStatus: "grandfathered",
    claimedTotalAmount: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    distanceFromResidenceKm: 0,
    durationMinutes: null,
    expenseType: "traveling",
    eligibilityReason: "",
    eligibilityStatus: "eligible",
    employeeArea: null,
    employeeHrId: "B-122",
    employeeLine: null,
    employeeName: "Amr Mohamed Naguib Elsabey",
    employeeRole: "medical_rep",
    expectedTotalAmount: 0,
    fuelAmount: 0,
    goTicketAmount: 0,
    id: 52,
    kilometerReading: null,
    medicalTripHrId: null,
    medicalTripName: null,
    minimumRequiredDistanceKm: 0,
    notes: null,
    offlineCaptured: false,
    overnightDays: 1,
    reportAmWorkload: 0,
    reportHrNotes: null,
    reportHrStatus: null,
    reportMeetingAmount: 0,
    reportOtherAmount: 0,
    reportPmWorkload: 0,
    reportTravelCost: null,
    reportTripType: null,
    residenceAddress: null,
    residenceArea: null,
    residenceCity: null,
    residenceLatitude: null,
    residenceLongitude: null,
    routePolyline: null,
    routeError: null,
    sameDayTrip: false,
    status: "accepted_by_system",
    submittedAt: "2026-08-05T00:00:00.000Z",
    territoryValidationReason: "",
    territoryValidationStatus: "not_available",
    returnTicketAmount: 0,
    ticketAttachmentMetadata: [],
    ticketAttachmentPaths: [],
    ticketAmount: 0,
    toArea: null,
    toCity: null,
    toCountry: null,
    toLabel: null,
    transportationType: "car",
    tripEndDate: "2026-08-06T00:00:00.000Z",
    tripStartDate: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    amWorkload: 0,
    meetingAmount: 0,
    otherAmount: 0,
    pmWorkload: 0,
    workloadEvidenceSnapshot: {},
    workloadMatchedAt: null,
    workloadMatchStatus: "",
    workloadOverrideReason: null,
    workloadSource: "",
    workloadSourceImportId: null,
    ...overrides,
  };
}

export function runOutstationPayrollPayableTotalAgreementTests() {
  // Request 52 (Amr Mohamed Naguib Elsabey, B-122) — LIVE, production ozucdzovmcqvepbozvqf. Before
  // the 2026-09-03 fix, the push mapper paid 364 (the client's claim) while its own allowance
  // column, and the row mapper's own display total, both read 800. Both mappers must now agree on
  // 800 — the server's own priced total — for the exact same underlying row.
  const request52 = baseRequest({
    allowanceAmount: 800,
    claimedTotalAmount: 364,
    expectedTotalAmount: 800,
    fuelAmount: 0,
    id: 52,
    ticketAmount: 0,
  });
  const row52 = {
    allowance_amount: 800,
    claimed_total_amount: 364,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-122",
    employee_name: "Amr Mohamed Naguib Elsabey",
    expected_total_amount: 800,
    expense_type: "traveling",
    fuel_amount: 0,
    id: 52,
    status: "accepted_by_system",
    ticket_amount: 0,
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  const pushed52 = mapOutstationRequestToPayrollExpenseRecord(request52);
  const displayed52 = mapOutstationRequestRowToPayrollApproval(row52);

  assert.equal(pushed52.total, 800, "request 52 must be PUSHED to payroll at the server's expected total, not the 364 EGP claim");
  assert.equal(displayed52.total, 800, "request 52 must be DISPLAYED at the same total it is paid");
  assert.equal(pushed52.total, displayed52.total, "the pushed and displayed totals must never diverge for the same row");

  // Request 99 (Dina Fadel, B-12) — LIVE, same project. Claimed 341.90 (fuel 216.90 + same-day
  // allowance 125) against a server-priced 541.90 (fuel 216.90 + overnight allowance 325). Also
  // proves the fix holds when the claim differs from the expected total for a REASON (a same-day
  // vs overnight allowance mismatch), not just when it is a stale zero.
  const request99 = baseRequest({
    allowanceAmount: 325,
    claimedTotalAmount: 341.9,
    employeeHrId: "B-12",
    employeeName: "Dina Fadel",
    expectedTotalAmount: 541.9,
    fuelAmount: 216.9,
    id: 99,
    status: "submitted",
    ticketAmount: 0,
  });
  const row99 = {
    allowance_amount: 325,
    claimed_total_amount: 341.9,
    created_at: "2026-08-25T00:00:00.000Z",
    employee_hr_id: "B-12",
    employee_name: "Dina Fadel",
    expected_total_amount: 541.9,
    expense_type: "traveling",
    fuel_amount: 216.9,
    id: 99,
    status: "submitted",
    ticket_amount: 0,
    trip_start_date: "2026-08-24T00:00:00.000Z",
  };

  const pushed99 = mapOutstationRequestToPayrollExpenseRecord(request99);
  const displayed99 = mapOutstationRequestRowToPayrollApproval(row99);

  assert.equal(pushed99.total, 541.9, "request 99 must be PUSHED to payroll at the server's expected total, not the 341.90 EGP claim");
  assert.equal(displayed99.total, 541.9, "request 99 must be DISPLAYED at the same total it is paid");
  assert.equal(pushed99.total, displayed99.total, "the pushed and displayed totals must never diverge for the same row");

  // The reverse direction must be equally impossible: a claim ABOVE the server's price must not
  // inflate the payable total either. Nothing in the live sweep hit this case, but the mapper
  // must not special-case the sign of the divergence.
  const overclaimedRequest = baseRequest({
    allowanceAmount: 300,
    claimedTotalAmount: 5000,
    expectedTotalAmount: 300,
    id: 200,
  });
  const overclaimedRow = {
    allowance_amount: 300,
    claimed_total_amount: 5000,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-1",
    employee_name: "Test Employee",
    expected_total_amount: 300,
    expense_type: "traveling",
    id: 200,
    status: "accepted_by_system",
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };
  assert.equal(
    mapOutstationRequestToPayrollExpenseRecord(overclaimedRequest).total,
    300,
    "a claim far above the server's price must not inflate the pushed total",
  );
  assert.equal(
    mapOutstationRequestRowToPayrollApproval(overclaimedRow).total,
    300,
    "a claim far above the server's price must not inflate the displayed total",
  );
}
