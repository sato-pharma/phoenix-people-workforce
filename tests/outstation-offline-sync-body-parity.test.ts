import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mapOutstationRequestRowToPayrollApproval } from "../src/lib/outstation/payroll-expense-mapping.ts";

/** Every request-body field a route trusts, however the file is laid out.
 *
 * The security question is "does this route read body.<x>", not where the read sits, so this
 * collects the accesses themselves rather than slicing a byte window — a reorder, a reformat or
 * a rename of the local variable must not turn this check green.
 *
 * The two carEvidence* reads are invisible here on purpose: both routes hand the whole body to
 * the SAME parseCarEvidence* helpers, so they cancel out of the comparison below. */
function bodyFields(source: string): Set<string> {
  return new Set(
    Array.from(source.matchAll(/\bbody\.([A-Za-z_$][\w$]*)/g), (match) => match[1]),
  );
}

/** The six fields the offline route used to take from the request body and the online submit
 * route does not. Each one reaches a report_* override column that payroll-expense-mapping.ts
 * prefers over the resolved value — see the impact half below, which is what makes their absence
 * from the route load-bearing rather than cosmetic. */
const SELF_SET_REPORT_FIELDS = [
  "travelCostAmount",
  "amWorkload",
  "pmWorkload",
  "hrStatus",
  "hrNotes",
  "tripType",
] as const;

/** A plain approved traveling claim: 700 fuel + 300 allowance, no report_* overrides at all. */
function honestRow(): Record<string, unknown> {
  return {
    allowance_amount: 300,
    am_workload: 4,
    claimed_total_amount: 1000,
    created_at: "2026-09-01T08:00:00.000Z",
    distance_from_residence_km: 100,
    employee_hr_id: "a-77",
    employee_name: "Field Employee",
    expected_total_amount: 1000,
    expense_type: "traveling",
    fuel_amount: 700,
    id: 4242,
    meeting_amount: 0,
    other_amount: 0,
    pm_workload: 3,
    status: "approved",
    ticket_amount: 0,
    to_city: "Alexandria",
    transportation_type: "car",
    trip_end_date: "2026-09-01T00:00:00.000Z",
    trip_start_date: "2026-09-01T00:00:00.000Z",
  };
}

export function runOutstationOfflineSyncBodyParityTests() {
  // ── Impact: the report_* columns really do decide the money and the evidence ───────────────
  // Without this half the route check below is an unexplained string ban. With it, deleting the
  // preference in payroll-expense-mapping.ts also turns this test red, so the two stay in step.

  const honest = mapOutstationRequestRowToPayrollApproval(honestRow());
  assert.equal(honest.travelCost, 700, "fuel + ticket is the honest travel cost");
  assert.equal(honest.total, 1000, "700 travel + 300 allowance");
  assert.equal(honest.meetingAmount, 0, "a traveling trip files no meeting amount");
  assert.equal(honest.amWorkload, 4, "the resolved AM visit count");
  assert.equal(honest.pmWorkload, 3, "the resolved PM visit count");
  assert.equal(honest.hr, "Field Employee", "no HR override, so the row falls back");

  // report_travel_cost REPLACES fuel + ticket outright.
  const inflatedTravel = mapOutstationRequestRowToPayrollApproval({
    ...honestRow(),
    report_travel_cost: 9000,
  });
  assert.equal(
    inflatedTravel.travelCost,
    9000,
    "report_travel_cost overrides the fuel formula — so a caller who can set it sets the payable travel figure",
  );
  assert.equal(inflatedTravel.total, 9300, "and it carries straight into the payable total");

  // A trip_type of "meeting" against a zero meeting_amount re-files the WHOLE expected total as
  // the meeting amount, which then also enters componentTotal — the approver's total balloons
  // past the expected total the server itself calculated.
  const meetingTrip = mapOutstationRequestRowToPayrollApproval({
    ...honestRow(),
    report_trip_type: "meeting",
  });
  assert.equal(
    meetingTrip.meetingAmount,
    1000,
    "a zero meeting amount on a meeting-typed trip falls back to the whole expected total",
  );
  assert.equal(
    meetingTrip.total,
    2000,
    "which double-counts: 700 travel + 1000 'meeting' + 300 allowance, against an expected total of 1000",
  );
  assert.ok(
    meetingTrip.total > honest.total,
    "the same claim, re-typed, is worth more — nothing else about the trip changed",
  );

  // The AM/PM visit counts and the HR column an approver reads.
  const overriddenReport = mapOutstationRequestRowToPayrollApproval({
    ...honestRow(),
    report_am_workload: 99,
    report_hr_notes: "Cleared.",
    report_hr_status: "Approved",
    report_pm_workload: 98,
  });
  assert.equal(overriddenReport.amWorkload, 99, "report_am_workload beats the resolved AM count");
  assert.equal(overriddenReport.pmWorkload, 98, "report_pm_workload beats the resolved PM count");
  assert.equal(overriddenReport.hr, "Approved", "report_hr_status is rendered as the row's HR column");
  assert.equal(overriddenReport.hrNotes, "Cleared.", "report_hr_notes is rendered as the row's HR note");

  // ── The gate: the offline route may not be handed any of them ──────────────────────────────
  // Both routes assert the same permission — the submitting employee's own outstation:create —
  // and the offline path is the one deliberately exempted from carrying a ticket attachment up
  // front. Least evidence must not mean most control.

  const offlineRoute = readFileSync("app/api/outstation/sync-offline/route.ts", "utf8");
  const submitRoute = readFileSync("app/api/outstation/submit/route.ts", "utf8");
  const offlineFields = bodyFields(offlineRoute);
  const submitFields = bodyFields(submitRoute);

  // Vacuity guard. If the route is renamed, emptied, or stops reading its body the way this
  // check assumes, the set goes small and every assertion below passes for the wrong reason.
  assert.ok(
    offlineFields.size >= 15,
    `expected the offline route to still read its request body; found ${offlineFields.size} field(s)`,
  );
  for (const structural of ["capturedLatitude", "claimedTotalAmount", "tripStartDate"]) {
    assert.ok(
      offlineFields.has(structural),
      `the offline route must still read body.${structural} — this check is reading the wrong file`,
    );
  }

  for (const field of SELF_SET_REPORT_FIELDS) {
    assert.equal(
      offlineFields.has(field),
      false,
      `the offline sync route must not read body.${field} — the online submit route does not, and an employee replaying a claim as "offline" must not gain control the online path denies him. If offline replay genuinely needs it, the owner approves it and it gets an explicit gate, never a default.`,
    );
  }

  // The general rule, so a NEW extra field is caught without anyone remembering to list it.
  const widerThanSubmit = [...offlineFields].filter((field) => !submitFields.has(field)).sort();
  assert.deepEqual(
    widerThanSubmit,
    [],
    `the offline sync route's accepted body must stay a SUBSET of the online submit route's; these are read by sync-offline alone: ${widerThanSubmit.join(", ")}`,
  );

  // The sibling rule: the offline flag itself is set server-side on both routes, never trusted
  // from the caller. It is what exempts a train/bus claim from its ticket.
  assert.doesNotMatch(
    offlineRoute,
    /offlineCaptured:\s*Boolean\(body\./,
    "the offline sync route must not trust a client-supplied offlineCaptured flag either",
  );
  assert.match(
    offlineRoute,
    /offlineCaptured:\s*true/,
    "the offline sync route pins offlineCaptured server-side",
  );
}
