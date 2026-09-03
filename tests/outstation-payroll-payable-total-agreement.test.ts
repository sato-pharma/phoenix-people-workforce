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
    meetingInvoiceMetadata: null,
    meetingInvoicePath: null,
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

  // ---------------------------------------------------------------------------------------------
  // WORKLOAD. The same two-formulas-for-one-figure class, on the AM/PM visit counts. These are NOT
  // money — nothing in outstationPayableTotal reads them — but they land on the payroll expense
  // record and are shown beside it, and they are the evidence that justifies the trip.
  //
  // The workload columns are not shaped like the money overrides: report_am_workload and
  // report_pm_workload are `double precision NOT NULL DEFAULT 0`, so "no override recorded" is
  // indistinguishable from "override of zero" and the DISPLAY mapper's `!= null` preference was
  // unconditional. Measured live on production ozucdzovmcqvepbozvqf, 2026-09-03:
  //   total_rows 80 | am_divergent 39 | pm_divergent 50
  // with report_am_workload = report_pm_workload = 0 on all 80 rows (0 NULL, 0 positive). So the
  // display mapper showed AM 0 / PM 0 on every outstation trip in the payroll approval table and
  // the employee portal, while the push mapper sent payroll the real counts. Both now read the
  // resolved am_workload/pm_workload through outstationWorkloadCount.

  // Request 52 (Amr Mohamed Naguib Elsabey, B-122) — LIVE. AM 1 / PM 18 resolved, 0 / 0 reported.
  const workload52 = baseRequest({
    allowanceAmount: 800,
    amWorkload: 1,
    expectedTotalAmount: 800,
    id: 52,
    pmWorkload: 18,
    reportAmWorkload: 0,
    reportPmWorkload: 0,
  });
  const workloadRow52 = {
    allowance_amount: 800,
    am_workload: 1,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-122",
    employee_name: "Amr Mohamed Naguib Elsabey",
    expected_total_amount: 800,
    expense_type: "traveling",
    id: 52,
    pm_workload: 18,
    report_am_workload: 0,
    report_pm_workload: 0,
    status: "accepted_by_system",
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  const pushedWorkload52 = mapOutstationRequestToPayrollExpenseRecord(workload52);
  const displayedWorkload52 = mapOutstationRequestRowToPayrollApproval(workloadRow52);

  assert.equal(
    displayedWorkload52.amWorkload,
    1,
    "request 52 must DISPLAY its resolved AM workload of 1, not the always-zero report_am_workload",
  );
  assert.equal(
    displayedWorkload52.pmWorkload,
    18,
    "request 52 must DISPLAY its resolved PM workload of 18, not the always-zero report_pm_workload",
  );
  assert.equal(
    pushedWorkload52.amWorkload,
    displayedWorkload52.amWorkload,
    "the pushed and displayed AM workload must never diverge for the same row",
  );
  assert.equal(
    pushedWorkload52.pmWorkload,
    displayedWorkload52.pmWorkload,
    "the pushed and displayed PM workload must never diverge for the same row",
  );

  // Request 54 (Nahed Tarek Hassan Omar Hattab, A-10) — LIVE, the largest divergence in the sweep:
  // AM 14 / PM 17 resolved, both reported as 0. Proves the fix is not specific to a small count.
  const workload54 = baseRequest({
    allowanceAmount: 300,
    amWorkload: 14,
    employeeHrId: "A-10",
    employeeName: "Nahed Tarek Hassan Omar Hattab",
    expectedTotalAmount: 300,
    id: 54,
    pmWorkload: 17,
    status: "submitted",
  });
  const workloadRow54 = {
    allowance_amount: 300,
    am_workload: 14,
    created_at: "2026-07-25T00:00:00.000Z",
    employee_hr_id: "A-10",
    employee_name: "Nahed Tarek Hassan Omar Hattab",
    expected_total_amount: 300,
    expense_type: "traveling",
    id: 54,
    pm_workload: 17,
    report_am_workload: 0,
    report_pm_workload: 0,
    status: "submitted",
    trip_start_date: "2026-07-25T00:00:00.000Z",
  };

  const pushedWorkload54 = mapOutstationRequestToPayrollExpenseRecord(workload54);
  const displayedWorkload54 = mapOutstationRequestRowToPayrollApproval(workloadRow54);

  assert.equal(
    displayedWorkload54.amWorkload,
    14,
    "request 54 must DISPLAY its resolved AM workload of 14, not 0",
  );
  assert.equal(
    displayedWorkload54.pmWorkload,
    17,
    "request 54 must DISPLAY its resolved PM workload of 17, not 0",
  );
  assert.equal(
    pushedWorkload54.amWorkload,
    displayedWorkload54.amWorkload,
    "the pushed and displayed AM workload must agree on request 54",
  );
  assert.equal(
    pushedWorkload54.pmWorkload,
    displayedWorkload54.pmWorkload,
    "the pushed and displayed PM workload must agree on request 54",
  );

  // A report_*_workload that is POSITIVE must still lose. Nothing writes one today, but the column
  // is writable and a stray value must not be able to flip either mapper — least of all only one of
  // them, which is exactly how this divergence started.
  const strayOverrideRequest = baseRequest({
    allowanceAmount: 300,
    amWorkload: 6,
    expectedTotalAmount: 300,
    id: 304,
    pmWorkload: 9,
    reportAmWorkload: 99,
    reportPmWorkload: 99,
  });
  const strayOverrideRow = {
    allowance_amount: 300,
    am_workload: 6,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-1",
    employee_name: "Test Employee",
    expected_total_amount: 300,
    expense_type: "traveling",
    id: 304,
    pm_workload: 9,
    report_am_workload: 99,
    report_pm_workload: 99,
    status: "accepted_by_system",
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  const pushedStray = mapOutstationRequestToPayrollExpenseRecord(strayOverrideRequest);
  const displayedStray = mapOutstationRequestRowToPayrollApproval(strayOverrideRow);

  assert.equal(
    displayedStray.amWorkload,
    6,
    "a stray positive report_am_workload must not beat the resolved am_workload on the DISPLAYED record",
  );
  assert.equal(
    displayedStray.pmWorkload,
    9,
    "a stray positive report_pm_workload must not beat the resolved pm_workload on the DISPLAYED record",
  );
  assert.equal(
    pushedStray.amWorkload,
    displayedStray.amWorkload,
    "a stray positive workload override must not make the two mappers disagree on AM",
  );
  assert.equal(
    pushedStray.pmWorkload,
    displayedStray.pmWorkload,
    "a stray positive workload override must not make the two mappers disagree on PM",
  );

  // A genuinely zero-workload trip must still read 0 on both sides — the fix must not turn every
  // absent count into a fallback that invents activity.
  const zeroWorkloadRequest = baseRequest({
    allowanceAmount: 300,
    amWorkload: 0,
    expectedTotalAmount: 300,
    id: 305,
    pmWorkload: 0,
  });
  const zeroWorkloadRow = {
    allowance_amount: 300,
    am_workload: 0,
    created_at: "2026-08-05T00:00:00.000Z",
    employee_hr_id: "B-1",
    employee_name: "Test Employee",
    expected_total_amount: 300,
    expense_type: "traveling",
    id: 305,
    pm_workload: 0,
    report_am_workload: 0,
    report_pm_workload: 0,
    status: "accepted_by_system",
    trip_start_date: "2026-08-05T00:00:00.000Z",
  };

  assert.equal(
    mapOutstationRequestRowToPayrollApproval(zeroWorkloadRow).amWorkload,
    0,
    "a genuinely zero AM workload must stay 0 on the DISPLAYED record",
  );
  assert.equal(
    mapOutstationRequestToPayrollExpenseRecord(zeroWorkloadRequest).pmWorkload,
    0,
    "a genuinely zero PM workload must stay 0 on the PUSHED record",
  );

  // The workload fix must not have moved any money: request 52 is still payable at 800.
  assert.equal(
    pushedWorkload52.total,
    800,
    "resolving workload must not change the payable total pushed for request 52",
  );
  assert.equal(
    pushedWorkload52.total,
    displayedWorkload52.total,
    "resolving workload must leave the pushed and displayed totals in agreement",
  );
}

function roundTo2(value: number) {
  return Math.round(value * 100) / 100;
}
