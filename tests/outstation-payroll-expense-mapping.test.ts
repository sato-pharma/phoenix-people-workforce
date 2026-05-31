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
  assert.equal(mapped.total, 1500);
  assert.equal(mapped.travelCost, 1200);
  assert.equal(mapped.payoutMonth, 6);
  assert.equal(mapped.payoutYear, 2026);
}
