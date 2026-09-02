import assert from "node:assert/strict";

import {
  mapOutstationRequestRowToPayrollApproval,
  outstationPayrollTripId,
} from "../src/lib/outstation/payroll-expense-mapping.ts";

export function runOutstationPayrollExpenseMappingTests() {
  assert.equal(outstationPayrollTripId(42), "OUTSTATION-42");

  const mapped = mapOutstationRequestRowToPayrollApproval({
    allowance_amount: 300,
    claimed_total_amount: 1500,
    created_at: "2026-05-20T10:00:00.000Z",
    distance_from_residence_km: 80,
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 1400,
    expense_type: "traveling",
    fuel_amount: 700,
    id: 42,
    notes: "Manual correction",
    report_am_workload: 1,
    report_hr_notes: "Reviewed by HR",
    report_hr_status: "Approved",
    report_meeting_amount: 150,
    report_other_amount: 25,
    report_pm_workload: 7,
    report_travel_cost: 900,
    report_trip_type: "Return same day",
    status: "approved",
    ticket_amount: 500,
    to_city: "Alexandria",
    transportation_type: "car",
    trip_end_date: "2026-05-21T00:00:00.000Z",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });

  assert.equal(mapped.tripId, "OUTSTATION-42");
  assert.equal(mapped.requestType, "Outstation");
  assert.equal(mapped.hrApproved, true);
  assert.equal(mapped.sourceFileName, "Outstation Requests");
  assert.equal(mapped.total, 1375);
  assert.equal(mapped.travelCost, 900);
  assert.equal(mapped.meetingAmount, 150);
  assert.equal(mapped.other, 25);
  assert.equal(mapped.hr, "Approved");
  assert.equal(mapped.hrNotes, "Reviewed by HR");
  assert.equal(mapped.amWorkload, 1);
  assert.equal(mapped.pmWorkload, 7);
  assert.equal(mapped.tripType, "Return same day");
  assert.equal(mapped.payoutMonth, 6);
  assert.equal(mapped.payoutYear, 2026);

  // A traveling request with none of the new fields set must default them to 0
  // (meeting_amount only falls back to claimed/expected for meeting-type requests).
  const mappedSimple = mapOutstationRequestRowToPayrollApproval({
    claimed_total_amount: 500,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expense_type: "traveling",
    id: 99,
    status: "approved",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(mappedSimple.meetingAmount, 0, "traveling request with no meeting_amount maps to 0");
  assert.equal(mappedSimple.other, 0);
  assert.equal(mappedSimple.amWorkload, 0);
  assert.equal(mappedSimple.pmWorkload, 0);

  // New expense fields (meeting_amount, other_amount, am_workload, pm_workload) must flow
  // through to the payroll approval output unchanged.
  const mappedWithExtras = mapOutstationRequestRowToPayrollApproval({
    am_workload: 3,
    claimed_total_amount: 1500,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 1400,
    expense_type: "traveling",
    id: 43,
    meeting_amount: 250,
    other_amount: 120,
    pm_workload: 4,
    status: "approved",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(mappedWithExtras.meetingAmount, 250, "explicit meeting_amount must map through");
  assert.equal(mappedWithExtras.other, 120, "other_amount must map through");
  assert.equal(mappedWithExtras.amWorkload, 3, "am_workload must map through");
  assert.equal(mappedWithExtras.pmWorkload, 4, "pm_workload must map through");

  // A meeting-type request with no explicit meeting_amount falls back to the server's own
  // expected total — NEVER the claim, even when the claim is higher (owner ruling 2026-09-03,
  // requests 52 and 99: a client-posted figure must never silently become the payable amount).
  const mappedMeeting = mapOutstationRequestRowToPayrollApproval({
    claimed_total_amount: 900,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 800,
    expense_type: "meeting",
    id: 44,
    status: "approved",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(mappedMeeting.meetingAmount, 800, "meeting-type request defaults meeting_amount to the EXPECTED total, not the claim");
  assert.equal(mappedMeeting.total, 800, "the claim (900) must never become the payable total");
  assert.equal(mappedMeeting.other, 0);
}
