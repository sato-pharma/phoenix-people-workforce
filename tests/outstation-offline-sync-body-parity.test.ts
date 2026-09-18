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

/** Six fields no employee-submitted claim may carry, on EITHER submit path. Two of them
 * (travelCostAmount, tripType) reach a report_* column that payroll-expense-mapping.ts prefers
 * over the resolved value — see the impact half below, which is what makes their absence from the
 * routes load-bearing rather than cosmetic.
 *
 * hrStatus and hrNotes stay on this list although their columns, report_hr_status and
 * report_hr_notes, were dropped on 2026-09-19 (owner) and nothing reads or writes them now. A
 * route reading either again would be someone rebuilding an employee-set HR verdict.
 *
 * amWorkload and pmWorkload stay on this list even though neither mapper reads
 * report_am_workload/report_pm_workload any more (2026-09-03 — they are `NOT NULL DEFAULT 0`, so
 * the preference could never fall through, and all 80 live rows carried 0 there while the resolved
 * counts were real). They still WRITE those columns on the create paths, and the ban is part of
 * what keeps them inert: an employee must not be able to seed a column a future reader might trust.
 *
 * Both routes assert the same permission, the submitter's own outstation:create, so a field one of
 * them refuses is a field neither may take. */
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

  // A planted `report_trip_type` is no longer a money lever, and that is exactly what these three
  // assertions now pin — they are not obsolete, they changed sides.
  //
  // Until 2026-09-08 the display mapper read this column as the trip type, so "meeting" against a
  // zero meeting_amount re-filed the WHOLE expected total as the meeting amount and it entered
  // componentTotal a second time: 700 travel + 1000 "meeting" + 300 allowance = 2000, against an
  // expected total of 1000. The same trip, merely re-typed, was worth double.
  //
  // Both halves are closed. The column is the report-facing stay/duration label ("Return same
  // day", "Overnight / 3 days") and still renders as one, but the meeting CLASSIFICATION no
  // longer reads it — that comes from `expense_type` now, the same column the push mapper reads;
  // and the meeting fallback claims only the RESIDUAL the trip's other components leave
  // unexplained, so neither route can double a total any more. The field stays
  // banned at the route either way — `report_travel_cost` above is still a live lever, and an
  // employee has no business writing an HR-facing report column — but the ban is no longer the
  // only thing standing between a planted string and a doubled payout.
  const meetingTrip = mapOutstationRequestRowToPayrollApproval({
    ...honestRow(),
    report_trip_type: "meeting",
  });
  assert.equal(
    meetingTrip.meetingAmount,
    0,
    "a planted report_trip_type must not re-file the expected total as a meeting cost",
  );
  assert.equal(
    meetingTrip.total,
    1000,
    "the planted trip type must leave the payable total at the server's own 1000, not 2000",
  );
  assert.equal(
    meetingTrip.total,
    honest.total,
    "the same claim, re-typed, must be worth exactly the same — nothing else about the trip changed",
  );

  // Neither the HR column nor the AM/PM visit counts is a lever any more. Both mappers read the
  // resolved am_workload/pm_workload, so a report_*_workload — even a wildly wrong one — changes
  // nothing an approver sees; and report_hr_status/report_hr_notes were dropped on 2026-09-19
  // (owner), so a row still carrying them renders the same fallback as the honest one. That is why
  // this block asserts the resolved 4/3 and the honest HR column, not the planted values.
  const overriddenReport = mapOutstationRequestRowToPayrollApproval({
    ...honestRow(),
    report_am_workload: 99,
    report_hr_notes: "Cleared.",
    report_hr_status: "Approved",
    report_pm_workload: 98,
  });
  assert.equal(
    overriddenReport.amWorkload,
    4,
    "a planted report_am_workload must NOT beat the resolved AM count",
  );
  assert.equal(
    overriddenReport.pmWorkload,
    3,
    "a planted report_pm_workload must NOT beat the resolved PM count",
  );
  assert.equal(overriddenReport.hr, honest.hr, "a planted report_hr_status must NOT reach the HR column");
  assert.equal(
    overriddenReport.hrNotes,
    honest.hrNotes,
    "a planted report_hr_notes must NOT reach the HR note",
  );

  // The calculate preview took both fields too, until 2026-09-19. It is the third body an
  // employee's own outstation:create reaches, so it is held to the same two bans.
  const calculateFields = bodyFields(readFileSync("app/api/outstation/calculate/route.ts", "utf8"));
  assert.ok(
    calculateFields.has("tripStartDate"),
    "the calculate route must still read its body — this check is reading the wrong file",
  );
  for (const field of ["hrStatus", "hrNotes"]) {
    assert.equal(
      calculateFields.has(field),
      false,
      `the calculate route must not read body.${field} — the request-level HR note and status were removed`,
    );
  }

  // ── The gate: NEITHER submit path may be handed any of them ────────────────────────────────
  // Both routes assert the same permission — the submitting employee's own outstation:create —
  // and the offline path is additionally the one deliberately exempted from carrying a ticket
  // attachment up front. Least evidence must not mean most control, and the online path is not
  // a licence either: it is the same claim by the same person into the same columns.

  const routes = [
    { fields: bodyFields(readFileSync("app/api/outstation/sync-offline/route.ts", "utf8")), name: "sync-offline" },
    { fields: bodyFields(readFileSync("app/api/outstation/submit/route.ts", "utf8")), name: "submit" },
  ];

  // Vacuity guard. If a route is renamed, emptied, or stops reading its body the way this check
  // assumes, the set goes small and every assertion below passes for the wrong reason.
  for (const route of routes) {
    assert.ok(
      route.fields.size >= 15,
      `expected the ${route.name} route to still read its request body; found ${route.fields.size} field(s)`,
    );
    for (const structural of ["capturedLatitude", "claimedTotalAmount", "tripStartDate"]) {
      assert.ok(
        route.fields.has(structural),
        `the ${route.name} route must still read body.${structural} — this check is reading the wrong file`,
      );
    }
  }

  for (const route of routes) {
    for (const field of SELF_SET_REPORT_FIELDS) {
      assert.equal(
        route.fields.has(field),
        false,
        `the ${route.name} route must not read body.${field} — an employee does not set this on his own claim, whichever path he submits it through, because it reaches a report_* column the payroll approval mapper prefers over the value the server resolved. If a path genuinely needs it, the owner approves it and it gets an explicit gate, never a default.`,
      );
    }
  }

  // The general rule, so a NEW extra field is caught without anyone remembering to list it.
  const [offline, submit] = routes;
  const widerThanSubmit = [...offline.fields].filter((field) => !submit.fields.has(field)).sort();
  assert.deepEqual(
    widerThanSubmit,
    [],
    `the offline sync route's accepted body must stay a SUBSET of the online submit route's; these are read by sync-offline alone: ${widerThanSubmit.join(", ")}`,
  );

  // The sibling rule: the offline flag itself is set server-side on both routes, never trusted
  // from the caller. It is what exempts a train/bus claim from its ticket.
  const offlineRoute = readFileSync("app/api/outstation/sync-offline/route.ts", "utf8");
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
