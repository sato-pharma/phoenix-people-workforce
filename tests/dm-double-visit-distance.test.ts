/**
 * A District Manager's trip is priced from his home to the FIRST double visit he made on it (owner,
 * 2026-11-23: "the expense is calculated from his home location to the first location of this double
 * visit"), and Expense Approvals shows both distances. Pinned:
 *
 *   1. The pick: double or chain visits where he is the FIRST manager, on a trip day, with a position;
 *      the earliest by the time it was saved, the id breaking a tie. A single visit, a visit as the
 *      second manager, a day outside the trip and a visit with no position (or 0,0) never count.
 *   2. A car trip: fuel moves to km × 2 × the role's rate; the claim moves by exactly the travel delta;
 *      the distance columns follow the visit; the capture distance is kept beside it.
 *   3. No double visit: priced on the capture, nothing moves, and the desk sends it to Your call.
 *   4. Held: added stops and typed amounts keep the money as captured; a train ticket only records.
 *   5. A no-ticket trip's fare is the fare to the station nearest the VISIT.
 *   6. Never over a hand edit (`editedSincePriced`); the same visit again is "unchanged"; a later run keeps
 *      the first capture distance; a visit gone puts a car claim back on the capture.
 *   7. The desk's one sentence: pass, under the minimum fails (flagged, never refused), no double visit and
 *      unmeasured are "could not check" — never Ready. Anyone but a District Manager gets no distance check.
 *   8. The wiring: priced at submit (never failing the submission), every morning in the departure-photo
 *      job (logged, never swallowed), waiting claims only, never one on payroll, each write pinned to the
 *      version it read and audited; the desk reads the column.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { judgeClaim, runClaimChecks, type ClaimCheckFacts } from "@/lib/outstation/approvals/checks";
import { DESK_CLAIM_COLUMNS, deskDistanceOfRow } from "@/lib/outstation/approvals/claim-row";
import {
  distanceBasisVerdict,
  editedSincePriced,
  isDistrictManagerRole,
  isTripExpense,
  pickFirstDoubleVisit,
  planDistanceReprice,
  readDistanceBasis,
  WAITING_STATUSES,
  type DistanceBasis,
  type DistanceClaim,
  type DoubleVisitRow,
  type FirstDoubleVisit,
} from "@/lib/outstation/dm-double-visit-distance";
import { tripKmText } from "@/lib/outstation/trip-km";
import { resolveNoTicketFare } from "@/lib/outstation/train-fare";
import { OUTSTATION_UNDECIDED_STATUSES } from "@/lib/outstation/undecided-claim";

const RATE = 1.8;
const NOW = "2026-11-23T05:02:00.000Z";
const HOME = { lat: 30.0444, lon: 31.2357 };

const visitRow = (over: Partial<DoubleVisitRow> = {}): DoubleVisitRow => ({
  capturedAt: "2026-11-18T08:30:00.000Z",
  id: "v-1",
  kind: "double",
  lat: 30.79,
  lon: 31.0,
  managerHrId: "DM-1",
  repHrId: "REP-1",
  visitDate: "2026-11-18",
  ...over,
});

const visit = (over: Partial<FirstDoubleVisit> = {}): FirstDoubleVisit => ({
  capturedAt: "2026-11-18T08:30:00.000Z",
  id: "v-1",
  kind: "double",
  lat: 30.79,
  lon: 31.0,
  repHrId: "REP-1",
  visitDate: "2026-11-18",
  ...over,
});

/** A one-day car trip he captured 61 km from home: fuel 61 × 2 × 1.8 = 219.60, allowance 125. */
const claim = (over: Partial<DistanceClaim> = {}): DistanceClaim => ({
  claimedTotal: 344.6,
  distanceKm: 61,
  existing: null,
  expectedTotal: 344.6,
  fuelAmount: 219.6,
  hasStops: false,
  home: HOME,
  minimumKm: 40,
  noTicketFare: null,
  ticketAmount: 0,
  transport: "car",
  travelCost: 219.6,
  ...over,
});

const plan = (input: { claim?: DistanceClaim; visit?: FirstDoubleVisit | null; visitKm?: number | null }) =>
  planDistanceReprice({
    claim: input.claim ?? claim(),
    fuelRatePerKm: RATE,
    now: NOW,
    repName: "Esraa Fotooh",
    visit: input.visit === undefined ? visit() : input.visit,
    visitKm: input.visitKm === undefined ? 46 : input.visitKm,
  });

function written(result: ReturnType<typeof plan>) {
  assert.equal(result.action, "write");
  if (result.action !== "write") throw new Error("unreachable");
  return result;
}

/** The stored claim after a write, as the next run reads it. */
function afterWrite(before: DistanceClaim, result: ReturnType<typeof written>): DistanceClaim {
  const w = result.write;
  return {
    ...before,
    claimedTotal: w.claimed_total_amount,
    distanceKm: w.distance_from_residence_km ?? before.distanceKm,
    existing: readDistanceBasis(JSON.parse(JSON.stringify(w.distance_basis))),
    expectedTotal: w.expected_total_amount,
    fuelAmount: w.fuel_amount ?? before.fuelAmount,
    ticketAmount: w.ticket_amount ?? before.ticketAmount,
    travelCost: w.report_travel_cost,
  };
}

/** The desk's facts for a District Manager's clean one-day car trip on 18 Nov, read on 23 Nov. */
const deskFacts = (over: Partial<ClaimCheckFacts> = {}): ClaimCheckFacts => ({
  arrival: { capturedOn: "2026-11-18", hasPosition: true, onFile: true, uploaded: false },
  attachments: 0,
  departure: { capturedOn: "2026-11-18", flags: [], hasPosition: true, kmFromArrival: 1.2, minutesAfterArrival: 240, onFile: true },
  duplicateTickets: [],
  duplicateTrips: [],
  eligibilityReason: null,
  eligibilityStatus: "eligible",
  evidenceGateStatus: "complete",
  expenseType: "traveling",
  fieldWork: { days: [{ atDestination: true, beforePhoenix: false, date: "2026-11-18", meetings: 0, positioned: true, visits: 4 }], homeDays: [], km: null },
  hasNoTicketFare: false,
  role: "District Manager",
  today: "2026-11-23",
  transportation: "car",
  tripDates: ["2026-11-18"],
  ...over,
});

const read = (path: string) => fs.readFileSync(path, "utf8");

export function runDmDoubleVisitDistanceTests() {
  // ── 1. The pick ─────────────────────────────────────────────────────────────────────────────
  const trip = { end: "2026-11-19", managerKey: "dm-1", start: "2026-11-18" };
  const rows: DoubleVisitRow[] = [
    visitRow({ capturedAt: "2026-11-18T07:00:00.000Z", id: "single", kind: "single" }),
    visitRow({ capturedAt: "2026-11-18T07:05:00.000Z", id: "second-manager", managerHrId: "DM-2" }),
    visitRow({ capturedAt: "2026-11-17T07:00:00.000Z", id: "day-before", visitDate: "2026-11-17" }),
    visitRow({ capturedAt: "2026-11-18T07:10:00.000Z", id: "no-position", lat: null, lon: null }),
    visitRow({ capturedAt: "2026-11-18T07:15:00.000Z", id: "zero-zero", lat: 0, lon: 0 }),
    visitRow({ capturedAt: "2026-11-18T09:00:00.000Z", id: "later" }),
    visitRow({ capturedAt: "2026-11-18T08:00:00.000Z", id: "b-chain", kind: "chain" }),
    visitRow({ capturedAt: "2026-11-18T08:00:00.000Z", id: "a-double" }),
  ];
  const first = pickFirstDoubleVisit(rows, trip);
  assert.equal(first?.id, "a-double", "the earliest saved double or chain visit as the first manager, with a position; the id breaks a tie");
  assert.equal(pickFirstDoubleVisit([...rows].reverse(), trip)?.id, "a-double", "the pick never depends on the order the rows came in");
  assert.equal(pickFirstDoubleVisit(rows.filter((row) => row.id.startsWith("a-") === false && row.id !== "b-chain" && row.id !== "later"), trip), null);
  assert.equal(pickFirstDoubleVisit([visitRow({ id: "x", visitDate: "2026-11-20" })], trip), null, "a day after the trip never counts");
  assert.equal(pickFirstDoubleVisit([visitRow({ id: "y", kind: "chain" })], trip)?.kind, "chain", "a chain visit counts like a double");

  assert.ok(isDistrictManagerRole("District Manager") && isDistrictManagerRole(" district manager "));
  assert.ok(!isDistrictManagerRole("Medical Rep") && !isDistrictManagerRole(null));
  assert.ok(isTripExpense("traveling") && !isTripExpense("meeting") && !isTripExpense("other"));
  assert.equal(WAITING_STATUSES, OUTSTATION_UNDECIDED_STATUSES, "the waiting list is the shared undecided list, never a second copy");

  // ── 2. A car trip ───────────────────────────────────────────────────────────────────────────
  const car = written(plan({}));
  assert.equal(car.write.fuel_amount, 165.6, "46 km × 2 × 1.8");
  assert.equal(car.travelBefore, 219.6);
  assert.equal(car.travelAfter, 165.6);
  assert.equal(car.write.report_travel_cost, 165.6);
  assert.equal(car.write.expected_total_amount, 290.6, "the claim moves by exactly the travel delta; the allowance never moves");
  assert.equal(car.write.claimed_total_amount, 290.6);
  assert.equal(car.write.distance_from_residence_km, 46);
  assert.equal(car.write.distance_km, 46);
  assert.ok(car.moneyMoved);
  assert.equal(car.write.distance_basis.basis, "first_double_visit");
  assert.equal(car.write.distance_basis.capturedKm, 61, "home → where he captured stays on the claim beside the priced distance");
  assert.equal(car.write.distance_basis.pricedKm, 46);
  assert.equal(car.write.distance_basis.visit?.repName, "Esraa Fotooh");
  assert.deepEqual(car.write.distance_basis.written, { distanceKm: 46, travelCost: 165.6 });
  assert.equal(written(plan({ visitKm: 89 })).write.expected_total_amount, 445.4, "a farther first double visit raises it the same way");

  // ── 3. No double visit ──────────────────────────────────────────────────────────────────────
  const none = written(plan({ visit: null, visitKm: null }));
  assert.equal(none.write.distance_basis.basis, "no_double_visit");
  assert.equal(none.moneyMoved, false, "no double visit: priced on the distance he captured");
  assert.equal(none.write.report_travel_cost, 219.6);
  assert.equal(none.write.fuel_amount, undefined, "no money column is written");
  assert.equal(none.write.distance_basis.pricedKm, 61);
  const unmeasured = written(plan({ visitKm: null }));
  assert.equal(unmeasured.write.distance_basis.basis, "unmeasured", "a visit whose road could not be measured stays on the capture");
  assert.equal(unmeasured.moneyMoved, false);

  // ── 4. Held ─────────────────────────────────────────────────────────────────────────────────
  const stops = written(plan({ claim: claim({ hasStops: true }) }));
  assert.equal(stops.write.distance_basis.held, "stops");
  assert.equal(stops.moneyMoved, false, "a trip with added stops keeps its captured route");
  const typed = written(plan({ claim: claim({ claimedTotal: 400 }) }));
  assert.equal(typed.write.distance_basis.held, "typed_amounts", "a claim that is not the system's own sum is never re-priced");
  assert.equal(typed.moneyMoved, false);
  const train = written(plan({ claim: claim({ fuelAmount: 0, ticketAmount: 180, transport: "train", travelCost: 180, expectedTotal: 305, claimedTotal: 305 }) }));
  assert.equal(train.moneyMoved, false, "a train ticket pays its ticket: only the two distances are recorded");
  assert.equal(train.write.distance_basis.basis, "first_double_visit");
  assert.equal(train.write.distance_from_residence_km, undefined);

  // ── 5. A no-ticket trip ─────────────────────────────────────────────────────────────────────
  const noTicketClaim = claim({ fuelAmount: 0, ticketAmount: 180, transport: "no_ticket", travelCost: 180, expectedTotal: 305, claimedTotal: 305 });
  const fare = resolveNoTicketFare({ destination: { latitude: 30.79, longitude: 31.0 }, home: { latitude: HOME.lat, longitude: HOME.lon } });
  const noTicket = written(plan({ claim: noTicketClaim }));
  if (fare.status === "priced") {
    assert.equal(noTicket.write.ticket_amount, Math.round(fare.totalFare * 100) / 100, "the fare to the station nearest the first double visit");
    assert.equal(noTicket.write.go_ticket_amount, fare.oneWayFare);
    assert.equal(noTicket.write.return_ticket_amount, fare.oneWayFare);
    assert.equal(noTicket.write.no_ticket_fare?.totalFare, fare.totalFare);
    assert.equal(noTicket.write.fuel_amount, undefined, "a no-ticket trip's fuel never moves");
  } else {
    assert.equal(noTicket.write.distance_basis.held, "fare_unavailable");
  }
  const noHome = written(plan({ claim: { ...noTicketClaim, home: null } }));
  assert.equal(noHome.write.distance_basis.held, "fare_unavailable", "no home on file: no fare can be worked out, so it stays as captured");
  assert.equal(noHome.moneyMoved, false);

  // ── 6. Hand edits, re-runs, a visit gone ────────────────────────────────────────────────────
  const priced = afterWrite(claim(), car);
  assert.equal(editedSincePriced(priced), false, "the system's own write is not a hand edit");
  assert.deepEqual(plan({ claim: priced }), { action: "skip", reason: "unchanged" }, "the same visit and figures again: nothing to write");
  assert.ok(editedSincePriced({ ...priced, travelCost: 200 }), "a travel cost changed after pricing is a hand edit");
  assert.ok(editedSincePriced({ ...priced, distanceKm: 70 }), "a distance changed after pricing is a hand edit");
  assert.deepEqual(plan({ claim: { ...priced, travelCost: 200 } }), { action: "skip", reason: "edited_since_priced" }, "never priced over a hand edit");
  const moved = written(plan({ claim: priced, visit: visit({ id: "v-0", capturedAt: "2026-11-18T07:00:00.000Z" }), visitKm: 58 }));
  assert.equal(moved.write.distance_basis.capturedKm, 61, "a later run keeps the FIRST capture distance, never the visit's");
  assert.equal(moved.write.fuel_amount, 208.8);
  const gone = written(plan({ claim: priced, visit: null, visitKm: null }));
  assert.equal(gone.write.fuel_amount, 219.6, "the visit gone: a car claim goes back to the distance he captured");
  assert.equal(gone.write.distance_from_residence_km, 61);
  assert.equal(gone.write.expected_total_amount, 344.6);

  assert.equal(readDistanceBasis(null), null);
  assert.equal(readDistanceBasis({ basis: "something_else" }), null, "a malformed basis reads as none");
  assert.equal(readDistanceBasis([1, 2]), null);

  // ── 7. The desk ─────────────────────────────────────────────────────────────────────────────
  const basis = car.write.distance_basis;
  const pass = distanceBasisVerdict({ basis, waiting: true });
  assert.equal(pass?.answer, "pass");
  assert.equal(pass?.sentence, "Priced on the 46 km from home to the first double visit, with Esraa Fotooh on 18 Nov; the capture point is 61 km from home.");
  const short: DistanceBasis = { ...basis, visit: basis.visit ? { ...basis.visit, km: 2 } : null };
  const fail = distanceBasisVerdict({ basis: short, waiting: true });
  assert.equal(fail?.answer, "fail", "a first double visit under the minimum distance fails — flagged for the approver, never refused");
  assert.match(fail?.sentence ?? "", /2 km from home, under the 40 km minimum/);
  // A km just under the minimum never reads rounded up to it (claim 335, 23 Nov 2026: 59.75 km printed as
  // "60 km from home, under the 60 km minimum"). Whole km everywhere else.
  const justUnder: DistanceBasis = { ...basis, visit: basis.visit ? { ...basis.visit, km: 39.75 } : null };
  const justUnderVerdict = distanceBasisVerdict({ basis: justUnder, waiting: true });
  assert.equal(justUnderVerdict?.answer, "fail", "39.75 km is under the 40 km minimum");
  assert.match(justUnderVerdict?.sentence ?? "", /is 39\.75 km from home, under the 40 km minimum/, "the exact km, never rounded up to the minimum");
  assert.doesNotMatch(justUnderVerdict?.sentence ?? "", /is 40 km from home/, "a trip under the minimum never prints AS the minimum");
  assert.equal(tripKmText(59.75, 60), "59.75 km", "the opened trip's figure keeps the shortfall too");
  assert.equal(tripKmText(59.999, 60), "59.99 km", "cut, never rounded, so it stays under");
  assert.equal(tripKmText(55.97, 60), "56 km", "whole km when rounding stays under the minimum");
  assert.equal(tripKmText(60.4, 60), "60 km", "whole km at or over the minimum");
  assert.equal(tripKmText(59.75, null), "60 km", "no minimum, nothing to hide: whole km");
  assert.equal(tripKmText(null, 60), "an unknown distance");
  const noVisit = distanceBasisVerdict({ basis: none.write.distance_basis, waiting: true });
  assert.equal(noVisit?.answer, "unknown");
  assert.equal(noVisit?.sentence, "No double visit on this trip. Priced on the 61 km from home to the capture point.");
  assert.equal(distanceBasisVerdict({ basis: null, waiting: true })?.answer, "unknown", "not priced yet is never a pass");
  assert.equal(distanceBasisVerdict({ basis: null, waiting: false }), null, "a decided claim the rule never saw says nothing");
  assert.equal(distanceBasisVerdict({ basis: stops.write.distance_basis, waiting: true })?.answer, "unknown");

  const distanceOf = (facts: ClaimCheckFacts) => runClaimChecks(facts).find((entry) => entry.key === "distance");
  assert.equal(distanceOf(deskFacts({ distanceBasis: basis }))?.answer, "pass");
  assert.equal(judgeClaim(deskFacts({ distanceBasis: basis })).lane, "ready", "a clean trip priced on its first double visit is Ready");
  const yourCall = judgeClaim(deskFacts({ distanceBasis: none.write.distance_basis }));
  assert.equal(yourCall.lane, "your_call", "no double visit on this trip is his call");
  assert.equal(yourCall.reason, "No double visit on this trip. Priced on the 61 km from home to the capture point.");
  assert.equal(judgeClaim(deskFacts({ distanceBasis: short })).lane, "your_call");
  assert.equal(distanceOf(deskFacts({ distanceBasis: basis, role: "Medical Rep" })), undefined, "the rule is the District Manager's alone");
  assert.equal(distanceOf(deskFacts()), undefined, "a field never read adds no check");

  const deskRow = (over: Record<string, unknown> = {}) => ({
    distance_basis: JSON.parse(JSON.stringify(basis)),
    employee_role: "District Manager",
    expense_type: "traveling",
    ...over,
  });
  assert.deepEqual(deskDistanceOfRow(deskRow() as never), { basis: "first_double_visit", capturedKm: 61, visitKm: 46, minimumKm: 40, visitWords: "with Esraa Fotooh on 18 Nov" });
  assert.equal(deskDistanceOfRow(deskRow({ employee_role: "Medical Rep" }) as never), null);
  assert.equal(deskDistanceOfRow(deskRow({ expense_type: "meeting" }) as never), null);
  assert.equal(deskDistanceOfRow(deskRow({ distance_basis: null }) as never), null);
  assert.ok(DESK_CLAIM_COLUMNS.split(", ").includes("distance_basis"), "the desk reads the column");
  const tripFile = read("src/components/outstation/approvals-desk/desk-trip-file.tsx");
  assert.match(tripFile, /Home to the capture point/, "the opened trip shows home → capture point");
  assert.match(tripFile, /home to the first double visit/i, "beside home → the first double visit");
  assert.match(tripFile, /No double visit on this trip/);
  assert.match(tripFile, /tripKmText\(km, minimumKm\)/, "the opened trip prints its km through the one rule that never rounds up to the minimum");
  assert.doesNotMatch(tripFile, /Math\.round\(km\)/, "no km rounded on its own in the opened trip");

  // ── 8. The wiring ───────────────────────────────────────────────────────────────────────────
  const service = read("src/lib/outstation/service.ts");
  const submit = service.slice(service.indexOf("export async function submitOutstationRequest("));
  const hook = submit.slice(0, submit.indexOf("Every submission now WAITS"));
  assert.match(hook, /if \(!nonTravel && isDistrictManagerRole\(calculation\.employeeRole\)\) \{\s*try \{/, "priced at submit, District Manager trips only");
  assert.match(hook, /await import\("@\/lib\/outstation\/dm-double-visit-distance-server"\)/);
  assert.match(hook, /\} catch \(priceError\) \{\s*logError\(/, "a failed pricing is logged and never fails the submission he just made");

  const runners = read("app/api/cron/daily/_lib/daily-job-runners.ts");
  const departureJob = runners.slice(runners.indexOf('"outstation-departure-photo": {'), runners.indexOf('"resignation-sla": {'));
  assert.match(departureJob, /priceWaitingDistrictManagerClaims\(\)\.catch\(\(error: unknown\) => \{\s*logError\(/, "every morning, logged as an ERROR when it fails");
  assert.match(departureJob, /doubleVisitPricing/);

  const server = read("src/lib/outstation/dm-double-visit-distance-server.ts");
  assert.match(server, /\.in\("status", \[\.\.\.WAITING_STATUSES\]\)\s*\.eq\("updated_at", String\(row\.updated_at\)\)/, "each write is pinned to the waiting version it read");
  assert.match(server, /\.from\("outstation_expenses"\)/, "a claim a payroll row carries is never moved");
  assert.match(server, /source: "dm_first_double_visit_pricing"/, "each write leaves an audit row");
  assert.match(server, /\.eq\("manager_hr_id", managerHrId\)/, "only visits where he is the first manager");
  assert.match(server, /\.in\("kind", \["double", "chain"\]\)/);
  assert.match(server, /\.eq\("is_test", false\)/);

  const migration = read("supabase/migrations/20261123115831_outstation_request_distance_basis.sql");
  assert.match(migration, /add column if not exists distance_basis jsonb/);
}
