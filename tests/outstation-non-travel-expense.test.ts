import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isNonTravelExpenseType,
  NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE,
  NON_TRAVEL_LOCATION_SOURCE,
  nonTravelAmountRefusal,
  priceNonTravelExpense,
} from "../src/lib/outstation/non-travel-expense.ts";

// Owner request (2026-09-19): on the portal Submit Expense screen a Meeting or Other expense must
// offer an upload button (pictures or PDF) and must NOT calculate distance or travel. This pins
// both halves: the pure pricing rule, and the WIRING — that the service, the two routes and the
// screen all branch on the same predicate, so no Meeting/Other claim can pick up a GPS fix,
// a fuel or ticket line, an allowance or an arrival-photo demand again.

function read(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/** The body of one top-level exported function, from its signature to the next one. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist — this test is pinned to it by name`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

export function runOutstationNonTravelExpenseTests() {
  // --- the pure rule -------------------------------------------------------------------------
  assert.equal(isNonTravelExpenseType("meeting"), true);
  assert.equal(isNonTravelExpenseType("other"), true);
  assert.equal(isNonTravelExpenseType("traveling"), false, "a Traveling expense keeps the trip flow");
  assert.equal(isNonTravelExpenseType(undefined), false);

  const priced = priceNonTravelExpense({ meetingAmount: 250.5, otherAmount: 100 });
  assert.equal(priced.totalAmount, 350.5, "the claim is the two typed amounts and nothing else");
  assert.equal(priced.allowanceAmount, 0, "no per-diem is calculated for a Meeting or Other expense");
  assert.equal(priced.fuelAmount, 0);
  assert.equal(priced.ticketAmount, 0);
  assert.equal(priced.travelCost, 0);

  const junk = priceNonTravelExpense({ meetingAmount: -5, otherAmount: "abc" });
  assert.equal(junk.totalAmount, 0, "a negative or non-numeric amount is never claimed");

  assert.equal(nonTravelAmountRefusal({ meetingAmount: 0, otherAmount: 0 }), NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE);
  assert.equal(nonTravelAmountRefusal({ meetingAmount: 0, otherAmount: 40 }), null);
  assert.notEqual(NON_TRAVEL_LOCATION_SOURCE, "browser_gps", "a residence fallback never claims a GPS fix");

  // --- the service ---------------------------------------------------------------------------
  const service = read("src/lib/outstation/service.ts");
  const calculate = functionBody(service, "calculateOutstationExpense");
  assert.ok(
    /if \(isNonTravelExpenseType\(input\.expenseType\)\) \{\s*return calculateNonTravelExpense\(access, input\);/.test(
      calculate,
    ),
    "calculateOutstationExpense must hand a Meeting/Other expense to calculateNonTravelExpense before any GPS, route, fuel or allowance work",
  );

  const submit = functionBody(service, "submitOutstationRequest");
  for (const needle of [
    "const nonTravel = isNonTravelExpenseType(calculation.expenseType);",
    "!nonTravel && !input.carEvidenceImageDataUrl",
    "evidence_gate_status: nextEvidenceGateStatus({",
    "grandfathered: nonTravel",
    "noInvoiceHoldReason",
  ]) {
    assert.ok(submit.includes(needle), `submitOutstationRequest must carry: ${needle}`);
  }

  // A Meeting or Other claim owes no departure photo, so the reminder skips it. The skip lives in the
  // function itself, not at the submit call site: the daily job and the Super Admin resend call it too,
  // and the submit-time call must stay a bare `try { await … }` (outstation-departure-photo-reminder).
  const reminder = functionBody(service, "sendOutstationDeparturePhotoReminder");
  assert.ok(
    reminder.includes("if (isNonTravelExpenseType(row.expenseType)) return false;"),
    "sendOutstationDeparturePhotoReminder must return false for a Meeting or Other expense",
  );

  // --- the routes ----------------------------------------------------------------------------
  for (const route of ["app/api/outstation/submit/route.ts", "app/api/outstation/calculate/route.ts"]) {
    assert.ok(
      read(route).includes("isNonTravelExpenseType(outstationTypes.expenseType)"),
      `${route} must not demand a captured position for a Meeting or Other expense`,
    );
  }

  // --- the screen ----------------------------------------------------------------------------
  const wizard = read("src/components/outstation/mobile-outstation-wizard.tsx");
  for (const needle of [
    "const isNonTravel = isNonTravelExpenseType(expenseType);",
    "visible={isTicketBased || isNonTravel}",
    "const arrivalPhotoOwed = !isNonTravel && !isEvidencePhotoWaived;",
    "transportationType: isNonTravel",
    "(captured || isNonTravel)",
  ]) {
    assert.ok(wizard.includes(needle), `the wizard must carry: ${needle}`);
  }
  // The screen never asks the server to price a Meeting/Other claim that has no amount yet: the
  // server refuses it, and every rep who set the dates first logged a failed calculation (System
  // Audit, 31 Oct 2026). The auto-calculate gate must carry the same refusal the server applies.
  const gateAt = wizard.indexOf("const canAutoCalculate = Boolean(");
  assert.notEqual(gateAt, -1, "the wizard still decides when to auto-calculate");
  const gate = wizard.slice(gateAt, wizard.indexOf(");", gateAt));
  assert.ok(
    gate.includes("!(isNonTravel && nonTravelAmountRefusal({ meetingAmount, otherAmount }))"),
    "a Meeting or Other claim with no amount must not be sent for pricing",
  );
  assert.equal(
    nonTravelAmountRefusal({ meetingAmount: "", otherAmount: "" }),
    NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE,
    "an empty Meeting/Other claim is exactly what the server refuses",
  );
  const card = read("src/components/outstation/ticket-upload-card.tsx");
  assert.ok(card.includes('"application/pdf,image/*"'), "the upload accepts pictures and PDFs");
}
