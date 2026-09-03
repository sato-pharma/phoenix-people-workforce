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
    reportMeetingAmount: null,
    reportOtherAmount: null,
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

  // ---------------------------------------------------------------------------------------------
  // The COMPONENTS must add up to the total the same mapper just wrote.
  //
  // The push mapper used to sum the `report_other_amount` OVERRIDE into the total while writing the
  // raw `other_amount` column into the record's own `other` field. Nothing errors: the row files a
  // correct total beside an "Other" component that contradicts it, and `expense-metrics.ts` sums
  // those component columns into the dashboard's "Other" card, so the category silently
  // under-reports while the payout stays right. Latent on 2026-09-03 (all 80 live rows had the raw
  // and override columns equal), which is exactly why it needs pinning — the manual-admin create
  // and the extra-ticket append write the two columns independently.
  const overriddenOther = baseRequest({
    allowanceAmount: 200,
    expectedTotalAmount: 420,
    fuelAmount: 100,
    id: 301,
    otherAmount: 0,
    reportOtherAmount: 120,
    ticketAmount: 0,
  });
  const overriddenOtherRow = {
    allowance_amount: 200,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-1",
    employee_name: "Test Employee",
    expected_total_amount: 420,
    expense_type: "traveling",
    fuel_amount: 100,
    id: 301,
    other_amount: 0,
    report_other_amount: 120,
    status: "accepted_by_system",
    ticket_amount: 0,
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  const pushedOverride = mapOutstationRequestToPayrollExpenseRecord(overriddenOther);
  const displayedOverride = mapOutstationRequestRowToPayrollApproval(overriddenOtherRow);

  assert.equal(
    pushedOverride.other,
    120,
    "the pushed record must file the OVERRIDE other amount it summed, not the raw other_amount column",
  );
  assert.equal(
    pushedOverride.other,
    displayedOverride.other,
    "the pushed and displayed `other` components must never diverge for the same row",
  );
  assert.equal(
    roundTo2(
      pushedOverride.travelCost + pushedOverride.meetingAmount + pushedOverride.allowance + pushedOverride.other,
    ),
    pushedOverride.total,
    "a pushed payroll row's components must add up to its own total",
  );
  assert.equal(pushedOverride.total, 420, "the overridden other amount must still be paid");

  // The fallback must survive the fix: with NO override recorded, the raw column is still what
  // gets both summed and filed. "No override" is `null` — since PR #2960 `mapOutstationRequestRow`
  // maps these columns with `nullableNumber` instead of collapsing NULL to 0, so a report column
  // of exactly 0 is a real override that WINS (pinned separately below) and only null falls back.
  const rawOtherOnly = baseRequest({
    allowanceAmount: 200,
    expectedTotalAmount: 375,
    fuelAmount: 100,
    id: 302,
    otherAmount: 75,
    reportOtherAmount: null,
    ticketAmount: 0,
  });
  const pushedRawOnly = mapOutstationRequestToPayrollExpenseRecord(rawOtherOnly);
  assert.equal(pushedRawOnly.other, 75, "with no override, the raw other_amount is still filed");
  assert.equal(
    roundTo2(
      pushedRawOnly.travelCost + pushedRawOnly.meetingAmount + pushedRawOnly.allowance + pushedRawOnly.other,
    ),
    pushedRawOnly.total,
    "the fallback path's components must add up to its own total too",
  );
  // ---------------------------------------------------------------------------------------------
  // An override of EXACTLY ZERO. `report_other_amount = 0` over an `other_amount` of 50 means "HR
  // reviewed this and zeroed it" — the override wins, and both mappers must say so. Before
  // 2026-09-03 the push mapper's `request.reportOtherAmount || request.otherAmount || 0` fell
  // through the falsy 0 to the raw 50 and PAID it, while the display mapper's null-check showed 0.
  // A 50 EGP silent divergence, of the same class as PR #2951 (the total) and PR #2957 (the
  // components). Latent at the time of the fix: 0 of 80 live rows were in this state.
  const zeroedOtherRequest = baseRequest({
    allowanceAmount: 300,
    expectedTotalAmount: 300,
    id: 301,
    otherAmount: 50,
    reportOtherAmount: 0,
  });
  const zeroedOtherRow = {
    allowance_amount: 300,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-1",
    employee_name: "Test Employee",
    expected_total_amount: 300,
    expense_type: "traveling",
    id: 301,
    other_amount: 50,
    report_other_amount: 0,
    status: "accepted_by_system",
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  const pushedZeroOther = mapOutstationRequestToPayrollExpenseRecord(zeroedOtherRequest);
  const displayedZeroOther = mapOutstationRequestRowToPayrollApproval(zeroedOtherRow);

  assert.equal(
    pushedZeroOther.other,
    0,
    "an `other` override of exactly 0 must beat the raw other_amount on the PUSHED record, not fall through to 50",
  );
  assert.equal(
    displayedZeroOther.other,
    0,
    "an `other` override of exactly 0 must beat the raw other_amount on the DISPLAYED record",
  );
  assert.equal(
    pushedZeroOther.total,
    300,
    "a zeroed `other` override must not add its raw 50 EGP back into the PUSHED payable total",
  );
  assert.equal(
    pushedZeroOther.total,
    displayedZeroOther.total,
    "the pushed and displayed totals must never diverge over an override of exactly zero",
  );
  assert.equal(
    pushedZeroOther.other,
    displayedZeroOther.other,
    "the pushed and displayed `other` must never diverge over an override of exactly zero",
  );

  // Same trap on the meeting column, which reaches the total by a second route (it also feeds the
  // meeting-trip fallback inside outstationPayableTotal).
  const zeroedMeetingRequest = baseRequest({
    allowanceAmount: 300,
    expectedTotalAmount: 300,
    id: 302,
    meetingAmount: 40,
    reportMeetingAmount: 0,
  });
  const zeroedMeetingRow = {
    allowance_amount: 300,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-1",
    employee_name: "Test Employee",
    expected_total_amount: 300,
    expense_type: "traveling",
    id: 302,
    meeting_amount: 40,
    report_meeting_amount: 0,
    status: "accepted_by_system",
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  const pushedZeroMeeting = mapOutstationRequestToPayrollExpenseRecord(zeroedMeetingRequest);
  const displayedZeroMeeting = mapOutstationRequestRowToPayrollApproval(zeroedMeetingRow);

  assert.equal(
    pushedZeroMeeting.meetingAmount,
    0,
    "a `meeting` override of exactly 0 must beat the raw meeting_amount on the PUSHED record",
  );
  assert.equal(
    pushedZeroMeeting.total,
    300,
    "a zeroed `meeting` override must not add its raw 40 EGP back into the PUSHED payable total",
  );
  assert.equal(
    pushedZeroMeeting.total,
    displayedZeroMeeting.total,
    "the pushed and displayed totals must never diverge over a zeroed meeting override",
  );
  assert.equal(
    pushedZeroMeeting.meetingAmount,
    displayedZeroMeeting.meetingAmount,
    "the pushed and displayed meeting amounts must never diverge over a zeroed meeting override",
  );

  // The other half of the same rule, so the fix cannot be "the override always wins": a column that
  // was never written is NULL, not 0, and the raw amount must still stand. This is what makes the
  // push mapper able to null-check at all — mapOutstationRequestRow maps these two columns with
  // `nullableNumber`, so NULL survives as null instead of collapsing to 0.
  const absentOverrideRequest = baseRequest({
    allowanceAmount: 300,
    expectedTotalAmount: 350,
    id: 303,
    otherAmount: 50,
    reportOtherAmount: null,
  });
  const absentOverrideRow = {
    allowance_amount: 300,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-1",
    employee_name: "Test Employee",
    expected_total_amount: 350,
    expense_type: "traveling",
    id: 303,
    other_amount: 50,
    report_other_amount: null,
    status: "accepted_by_system",
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  const pushedAbsent = mapOutstationRequestToPayrollExpenseRecord(absentOverrideRequest);
  const displayedAbsent = mapOutstationRequestRowToPayrollApproval(absentOverrideRow);

  assert.equal(
    pushedAbsent.other,
    50,
    "an ABSENT (null) other override must leave the raw other_amount standing on the PUSHED record",
  );
  assert.equal(
    displayedAbsent.other,
    50,
    "an ABSENT (null) other override must leave the raw other_amount standing on the DISPLAYED record",
  );
  assert.equal(
    pushedAbsent.total,
    350,
    "an absent override must still bill the raw 50 EGP in the PUSHED payable total",
  );
  assert.equal(
    pushedAbsent.total,
    displayedAbsent.total,
    "the pushed and displayed totals must agree when no override was recorded either",
  );
}

function roundTo2(value: number) {
  return Math.round(value * 100) / 100;
}
