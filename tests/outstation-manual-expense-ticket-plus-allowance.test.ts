import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mapOutstationRequestRowToPayrollApproval } from "../src/lib/outstation/payroll-expense-mapping.ts";

function readSource(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

export function runOutstationManualExpenseTicketPlusAllowanceTests() {
  // A train/bus trip is paid ticket + allowance. Before the fix the admin modal had no
  // ticket field at all, so the ticket price was typed into "Claimed amount" — which
  // REPLACES the calculated total — and the allowance silently vanished from payroll.
  const ticketTrip = mapOutstationRequestRowToPayrollApproval({
    allowance_amount: 300,
    claimed_total_amount: 0,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 750,
    expense_type: "traveling",
    fuel_amount: 0,
    id: 77,
    report_travel_cost: 450,
    status: "approved",
    ticket_amount: 450,
    transportation_type: "train",
    trip_end_date: "2026-05-21T00:00:00.000Z",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });

  assert.equal(ticketTrip.travelCost, 450, "a train trip's travel cost is the ticket price");
  assert.equal(ticketTrip.allowance, 300, "the allowance survives alongside the ticket");
  assert.equal(
    ticketTrip.total,
    750,
    "ticket + allowance = total; the ticket must never replace the allowance",
  );

  // ticket_amount left at 0 while report_travel_cost carries the ticket is the exact
  // shape the old create path wrote. The mapper prefers report_travel_cost, so this
  // still totals correctly — but fuel_amount + ticket_amount must agree with it,
  // because mapOutstationRequestToPayrollExpenseRecord rebuilds travel cost from those two.
  const staleTicketColumns = mapOutstationRequestRowToPayrollApproval({
    allowance_amount: 300,
    claimed_total_amount: 0,
    created_at: "2026-05-20T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 750,
    expense_type: "traveling",
    fuel_amount: 0,
    id: 78,
    status: "approved",
    ticket_amount: 0,
    transportation_type: "train",
    trip_start_date: "2026-05-20T00:00:00.000Z",
  });
  assert.equal(
    staleTicketColumns.total,
    300,
    "with ticket_amount and report_travel_cost both 0 the payout collapses to the allowance alone — the pre-fix bug",
  );

  // Wiring: the service math is correct only if travelCostAmount actually reaches it.
  // The create route silently dropped it while the PATCH route forwarded it, so a manual
  // train expense was created with a travel cost of 0 no matter what the admin typed.
  const createRoute = readSource("../app/api/admin/outstation/manager-expenses/route.ts");
  assert.match(
    createRoute,
    /travelCostAmount:\s*optionalNumber\(body\.travelCostAmount\)/,
    "the manager-expenses POST route must forward travelCostAmount to the service",
  );

  const modal = readSource("../src/components/outstation/admin-manager-expense-modal.tsx");

  // Scope this to the SUBMIT payload specifically. The live-preview fetch also sends
  // travelCostAmount, so a file-wide match stays green even when the saved request has
  // dropped it — which is the half-fix that still underpays the employee.
  const submitPayload = modal.match(
    /const input: ManagerExpenseAdminInput = \{[\s\S]*?\n {4}\};/,
  )?.[0];
  assert.ok(submitPayload, "the admin modal must build a ManagerExpenseAdminInput submit payload");
  assert.match(
    submitPayload,
    /travelCostAmount:\s*travelCostForSubmit/,
    "the admin modal's submit payload must carry travelCostAmount, not just the preview call",
  );
  assert.match(
    modal,
    /setTicketCost/,
    "the admin modal must expose a ticket cost input for non-car transport",
  );
  assert.match(
    modal,
    /const isTicketBased = transportationType !== "car"/,
    "every non-car transport mode is paid from the ticket, not the fuel formula",
  );
}
