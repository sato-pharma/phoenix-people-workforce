import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { planBulkApproval } from "../src/lib/outstation/approval-state.ts";
import { approvePays, approvePress, readyBatch, selectionBatch } from "../src/lib/outstation/approvals/desk-view.ts";
import type { DeskClaim } from "../src/lib/outstation/approvals/types.ts";
import { buildCrmTripEvidence, type CrmTripDayInput } from "../src/lib/outstation/crm-trip-evidence.ts";
import { daysBeforePhoenixCrm } from "../src/lib/phoenix-crm/live-team-rules.ts";
import { foldPlanOutstationTrips, planOutstationTripLine } from "../src/lib/phoenix-crm/outstation-trip-banner.ts";
import { stripComments } from "./support/comment-strip.ts";

// Phoenix CRM wired into Expense Approvals (owner, 2026-11-07: "I want to wire the Phoenix CRM with
// expense module and get most benefit of this integration"). He chose: where he really was, was the
// trip planned, the wizard's destination line, claimed km vs CRM, location warnings, the trip on the
// CRM side, "no plan, no visits"; and on idle days "he put trip from 23 to 26 and visits are 23 24
// 25 only, then don't count 26" — "Approver sees it pre-cut", "Only visits count", "Meetings count
// too".

const HOME = { lat: 30.0444, lon: 31.2357 }; // Cairo
const DEST = { lat: 31.2001, lon: 29.9187 }; // Alexandria, ~180 km away

const day = (date: string, patch: Partial<CrmTripDayInput> = {}): CrmTripDayInput => ({
  activitiesLogged: [],
  date,
  dayStart: null,
  managerPlan: null,
  plan: { activities: [], places: [{ area: "Alex Center", brick: "Raml", label: "Clinic" }], status: "approved" },
  rideAlongsPlanned: [],
  sharedCar: [],
  visits: [],
  ...patch,
});

const visitAt = (point: { lat: number; lon: number }, savedAt: string) => ({
  area: "Alex Center",
  brick: "Raml",
  customer: "Dr Test",
  locationFlag: null,
  place: "Clinic",
  point,
  region: "Alex",
  savedAt,
  unplanned: false,
});

export function runOutstationCrmTripEvidenceTests() {
  // ── 1. Where he really was ──────────────────────────────────────────────────────────────────
  const clean = buildCrmTripEvidence({
    claimedKm: 200,
    days: [
      day("2026-10-23", { visits: [visitAt(DEST, "2026-10-23T08:00:00Z")] }),
      day("2026-10-24", { dayStart: { at: "2026-10-24T06:30:00Z", point: DEST }, visits: [visitAt(DEST, "2026-10-24T09:00:00Z")] }),
    ],
    destination: DEST,
    home: HOME,
    isCar: true,
    warnings: [],
  });
  assert.equal(clean.days[0].whereabouts, "destination");
  assert.equal(clean.days[0].night?.verdict, "stayed", "HEADLINE: the next morning's Day Start at the destination means he stayed");
  assert.equal(clean.days[1].night, null, "the last day has no night without the morning after");
  assert.equal(clean.signal.tone, "ok");

  const home = buildCrmTripEvidence({
    claimedKm: 200,
    days: [day("2026-10-23", { visits: [visitAt(DEST, "2026-10-23T08:00:00Z")] }), day("2026-10-24", { visits: [visitAt(HOME, "2026-10-24T09:00:00Z")] })],
    destination: DEST,
    home: HOME,
    isCar: false,
    warnings: [],
  });
  assert.deepEqual(home.homeDays, ["2026-10-24"], "HEADLINE: a trip day whose visits were all back home is named");
  assert.equal(home.signal.tone, "danger");
  assert.equal(home.days[0].night?.verdict, "home", "HEADLINE: the next morning's first visit back home means the night was not away");

  // The morning after the trip answers the last night, and is never a trip day itself.
  const after = buildCrmTripEvidence({
    claimedKm: null,
    days: [day("2026-10-23", { visits: [visitAt(DEST, "2026-10-23T08:00:00Z")] })],
    destination: DEST,
    home: HOME,
    isCar: false,
    morningAfter: { at: "2026-10-24T06:00:00Z", point: HOME },
    warnings: [],
  });
  assert.equal(after.days.length, 1, "HEADLINE: the morning after is read for the last night only");
  assert.equal(after.days[0].night?.verdict, "home", "HEADLINE: the Day Start the morning after the trip answers its last night");

  // ── 2. Claimed kilometres vs the farthest visit (straight lines: a look, never "wrong") ──────
  const km = buildCrmTripEvidence({
    claimedKm: 500,
    days: [day("2026-10-23", { visits: [visitAt(DEST, "2026-10-23T08:00:00Z")] })],
    destination: DEST,
    home: HOME,
    isCar: true,
    warnings: [],
  });
  assert.equal(km.km?.needsLook, true, "HEADLINE: 500 km claimed against a farthest visit ~180 km away needs a look");
  assert.equal(clean.km?.needsLook, false, "200 km against ~180 km straight is within the road factor");
  const kmInput = { claimedKm: 500, days: [day("2026-10-23", { visits: [visitAt(DEST, "2026-10-23T08:00:00Z")] })], destination: DEST, home: HOME, warnings: [] };
  assert.equal(buildCrmTripEvidence({ ...kmInput, isCar: false }).km?.needsLook, false, "only a car claim is read for kilometres");

  // ── 3. Planned, empty, warnings, the shared car ─────────────────────────────────────────────
  const mixedDays = [
    day("2026-10-23", { plan: null }),
    day("2026-10-24", { plan: { activities: [], places: [{ area: "Alex Center", brick: "Raml", label: "Clinic" }], status: "draft" }, visits: [visitAt(DEST, "2026-10-24T09:00:00Z")] }),
    day("2026-10-25", { sharedCar: [{ name: "Partner", requestId: 9 }], visits: [visitAt(DEST, "2026-10-25T09:00:00Z")] }),
    day("2026-10-26", { plan: null, visits: [visitAt(DEST, "2026-10-26T09:00:00Z")] }),
  ];
  const mixed = buildCrmTripEvidence({
    claimedKm: null,
    days: mixedDays,
    destination: DEST,
    home: HOME,
    isCar: true,
    warnings: [{ label: "Position", strong: false }],
  });
  assert.deepEqual(mixed.emptyDays, ["2026-10-23"], "HEADLINE: a day with no plan, no visit, no activity and no Day Start is nothing in Phoenix CRM");
  assert.deepEqual(mixed.unplannedDays, ["2026-10-23", "2026-10-24", "2026-10-26"], "HEADLINE: a draft is not a sent plan");
  assert.deepEqual(mixed.sharedCarDays, ["2026-10-25"]);
  assert.match(mixed.signal.sentence, /visit partner/, "the shared car outranks empty days and warnings in the one sentence");
  assert.equal(
    buildCrmTripEvidence({ claimedKm: null, days: mixedDays.map((entry) => ({ ...entry, sharedCar: [] })), destination: DEST, home: HOME, isCar: true, warnings: [{ label: "Position", strong: true }] }).signal.tone,
    "danger",
    "HEADLINE: a strong location warning is a danger signal",
  );

  // ── 3b. Before Phoenix CRM: the old system holds the day, so it is no signal (owner, 2026-11-07, on
  // trip 112 — 1 Sep, eight visits in the old system, read "Nothing in Phoenix CRM" in amber).
  const windows = [
    { startsOn: "2026-10-03", stopsOn: null, teamSeatId: "team-delta" },
    { startsOn: "2026-10-10", stopsOn: "2026-10-24", teamSeatId: "team-cairo" },
  ];
  assert.deepEqual(
    daysBeforePhoenixCrm(windows, new Set(["team-delta"]), ["2026-10-02", "2026-10-03", "2026-11-01"]),
    ["2026-10-02"],
    "HEADLINE: a day before the team's Saturday is before Phoenix CRM; from it on, it is counted",
  );
  assert.deepEqual(
    daysBeforePhoenixCrm(windows, new Set(["team-cairo"]), ["2026-10-09", "2026-10-10", "2026-10-23", "2026-10-24"]),
    ["2026-10-09", "2026-10-24"],
    "a stop gives the day back to the old system from its Saturday",
  );
  assert.deepEqual(daysBeforePhoenixCrm(windows, new Set(["team-elsewhere"]), ["2026-10-20"]), ["2026-10-20"], "a person in no started team is before Phoenix CRM on every day");

  const oldTrip = buildCrmTripEvidence({
    beforePhoenix: ["2026-09-01"],
    claimedKm: null,
    days: [day("2026-09-01", { plan: null })],
    destination: DEST,
    home: HOME,
    isCar: true,
    warnings: [],
  });
  assert.deepEqual(oldTrip.emptyDays, [], "HEADLINE: a day before Phoenix CRM is never 'nothing in Phoenix CRM'");
  assert.deepEqual(oldTrip.unplannedDays, [], "nor 'not in a sent plan'");
  assert.equal(oldTrip.days[0].beforePhoenix, true);
  assert.equal(oldTrip.signal.tone, "neutral", "HEADLINE: a trip wholly before Phoenix CRM reads neutral, never amber");
  assert.match(oldTrip.signal.sentence, /^Before Phoenix CRM/);
  const straddle = buildCrmTripEvidence({
    beforePhoenix: ["2026-10-02"],
    claimedKm: null,
    days: [day("2026-10-02", { plan: null }), day("2026-10-03", { plan: null })],
    destination: DEST,
    home: HOME,
    isCar: false,
    warnings: [],
  });
  assert.deepEqual(straddle.emptyDays, ["2026-10-03"], "HEADLINE: a counted day with nothing still reads empty beside one before the start");
  assert.equal(straddle.signal.tone, "warn");
  const evidenceReader = stripComments(readFileSync("src/lib/outstation/crm-trip-evidence-reader.ts", "utf8"));
  assert.match(evidenceReader, /daysBeforePhoenixCrm\(windows, teams, dates\)/, "HEADLINE: the reader asks the rule with the person's own teams");
  assert.match(evidenceReader, /beforePhoenix,\s*claimedKm/, "and hands the days to the builder");
  assert.match(readFileSync("src/lib/phoenix-crm/server/live-teams.ts", "utf8"), /export async function loadTeamCountedWindows/, "the starts are read in the table's own file");
  assert.ok(readFileSync("src/components/outstation/approvals-desk/desk-days.tsx", "utf8").includes('day.beforePhoenix ? "Before Phoenix CRM"'), "the day says so in words");

  // ── 4. The trip on the CRM side ─────────────────────────────────────────────────────────────
  const trips = foldPlanOutstationTrips([
    { date: "2026-10-23", destination: "Alexandria" },
    { date: "2026-10-24", destination: "Alexandria" },
    { date: "2026-10-26", destination: "Alexandria" },
    { date: "2026-10-24", destination: null },
  ]);
  assert.deepEqual(trips, [
    { destination: "Alexandria", from: "2026-10-23", to: "2026-10-24" },
    { destination: "Alexandria", from: "2026-10-26", to: "2026-10-26" },
  ], "HEADLINE: consecutive days fold into one trip; a gap starts another");
  assert.equal(planOutstationTripLine(trips[0]), "On an outstation trip to Alexandria · Fri 23 Oct to Sat 24 Oct");
  const planner = readFileSync("src/lib/phoenix-crm/server/monthly-plans.ts", "utf8");
  assert.match(planner, /loadPeopleOutstationTrips\(seatOccupants\(seat\)/, "HEADLINE: the banner reads the territory person's own trips, never the reviewer's");
  assert.match(readFileSync("src/lib/phoenix-crm/server/outstation-trips.ts", "utf8"), /loadOutstationTripDays\(/, "through the one reader of trip days");
  assert.match(readFileSync("src/components/phoenix-crm/plan-review-steps.tsx", "utf8"), /<PlanOutstationTrips\s+from=\{week\.weekStart\}/, "the manager reads the week under review");

  // ── 5. The pre-cut: Approve applies it; nothing is written by opening a trip ────────────────
  // Rebuilt 2026-11-23 (approvals-desk/): the cut is worked out once, on the server (`claimPreCut`),
  // arrives on the claim, and the ONE Approve button of the page reads it (`approvePress`).
  const idleTrip = {
    holdReason: null,
    preCut: { deduction: 300, label: "1 idle day", payable: 700, reason: "One day with no visit and no meeting." },
    requestId: 5,
    revision: "r5",
    standing: "waiting",
    total: 1000,
  } as unknown as DeskClaim;
  assert.deepEqual(
    approvePress(idleTrip),
    { action: "approve", approvedAmount: 700, requestId: 5, revision: "r5" },
    "HEADLINE: an undecided trip with idle days arrives pre-cut, and Approve applies the cut",
  );
  assert.equal(approvePays(idleTrip), 700, "and the button shows what Approve will pay");
  assert.deepEqual(
    approvePress(idleTrip, { full: true }),
    { action: "approve", requestId: 5, revision: "r5" },
    "HEADLINE: Keep full claim sets the pre-cut aside",
  );
  assert.deepEqual(
    approvePress({ ...idleTrip, holdReason: "Photos are missing." } as DeskClaim),
    { action: "approve", requestId: 5, revision: "r5" },
    "a trip the payroll gate would hold carries no reduced amount: it would pay in full on release",
  );
  const bar = stripComments(readFileSync("src/components/outstation/approvals-desk/desk-decision.tsx", "utf8"));
  assert.ok(bar.includes("onClick={() => onPress([approvePress(claim, { full: decided(claim) })], [claim])}"), "Approve is that one press");
  assert.ok(bar.includes("cut ? `${DESK_WORDS.approve} ${egp(cut.payable)}` : DESK_WORDS.approve"), "and the button names the amount it pays");
  assert.ok(
    bar.includes('data-press="keep-full" onClick={() => onPress([approvePress(claim, { full: true })], [claim])}'),
    "Keep full claim is its own button, beside it",
  );
  const opened = bar + stripComments(readFileSync("src/components/outstation/approvals-desk/desk-trip-file.tsx", "utf8"));
  assert.doesNotMatch(opened, /useEffect\(\(\) => \{[^}]*onPress/, "HEADLINE: opening a trip never writes anything: only a press does");

  // The batch cannot show the cut, so it holds such a trip back.
  const base = { approvedAmount: 1000, claimedTotal: 1000, hrApproved: false, hrComment: "", status: "pending" };
  const plan = planBulkApproval([
    { ...base, allowance: 300, tripId: "idle", workloadMatchStatus: "partial" },
    { ...base, allowance: 0, tripId: "no-allowance", workloadMatchStatus: "no_activity" },
    { ...base, allowance: 300, tripId: "worked", workloadMatchStatus: "matched" },
    { ...base, allowance: 300, approvedAmount: 900, hrComment: "Cut the idle day.", tripId: "cut", workloadMatchStatus: "no_activity" },
  ]);
  assert.deepEqual(plan.needsPreCutTripIds, ["idle"], "HEADLINE: a batch never pays an idle day in full");
  assert.deepEqual(plan.approvableTripIds, ["no-allowance", "worked", "cut"], "no allowance, worked days, or a cut already chosen pass");

  // ── 6. The approver's reading: the board's own readers, Super Admin only ────────────────────
  const reader = stripComments(readFileSync("src/lib/outstation/crm-trip-evidence-reader.ts", "utf8"));
  assert.match(reader, /loadIntegrityCasesForWindow\(\{/, "HEADLINE: location warnings through the board's own reader");
  assert.doesNotMatch(reader, /from\("phoenix_crm_location_integrity"\)/, "never a second reader of the integrity table");
  assert.match(reader, /planDayStatus\(\{ \.\.\.fact, date \}\)/, "the plan status is asked day by day");
  assert.doesNotMatch(reader, /\.or\(/, "no spliced .or filter — one read per role, merged by id");
  const route = readFileSync("app/api/admin/outstation/[id]/crm-evidence/route.ts", "utf8");
  assert.match(route, /await assertOutstationAdminAccess\(access, "approve"\);/, "HEADLINE: the approver alone reads it");
  const areas = stripComments(readFileSync("app/api/outstation/planned-areas/route.ts", "utf8"));
  assert.match(areas, /const hrId = access\.hrId \|\| access\.loginId \|\| "";/, "HEADLINE: the wizard reads the caller's own plan only");
  assert.doesNotMatch(areas, /searchParams\.get\("(employeeHrId|hrId)"\)/, "never an hr id from the request");
  // Rebuilt 2026-11-23 (approvals-desk/): Phoenix CRM's reading is part of the ONE trip file. It is
  // read with the trip, in the same request, and drawn day by day under what the system found.
  const tripFileRead = stripComments(readFileSync("src/lib/outstation/approvals/trip-file.ts", "utf8"));
  assert.ok(
    tripFileRead.includes("options.includeEvidence ? Promise.allSettled([loadCrmTripEvidence(requestId)]).then(([result]) => result) : null,"),
    "HEADLINE: Phoenix CRM's reading arrives with the trip, and only when the caller may see the evidence",
  );
  const tripRoute = stripComments(readFileSync("app/api/admin/outstation/approvals/[requestId]/route.ts", "utf8"));
  assert.match(tripRoute, /let includeEvidence = false;[\s\S]{0,400}includeEvidence = true;/, "which the route grants, never the page");
  const tripFile = readFileSync("src/components/outstation/approvals-desk/desk-trip-file.tsx", "utf8");
  assert.ok(
    tripFile.includes("<DeskDays attachments={file.attachments} reading={file.crm?.reading ?? null} tripEnd={claim.tripEnd} tripStart={claim.tripStart} />"),
    "HEADLINE: Phoenix CRM is part of what the reviewer reads, day by day",
  );
  assert.ok(
    tripFile.indexOf('<Sheet name="found" title="What the system found">') < tripFile.indexOf('<Sheet name="days" title="The trip, day by day">'),
    "the days follow what the system found",
  );
  // A list row and the batch follow the same rule: every Approve on the page is `approvePress`.
  const view = stripComments(readFileSync("src/lib/outstation/approvals/desk-view.ts", "utf8"));
  assert.ok(view.includes("approve: sendable.map((claim) => approvePress(claim)),"), "HEADLINE: a ticked batch sends each row's own Approve");
  assert.ok(view.includes("decisions: taken.map((claim) => approvePress(claim)),"), "and so does Approve all");
  const ticked = selectionBatch([idleTrip, { ...idleTrip, preCut: null, requestId: 6, revision: "r6" }], new Set([5, 6]), 50);
  assert.deepEqual(
    ticked.approve.map((entry) => entry.approvedAmount ?? null),
    [700, null],
    "HEADLINE: a batch never pays an idle day in full on the desk either",
  );
  assert.equal(ticked.value, 1700, "and the button's figure is what those presses pay");
  assert.equal(readyBatch([idleTrip], 50).decisions[0].approvedAmount, 700, "Approve all could not pay an idle day in full even if one reached it");
}
