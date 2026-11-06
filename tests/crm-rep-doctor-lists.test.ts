import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_DOCTOR_COVERAGE_NORMS } from "../src/lib/crm/doctor-coverage-config.ts";
import {
  buildRepDoctorListsBoard,
  frequencyStatusOf,
  gradeTierOf,
  monthBounds,
  monthKeyOfDate,
  monthLabelOf,
  REP_DOCTOR_DRILLDOWN_CAP,
  resolveRepDoctorListMonth,
  type PlanRow,
  type RepDoctorListsInput,
  type VisitRow,
} from "../src/lib/crm/rep-doctor-lists.ts";
import { canAccessRepDoctorLists, REP_DOCTOR_LISTS_ACCESS_ROLES } from "../src/lib/crm/rep-doctor-lists-access.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";

// Rep Doctor Lists — the board that answers "which doctors on this rep's own list did they never
// reach?".
//
// WHY THIS TEST IS NOT OPTIONAL. Every other CRM board in this codebase is built from visit
// HISTORY, so its worst failure is an omission nobody can see. This one is built from an ASSIGNMENT
// list, and its output is an accusation: "this rep never visited 59 of their doctors." A join bug
// here does not lose a row — it invents a performance problem for a named human being. So the whole
// join is a pure function and every number below is pinned to a fixture that can be read by hand.
//
// Fixture shape (August 2026), chosen so each rep proves a different rule:
//   agent 101 — a full list: repeat calls, a pharmacy, an unknown specialty, two never-visited
//               doctors, two off-plan visits, and a name that must come from the HR directory.
//   agent 202 — plans the SAME doctor as 101, and has no directory entry (vendor name wins).
//   agent 303 — departed. Has a plan on file. Must vanish from every number on the board.
//   agent 404 — visited, never planned. Has no name anywhere.

const MONTH = "2026-08";

function plan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    agent_crm_id: 101,
    agent_hr_id: "PHX-101",
    contact_crm_id: 1001,
    contact_grade: "A",
    contact_name: "Planned Contact",
    crm_region_name: "Cairo",
    plan_date: "2026-08-03",
    plan_status: 1,
    speciality: "Internal Medicine",
    synced_at: "2026-08-21T09:00:00.000Z",
    ...overrides,
  };
}

function visit(overrides: Partial<VisitRow> = {}): VisitRow {
  return {
    agent_crm_id: 101,
    agent_hr_id: "PHX-101",
    agent_name: "Mostafa K (CRM label)",
    contact_crm_id: 1001,
    crm_contact_grade: "A",
    speciality: "Internal Medicine",
    visit_date: "2026-08-03",
    visit_type: 0,
    ...overrides,
  };
}

/** A campaign call: the rep worked, but the vendor names no doctor on it. Every one of the 31,322
 * recorded in production carries contact id 0, blank name, blank speciality. */
function campaign(overrides: Partial<VisitRow> = {}): VisitRow {
  return visit({ contact_crm_id: 0, speciality: null, visit_type: -8, ...overrides });
}

const PLAN_ROWS: PlanRow[] = [
  // 1001 is planned TWICE — one doctor, two calls, and the second is still unverified (status 0).
  plan({ contact_crm_id: 1001, contact_name: "Ahmed Fouad", contact_grade: "A+", plan_date: "2026-08-03" }),
  plan({
    contact_crm_id: 1001,
    contact_name: "Ahmed Fouad",
    contact_grade: "A+",
    plan_date: "2026-08-17",
    plan_status: 0,
    synced_at: "2026-08-21T10:00:00.000Z",
  }),
  plan({
    contact_crm_id: 1002,
    contact_name: "Sara Nabil",
    contact_grade: "b",
    speciality: "Pediatrics",
    plan_date: "2026-08-05",
  }),
  plan({
    contact_crm_id: 1003,
    contact_name: "Hany Adel",
    contact_grade: "C",
    speciality: "Neurology",
    plan_date: "2026-08-06",
  }),
  plan({
    contact_crm_id: 1004,
    contact_name: "Mona Saad",
    contact_grade: null,
    speciality: "Chest",
    plan_date: "2026-08-07",
  }),
  // A place, not a person — must never enter the doctor list or move either KPI.
  plan({ contact_crm_id: 1005, contact_name: "El Ezaby Pharmacy", speciality: "Pharmacy", plan_date: "2026-08-08" }),
  // A specialty the shared taxonomy has never seen. Neither doctor nor account until someone rules.
  // Deliberately synthetic (not a real medical specialty): this fixture used "Nephrology" for the
  // same purpose until 2026-08-21, when the taxonomy correctly learned it as a real SP value and
  // silently flipped this test's math — a synthetic label can never be reclassified out from under it.
  plan({ contact_crm_id: 1006, contact_name: "Unlisted Doc", speciality: "Unlisted Test Specialty", plan_date: "2026-08-09" }),
  // The vendor's two "no contact" shapes.
  plan({ contact_crm_id: null, contact_name: null, plan_date: "2026-08-10" }),
  plan({ contact_crm_id: 0, contact_name: null, plan_date: "2026-08-10" }),
  // Rep 202: one of their own, plus the same doctor rep 101 has.
  plan({
    agent_crm_id: 202,
    agent_hr_id: "PHX-202",
    contact_crm_id: 2001,
    contact_name: "Laila Hassan",
    speciality: "Urology",
    plan_date: "2026-08-04",
    plan_status: 2,
  }),
  plan({
    agent_crm_id: 202,
    agent_hr_id: "PHX-202",
    contact_crm_id: 1003,
    contact_name: "Hany Adel",
    contact_grade: "C",
    speciality: "Neurology",
    plan_date: "2026-08-11",
  }),
  // Rep 505: a real doctor list, against which they made zero regular visits.
  plan({
    agent_crm_id: 505,
    agent_hr_id: null,
    contact_crm_id: 5001,
    contact_name: "Campaign Doc",
    speciality: "Cardiology",
    plan_date: "2026-08-06",
  }),
  plan({
    agent_crm_id: 505,
    agent_hr_id: null,
    contact_crm_id: 5002,
    contact_name: "Campaign Doc Two",
    speciality: "Chest",
    plan_date: "2026-08-07",
  }),
  // Departed rep with a plan still on file.
  plan({
    agent_crm_id: 303,
    agent_hr_id: "PHX-303",
    contact_crm_id: 3001,
    contact_name: "Departed Doc",
    speciality: "ENT",
    plan_date: "2026-08-12",
  }),
];

// The visits door has ALREADY dropped agent 303 and collapsed duplicate submissions, so nothing
// here belongs to 303 — that exclusion is the door's job and this board must not re-do it.
const VISIT_ROWS: VisitRow[] = [
  visit({ contact_crm_id: 1001, visit_date: "2026-08-03" }),
  visit({ contact_crm_id: 1001, visit_date: "2026-08-18" }),
  visit({ contact_crm_id: 1002, speciality: "Pediatrics", visit_date: "2026-08-05" }),
  // Off plan for 101, and on nobody's plan at all — the only row allowed to print an id form.
  visit({ contact_crm_id: 9001, speciality: "Cardiology", visit_date: "2026-08-19" }),
  // Off plan for 101, but on rep 202's plan — so its name must be recoverable.
  visit({ contact_crm_id: 2001, speciality: "Urology", visit_date: "2026-08-20" }),
  visit({
    agent_crm_id: 202,
    agent_hr_id: "PHX-202",
    agent_name: "Vendor Label Rep",
    contact_crm_id: 2001,
    speciality: "Urology",
    visit_date: "2026-08-04",
  }),
  visit({
    agent_crm_id: 404,
    agent_hr_id: null,
    agent_name: null,
    contact_crm_id: 4001,
    speciality: "ENT",
    visit_date: "2026-08-02",
  }),
  // A visit with no contact: proves the rep worked, contributes no doctor row.
  visit({ contact_crm_id: null, visit_date: "2026-08-21" }),
  // Rep 505 spent the month on campaign work: a full plan, not one regular visit. Their name is
  // recoverable ONLY from these rows.
  campaign({ agent_crm_id: 505, agent_hr_id: null, agent_name: "Campaign Only Rep", visit_date: "2026-08-06" }),
  campaign({ agent_crm_id: 505, agent_hr_id: null, agent_name: "Campaign Only Rep", visit_date: "2026-08-07" }),
  campaign({ agent_crm_id: 505, agent_hr_id: null, agent_name: "Campaign Only Rep", visit_date: "2026-08-08" }),
  // A campaign row carrying a REAL contact that IS on rep 505's plan. No such row exists in
  // production today -- all 31,322 campaign visits carry contact id 0 -- which is exactly why it
  // belongs here: without it the type split is only redundant with the id-0 sentinel guard, and a
  // regression that let campaign rows into the join would pass unnoticed. If the vendor ever starts
  // populating this field, THIS is the assertion that catches it.
  campaign({
    agent_crm_id: 505,
    agent_hr_id: null,
    agent_name: "Campaign Only Rep",
    contact_crm_id: 5001,
    visit_date: "2026-08-09",
  }),
];

function board(overrides: Partial<RepDoctorListsInput> = {}) {
  return buildRepDoctorListsBoard({
    employeeNameByHrId: new Map([["PHX-101", "Mostafa Kamel"]]),
    excludedAgentCrmIds: [303],
    month: MONTH,
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: PLAN_ROWS,
    visitRows: VISIT_ROWS,
    ...overrides,
  });
}

function repOf(result: ReturnType<typeof board>, repKey: string) {
  const row = result.reps.find((rep) => rep.repKey === repKey);
  assert.ok(row, `expected rep ${repKey} on the board`);
  return row;
}

function doctorOf(result: ReturnType<typeof board>, repKey: string, contactCrmId: number) {
  const row = result.doctors.find((doctor) => doctor.repKey === repKey && doctor.contactCrmId === contactCrmId);
  assert.ok(row, `expected contact ${contactCrmId} on rep ${repKey}'s list`);
  return row;
}

export function runCrmRepDoctorListsTests() {
  const result = board();

  // ── THE HEADLINE ─────────────────────────────────────────────────────────────────────────────
  // A doctor who is on a rep's list and was NEVER visited must appear, as "missed". This is the
  // entire reason the module exists: such a doctor generates no visit row, so every visit-history
  // board in this codebase is structurally blind to them.
  for (const contactCrmId of [1003, 1004]) {
    const missed = doctorOf(result, "101", contactCrmId);
    assert.equal(
      missed.status,
      "missed",
      `a planned doctor with no visit must read as "missed" — contact ${contactCrmId} is the population this board exists to show`,
    );
    assert.equal(missed.visits, 0, `a missed doctor must report zero visits — contact ${contactCrmId}`);
    assert.equal(missed.lastVisitDate, null, `a missed doctor must have no last visit date — contact ${contactCrmId}`);
    assert.ok(
      missed.plannedCalls > 0,
      `a missed doctor must still show the calls that were planned — contact ${contactCrmId}`,
    );
  }
  assert.equal(
    repOf(result, "101").missedDoctors,
    2,
    "rep 101 planned 4 doctors and saw 2 — exactly 2 must count as never visited",
  );

  // Run the two rules that decide whether a working rep is presented as idle BEFORE the aggregate
  // totals, so a regression fires the assertion that names the rule rather than an arithmetic sum.
  runCampaignTests(result);
  runNoPlanRankingTests(result);

  // ── Adherence is doctors-only ────────────────────────────────────────────────────────────────
  const rep101 = repOf(result, "101");
  assert.equal(
    rep101.plannedDoctors,
    4,
    "only the four SP contacts are doctors — the pharmacy and the unknown specialty are not",
  );
  assert.equal(rep101.plannedAccounts, 1, "the pharmacy is counted, separately, as an account");
  assert.equal(
    rep101.plannedUnclassified,
    1,
    "an unrecognised specialty is counted on its own, never folded into either bucket",
  );
  assert.equal(rep101.visitedDoctors, 2, "1001 and 1002 were visited");
  assert.equal(rep101.coveragePct, 50, "2 of 4 planned doctors visited = 50%");
  assert.equal(
    rep101.plannedCalls,
    7,
    "seven plan entries survive: 2x1001 + 1002 + 1003 + 1004 + pharmacy + the unlisted specialty",
  );
  assert.equal(rep101.unverifiedCalls, 1, "only the second call on 1001 is still at vendor status 0 (New)");

  // A pharmacy on the plan must not be able to move a rep's coverage in either direction.
  const withoutPharmacy = board({ planRows: PLAN_ROWS.filter((row) => row.contact_crm_id !== 1005) });
  assert.equal(
    repOf(withoutPharmacy, "101").coveragePct,
    rep101.coveragePct,
    "removing a planned PHARMACY must not change coverage — a pharmacy is not a doctor",
  );
  assert.equal(
    repOf(withoutPharmacy, "101").plannedDoctors,
    rep101.plannedDoctors,
    "removing a pharmacy must not change the doctor count",
  );

  // ── Grades tier the same way Doctor Coverage tiers them ──────────────────────────────────────
  assert.equal(rep101.gradeA, 1, "A+ folds into A");
  assert.equal(rep101.gradeB, 1, "a lower-case 'b' is still grade B");
  assert.equal(rep101.gradeC, 1, "grade C counted");
  assert.equal(
    rep101.gradeA + rep101.gradeB + rep101.gradeC,
    3,
    "the ungraded doctor belongs to no tier — never silently promoted to A",
  );

  // ── Repeat calls collapse to one doctor, and keep the LAST planned date ──────────────────────
  const repeated = doctorOf(result, "101", 1001);
  assert.equal(repeated.plannedCalls, 2, "two plan entries for one doctor are two calls");
  assert.equal(repeated.lastPlanDate, "2026-08-17", "the later plan date wins");
  assert.equal(repeated.lastVisitDate, "2026-08-18", "the later visit date wins");
  assert.equal(repeated.visits, 2, "both visits count");
  assert.equal(repeated.status, "seen", "a planned doctor who was visited reads as seen");

  // ── The vendor's "no contact" sentinels are not people ───────────────────────────────────────
  assert.equal(
    result.doctors.filter((row) => row.contactCrmId === 0 || row.contactCrmId === null).length,
    0,
    "contact id 0 and null are the vendor's unspecified-contact sentinels, never rows on a doctor list",
  );

  // ── Departed agents are gone from BOTH sides ─────────────────────────────────────────────────
  assert.equal(
    result.reps.find((rep) => rep.repKey === "303"),
    undefined,
    "a departed agent with a plan still on file must not appear — otherwise they score 0% forever",
  );
  assert.equal(
    result.doctors.filter((row) => row.contactCrmId === 3001).length,
    0,
    "a departed agent's planned doctors must not reach the board",
  );

  // ── Off-plan: visited, never planned ─────────────────────────────────────────────────────────
  assert.equal(rep101.offPlanDoctors, 2, "9001 and 2001 were visited by rep 101 and are not on rep 101's plan");
  const offPlanShared = doctorOf(result, "101", 2001);
  assert.equal(offPlanShared.status, "off_plan", "a doctor on ANOTHER rep's plan is still off THIS rep's plan");
  assert.equal(offPlanShared.plannedCalls, 0, "an off-plan row has no planned call to point at");
  assert.equal(offPlanShared.lastPlanDate, null, "an off-plan row has no plan date");
  assert.equal(
    offPlanShared.contactName,
    "Laila Hassan",
    "an off-plan doctor's name must be recovered from any plan row for the same contact — the owner's rule is human-readable names, never raw ids",
  );
  assert.equal(
    doctorOf(result, "101", 9001).contactName,
    "Contact 9001",
    "a contact on nobody's plan has no name anywhere in this window — the id form is the honest fallback, not a guess",
  );

  // ── A rep with visits and no plan is COUNTED, not hidden ─────────────────────────────────────
  assert.equal(result.repsWithoutPlan, 1, "agent 404 recorded visits with no plan at all");
  const rep404 = repOf(result, "404");
  assert.equal(rep404.plannedDoctors, 0, "a rep with no plan has no doctor list");
  assert.equal(rep404.coveragePct, 0, "no plan means no coverage — never a divide-by-zero NaN");
  assert.ok(Number.isFinite(rep404.coveragePct), "coverage must always be a finite number");
  assert.equal(rep404.offPlanDoctors, 1, "everyone a planless rep visits is off plan by definition");

  // ── Rep names: directory, then vendor label, then an explicit unmapped marker ────────────────
  assert.equal(rep101.repName, "Mostafa Kamel", "the HR directory name wins over the vendor's own label");
  assert.equal(
    repOf(result, "202").repName,
    "Vendor Label Rep",
    "with no directory entry, the vendor's label is used rather than an id",
  );
  assert.equal(
    rep404.repName,
    "Unmapped CRM agent 404",
    "a rep with no name in either source is named as unmapped — never left as a bare number",
  );

  // ── The same doctor on two reps' plans is two independent rows ───────────────────────────────
  const rep202 = repOf(result, "202");
  assert.equal(rep202.plannedDoctors, 2, "rep 202 plans 2001 and 1003");
  assert.equal(rep202.visitedDoctors, 1, "rep 202 saw 2001");
  assert.equal(rep202.coveragePct, 50, "1 of 2 = 50%");
  assert.equal(
    doctorOf(result, "202", 1003).status,
    "missed",
    "rep 202 never visited 1003 — that rep 101 also planned 1003 is irrelevant, the join is per rep",
  );
  assert.equal(doctorOf(result, "101", 1003).status, "missed", "and rep 101 never visited 1003 either");
  assert.equal(rep202.unverifiedCalls, 0, "statuses 1 and 2 are both verified");

  // ── Unknown specialties are named, with counts ───────────────────────────────────────────────
  assert.deepEqual(
    result.unclassifiedSpecialities,
    [{ contacts: 1, label: "Unlisted Test Specialty" }],
    "a specialty the taxonomy has never seen must be reported BY NAME with its contact count, never silently dropped from the doctor total",
  );

  // ── Totals are the sum of the reps actually on the board ─────────────────────────────────────
  assert.equal(result.totals.reps, 4, "101, 202, 404 and 505 — not the departed 303");
  assert.equal(result.totals.plannedDoctors, 8, "4 + 2 + 0 + 2");
  assert.equal(result.totals.visitedDoctors, 3, "2 + 1 + 0 + 0");
  assert.equal(result.totals.missedDoctors, 5, "2 + 1 + 0 + 2");
  assert.equal(result.totals.coveragePct, 38, "3 of 8");
  assert.equal(result.totals.plannedAccounts, 1, "one pharmacy");
  assert.equal(result.totals.plannedCalls, 11, "7 + 2 + 2");
  assert.equal(result.totals.offPlanDoctors, 3, "2 + 0 + 1 + 0");
  assert.equal(result.totals.unverifiedCalls, 1, "one call still at status New");
  assert.equal(
    result.totals.visitedDoctors + result.totals.missedDoctors,
    result.totals.plannedDoctors,
    "every planned doctor is either seen or missed — there is no third state and none may go missing",
  );

  // ── The latest sync stamp wins ───────────────────────────────────────────────────────────────
  assert.equal(
    result.planSyncedAt,
    "2026-08-21T10:00:00.000Z",
    "the freshest synced_at in the window is what the board reports",
  );
  assert.equal(board({ planRows: [] }).planSyncedAt, null, "an empty mirror reports no sync stamp rather than a fake one");

  // ── Order: the actionable half first ─────────────────────────────────────────────────────────
  const statuses = result.doctors.map((row) => row.status);
  const lastMissed = statuses.lastIndexOf("missed");
  const firstSeen = statuses.indexOf("seen");
  assert.ok(lastMissed >= 0 && firstSeen >= 0, "the fixture must contain both missed and seen rows");
  assert.ok(lastMissed < firstSeen, "never-visited doctors must sort ahead of visited ones without a sort click");

  // ── Filters ──────────────────────────────────────────────────────────────────────────────────
  const missedOnly = board({ filters: { status: "missed" } });
  assert.ok(missedOnly.doctors.length > 0, "the missed filter must return rows");
  assert.ok(
    missedOnly.doctors.every((row) => row.status === "missed"),
    "the status filter must not leak other statuses",
  );
  const accountsOnly = board({ filters: { kind: "hcp" } });
  assert.deepEqual(
    accountsOnly.doctors.map((row) => row.contactCrmId),
    [1005],
    "the kind filter isolates accounts — the pharmacy is the only one in the fixture",
  );
  const searched = board({ filters: { search: "laila" } });
  assert.ok(searched.doctors.length > 0, "search must match a contact name case-insensitively");
  assert.ok(
    searched.doctors.every((row) => row.contactName.toLowerCase().includes("laila")),
    "search must not return unmatched rows",
  );
  const oneRep = board({ filters: { repKey: "202" } });
  assert.equal(oneRep.reps.length, 1, "a rep filter narrows the rep table too, not just the doctor table");
  assert.ok(
    oneRep.doctors.every((row) => row.repKey === "202"),
    "a rep filter must not leak another rep's list",
  );

  // Every rep on the board must be selectable, and by a human-readable name.
  assert.equal(result.repOptions.length, result.reps.length, "every rep on the board must be offered in the rep picker");
  assert.ok(
    result.repOptions.every((option) => option.repName.trim().length > 0),
    "no rep option may be blank",
  );

  // ── Month plumbing ───────────────────────────────────────────────────────────────────────────
  assert.equal(result.month, MONTH, "the board reports the month it was asked for");
  assert.equal(result.monthLabel, "August 2026", "the month label is human-readable");

  runCapTests();
  runDateTests();
  runAccessTests();
  runVocabularyTests();
}

// ── Campaign calls: proof of work that can never become proof of a visit ───────────────────────
function runCampaignTests(result: ReturnType<typeof board>) {
  const rep505 = repOf(result, "505");

  // THE HEADLINE for this rule. A campaign row carries contact id 0 -- it says the rep worked and
  // never which doctor they saw -- so it MUST NOT be able to satisfy a planned call. If it could,
  // coverage would silently start counting work that reached nobody on the list.
  assert.equal(
    rep505.visitedDoctors,
    0,
    "a campaign call names no doctor, so it can never mark a planned doctor as visited -- coverage must stay 0 here",
  );
  assert.equal(rep505.missedDoctors, 2, "both planned doctors are still unreached");
  assert.equal(rep505.coveragePct, 0, "0 of 2");
  assert.equal(
    result.doctors.filter((row) => row.contactCrmId === 0).length,
    0,
    "the campaign sentinel contact must never appear as a doctor row",
  );
  assert.equal(rep505.offPlanDoctors, 0, "a campaign call is not an off-plan doctor visit either");

  // ...but the rep must be visibly WORKING, which is the whole point of the owner's ruling.
  // The load-bearing one: a campaign row naming a doctor who IS on this rep's plan still must not
  // mark them seen. Campaign attendance is not a doctor call, whatever contact the vendor attaches.
  assert.equal(
    doctorOf(result, "505", 5001).status,
    "missed",
    "a CAMPAIGN row naming a planned doctor must NOT mark them visited — only a regular visit can satisfy a planned call",
  );
  assert.equal(doctorOf(result, "505", 5001).visits, 0, "and it must not be counted as a visit either");

  assert.equal(rep505.campaignCalls, 4, "all four campaign calls are counted against the rep");
  assert.equal(result.totals.campaignCalls, 4, "and rolled into the board total");
  assert.equal(
    result.repsAllCampaign,
    1,
    "a rep with a plan, no regular visits and campaign work must be flagged -- their 0% is true and reads as idle",
  );

  // A campaign-only rep has no type-0 row anywhere, so this is the only place a name can come from.
  assert.equal(
    rep505.repName,
    "Campaign Only Rep",
    "a rep whose whole month is campaign work must still be named -- reading only joinable rows would print a bare id",
  );

  // Campaign work does not mean "no plan".
  assert.equal(rep505.hasMeasurablePlan, true, "rep 505 has two planned doctors, so they ARE measurable");
}

// ── A rep with nothing assigned is not a 0% performer ──────────────────────────────────────────
function runNoPlanRankingTests(result: ReturnType<typeof board>) {
  const rep404 = repOf(result, "404");
  assert.equal(rep404.plannedDoctors, 0, "rep 404 was never given a list");
  assert.equal(
    rep404.hasMeasurablePlan,
    false,
    "with nothing planned there is no percentage to compute, and the table prints a marker instead of 0%",
  );

  // THE HEADLINE: worst-first must rank only reps who had something to reach.
  const measurable = result.reps.filter((rep) => rep.hasMeasurablePlan);
  const unmeasurable = result.reps.filter((rep) => !rep.hasMeasurablePlan);
  assert.ok(measurable.length > 0 && unmeasurable.length > 0, "the fixture must contain both kinds of rep");
  const lastMeasurable = result.reps.findLastIndex((rep) => rep.hasMeasurablePlan);
  const firstUnmeasurable = result.reps.findIndex((rep) => !rep.hasMeasurablePlan);
  assert.ok(
    lastMeasurable < firstUnmeasurable,
    "a rep with no plan must sort BELOW every rep who has one -- ranking their arithmetic 0 among real performers presents \"nothing was assigned\" as \"nothing was done\"",
  );
  assert.equal(
    result.reps[0].hasMeasurablePlan,
    true,
    "the worst performer on the board must be a rep who actually had a list to miss",
  );
}

// ── The drill-down cap must never be able to look like a complete list ─────────────────────────
function runCapTests() {
  const big: PlanRow[] = [];
  for (let index = 0; index < REP_DOCTOR_DRILLDOWN_CAP + 100; index += 1) {
    big.push(
      plan({
        agent_crm_id: 1,
        agent_hr_id: "PHX-1",
        contact_crm_id: 10_000 + index,
        contact_name: `Doctor ${index}`,
      }),
    );
  }
  for (let index = 0; index < 10; index += 1) {
    big.push(
      plan({
        agent_crm_id: 2,
        agent_hr_id: "PHX-2",
        contact_crm_id: 90_000 + index,
        contact_name: `Other ${index}`,
      }),
    );
  }
  const wide = buildRepDoctorListsBoard({
    employeeNameByHrId: new Map(),
    excludedAgentCrmIds: [],
    month: MONTH,
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: big,
    visitRows: [],
  });
  assert.equal(wide.doctors.length, REP_DOCTOR_DRILLDOWN_CAP, "the company-wide list is capped");
  assert.equal(
    wide.doctorsTotal,
    REP_DOCTOR_DRILLDOWN_CAP + 110,
    "doctorsTotal must report the TRUE count so a truncated list can never be mistaken for a complete one",
  );
  assert.ok(wide.doctorsTotal > wide.doctors.length, "the board must be able to tell that it truncated");

  // The board's own text tells the user to pick a rep to escape the cap. That has to be true.
  const oneRep = buildRepDoctorListsBoard({
    employeeNameByHrId: new Map(),
    excludedAgentCrmIds: [],
    filters: { repKey: "1" },
    month: MONTH,
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: big,
    visitRows: [],
  });
  assert.equal(
    oneRep.doctors.length,
    REP_DOCTOR_DRILLDOWN_CAP + 100,
    "a single rep's list ships UNCAPPED — the board tells the user to pick a rep to see a whole list, so that must actually work",
  );
  assert.equal(oneRep.doctorsTotal, oneRep.doctors.length, "with one rep selected nothing is truncated");
}

// ── Date discipline: string arithmetic only, never a Date-object round trip ────────────────────
function runDateTests() {
  assert.equal(monthKeyOfDate("2026-08-01"), "2026-08", "the first of the month must not slip to the previous one");
  assert.equal(monthKeyOfDate("2026-08-31"), "2026-08", "the last of the month must not slip to the next one");

  assert.deepEqual(monthBounds("2026-08"), { from: "2026-08-01", to: "2026-08-31" }, "31-day month");
  assert.deepEqual(monthBounds("2026-04"), { from: "2026-04-01", to: "2026-04-30" }, "30-day month");
  assert.deepEqual(monthBounds("2026-02"), { from: "2026-02-01", to: "2026-02-28" }, "February, common year");
  assert.deepEqual(monthBounds("2024-02"), { from: "2024-02-01", to: "2024-02-29" }, "February, leap year");
  assert.deepEqual(monthBounds("2026-01"), { from: "2026-01-01", to: "2026-01-31" }, "January");
  assert.deepEqual(
    monthBounds("2026-12"),
    { from: "2026-12-01", to: "2026-12-31" },
    "December must not roll into the next year",
  );

  const currentMonth = /^\d{4}-(0[1-9]|1[0-2])$/;
  assert.equal(resolveRepDoctorListMonth("2026-08"), "2026-08", "a valid month passes through");
  assert.match(resolveRepDoctorListMonth("2026-13"), currentMonth, "month 13 is not a month — fall back to today's");
  assert.match(resolveRepDoctorListMonth("2026-00"), currentMonth, "month 00 is not a month — fall back to today's");
  assert.match(resolveRepDoctorListMonth("garbage"), currentMonth, "garbage falls back to today's month");
  assert.match(resolveRepDoctorListMonth(undefined), currentMonth, "no month at all falls back to today's month");

  assert.equal(monthLabelOf("2026-01"), "January 2026", "January");
  assert.equal(monthLabelOf("2026-12"), "December 2026", "December");

  assert.equal(gradeTierOf("A+"), "A", "A+ folds into A, exactly as Doctor Coverage tiers it");
  assert.equal(gradeTierOf(" a "), "A", "grades arrive from the vendor with stray casing and whitespace");
  assert.equal(gradeTierOf("b"), "B", "lower-case b is grade B");
  assert.equal(gradeTierOf("C"), "C", "grade C");
  assert.equal(gradeTierOf(null), null, "no grade is not grade A");
  assert.equal(gradeTierOf(""), null, "a blank grade is not grade A");
  assert.equal(gradeTierOf("D"), null, "an unrecognised grade is not silently tiered");
}

// iReports360 was retired on 6 November 2026: the weekly-plan pull (plan-sync.ts) and its manual
// refresh route went with it, and their tests with them. The board above reads the stored plans.

// ── Access: Super Admin only, on the owner's instruction ───────────────────────────────────────
function runAccessTests() {
  assert.deepEqual(
    [...REP_DOCTOR_LISTS_ACCESS_ROLES],
    ["Super Admin"],
    'the owner scoped this board to "admin account only for now" (2026-08-21) — widening it is a decision he has to make, not a refactor',
  );
  assert.equal(canAccessRepDoctorLists({ role: "Super Admin", scope: "self" }), true, "Super Admin may open the board");
  assert.equal(
    canAccessRepDoctorLists({ role: "Employee", scope: "system" }),
    true,
    "a system-scope context is the platform itself, not a person",
  );

  // Each of these can see other CRM boards. None may see this one yet.
  const denied: PhoenixRole[] = [
    "CEO",
    "SFE Manager",
    "Training Manager",
    "HR Advisory",
    "HR Operations",
    "Medical Rep",
    "Employee",
    "National Sales Manager",
  ];
  for (const role of denied) {
    assert.equal(
      canAccessRepDoctorLists({ role, scope: "self" }),
      false,
      `${role} must NOT reach the rep doctor lists — this board names individual reps' misses and is Super-Admin-only until the owner says otherwise`,
    );
  }

  // ── FREQUENCY (KPI 2) ─────────────────────────────────────────────────────────────────────────
  //
  // The owner's rule, verbatim (2026-08-21): "if he tell three times and he visited three times,
  // then this is correct. But if he tell three times and visited four times, then there is here an
  // issue. And if he tell three times and visited two times, he is also an issue."
  //
  // An EXACT match in BOTH directions. That is why every case below pins a specific bucket instead
  // of a threshold, and why no assertion here may ever be relaxed to "met or exceeded".

  // A closed month: everything planned is due, so the rule reduces to plain equality.
  assert.equal(
    frequencyStatusOf({ actual: 3, plannedCalls: 3, plannedToDate: 3 }),
    "on_plan",
    "3 planned and 3 done is the only pass",
  );
  assert.equal(
    frequencyStatusOf({ actual: 4, plannedCalls: 3, plannedToDate: 3 }),
    "over",
    "3 planned and 4 done is a DEVIATION — over-visiting is never a bonus on this board",
  );
  assert.equal(
    frequencyStatusOf({ actual: 2, plannedCalls: 3, plannedToDate: 3 }),
    "under",
    "3 planned and 2 done is a deviation",
  );
  assert.equal(
    frequencyStatusOf({ actual: 0, plannedCalls: 3, plannedToDate: 3 }),
    "missed",
    "planned and never seen is its own bucket — a rep who has not started is not merely 'behind'",
  );
  assert.equal(
    frequencyStatusOf({ actual: 2, plannedCalls: 0, plannedToDate: 0 }),
    "off_plan",
    "somebody who was never on the list",
  );

  // Mid-month the two directions use different denominators, deliberately. See frequencyStatusOf.
  assert.equal(
    frequencyStatusOf({ actual: 2, plannedCalls: 3, plannedToDate: 2 }),
    "on_plan",
    "on schedule mid-month is a pass — next week's call is not late today",
  );
  assert.equal(
    frequencyStatusOf({ actual: 1, plannedCalls: 3, plannedToDate: 2 }),
    "under",
    "behind TODAY's schedule, not the whole month's",
  );
  assert.equal(
    frequencyStatusOf({ actual: 3, plannedCalls: 3, plannedToDate: 2 }),
    "on_plan",
    "finishing the month's plan early is not a deviation",
  );
  assert.equal(
    frequencyStatusOf({ actual: 4, plannedCalls: 3, plannedToDate: 2 }),
    "over",
    "already past the WHOLE month's ask is irreversible, so it is `over` even on day one",
  );
  assert.equal(
    frequencyStatusOf({ actual: 0, plannedCalls: 3, plannedToDate: 0 }),
    "not_due",
    "a doctor planned only for days that have not happened yet is not late",
  );

  // Board level, with the clock INJECTED — a test that reads the real date passes today and fails
  // in September.
  const freqRep = (contactCrmId: number, planDates: string[]) =>
    planDates.map((planDate) =>
      plan({ agent_crm_id: 700, agent_hr_id: null, contact_crm_id: contactCrmId, plan_date: planDate }),
    );
  const freqVisit = (contactCrmId: number, visitDate: string) =>
    visit({ agent_crm_id: 700, agent_hr_id: null, contact_crm_id: contactCrmId, visit_date: visitDate });

  const freq = buildRepDoctorListsBoard({
    asOf: "2026-08-15",
    employeeNameByHrId: new Map(),
    excludedAgentCrmIds: [],
    month: MONTH,
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: [
      ...freqRep(7001, ["2026-08-03", "2026-08-07", "2026-08-11"]), // 3 due, 3 done  -> on_plan
      ...freqRep(7002, ["2026-08-04", "2026-08-05"]), //                 2 due, 1 done  -> under
      ...freqRep(7003, ["2026-08-06"]), //                               1 due, 2 done  -> over
      ...freqRep(7004, ["2026-08-28"]), //                               0 due          -> not_due
      ...freqRep(7005, ["2026-08-02"]), //                               1 due, 0 done  -> missed
    ],
    visitRows: [
      freqVisit(7001, "2026-08-03"),
      freqVisit(7001, "2026-08-07"),
      freqVisit(7001, "2026-08-11"),
      freqVisit(7002, "2026-08-04"),
      freqVisit(7003, "2026-08-06"),
      freqVisit(7003, "2026-08-09"),
      freqVisit(7009, "2026-08-10"), // never planned -> off_plan
    ],
  });

  assert.equal(freq.asOf, "2026-08-15", "the board must report the day it scored to, so a mid-month % is never read as a full-month one");

  const rep700 = repOf(freq, "700");
  assert.equal(rep700.plannedDoctors, 5, "five doctors on the list");
  assert.equal(rep700.notDueDoctors, 1, "the doctor planned for the 28th is not due on the 15th");
  assert.equal(rep700.onPlanDoctors, 1, "only 7001 matched its plan exactly");
  assert.equal(rep700.underDoctors, 1, "7002 is behind schedule");
  assert.equal(rep700.overDoctors, 1, "7003 got two calls against a single planned one");
  assert.equal(rep700.offPlanDoctors, 1, "7009 was visited and never planned");
  assert.equal(
    rep700.frequencyPct,
    25,
    "1 on-plan of 4 DUE doctors = 25%: the not-due doctor is held out of the denominator, and the off-plan doctor never enters it",
  );
  assert.equal(
    rep700.coverageDueDoctors,
    4,
    "the doctor planned for the 28th is not a coverage miss on the 15th — he is not due, exactly as he is not due for frequency",
  );
  assert.equal(
    rep700.coveragePct,
    75,
    "3 reached of 4 DUE doctors = 75%. Dividing by all 5 gives 60% and marks the rep down for a call the plan schedules for a fortnight away; on production that error capped August coverage at 31.5% on the 3rd. Coverage and frequency still disagree loudly here (75 vs 25), which is what this fixture exists to prove",
  );

  const doctorFreq = (contactCrmId: number) => {
    const row = freq.doctors.find((doctor) => doctor.contactCrmId === contactCrmId);
    assert.ok(row, `expected doctor ${contactCrmId} on the board`);
    return row;
  };
  assert.equal(doctorFreq(7004).frequencyStatus, "not_due", "planned for the 28th, scored on the 15th");
  assert.equal(doctorFreq(7004).status, "missed", "coverage still calls it unreached — the two statuses are independent");
  assert.equal(doctorFreq(7005).frequencyStatus, "missed", "due on the 2nd and never seen");
  assert.equal(doctorFreq(7003).frequencyDelta, 1, "one call MORE than the plan asked for, to date");
  assert.equal(doctorFreq(7002).frequencyDelta, -1, "one call short — the sign is what says which way");

  // The grade norm is context and must never move a frequency verdict. 7003 is a grade A doctor
  // planned only once, which is below the configured SP norm — and still `over`, because he was
  // visited twice against a plan of one. If these two ever couple, the KPI stops being plan-based.
  assert.equal(
    doctorFreq(7003).gradeNormCalls,
    DEFAULT_DOCTOR_COVERAGE_NORMS.sp.A,
    "the norm comes from the shared Doctor Coverage config, never a constant local to this board",
  );
  assert.equal(doctorFreq(7003).planBelowGradeNorm, true, "a grade A doctor planned once is under the configured norm");
  assert.equal(
    doctorFreq(7003).frequencyStatus,
    "over",
    "the grade norm must NEVER move the frequency verdict — frequency answers to the PLAN alone (owner, 2026-08-21: the A=3/B=2/C=1 convention 'is not fixed')",
  );
  // Every fixture doctor is grade A, so the SP norm of 2 applies to all five. 7001 is planned 3 and
  // 7002 exactly 2 — neither is below it. 7003, 7004 and 7005 are planned once each.
  assert.equal(
    rep700.underPlannedVsGrade,
    3,
    "three doctors are planned below the grade A norm — a plan-quality signal, counted entirely outside both KPIs",
  );

  // A closed month must collapse to plain exact-match: to-date and full-month become the same thing.
  const closed = buildRepDoctorListsBoard({
    asOf: "2026-09-30",
    employeeNameByHrId: new Map(),
    excludedAgentCrmIds: [],
    month: MONTH,
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: [...freqRep(7004, ["2026-08-28"])],
    visitRows: [],
  });
  assert.equal(closed.asOf, "2026-08-31", "asOf clamps to the month's last day — a closed month is never scored past its end");
  assert.equal(
    repOf(closed, "700").notDueDoctors,
    0,
    "nothing can still be 'not due' once the month is over — the to-date basis only ever affects the live month",
  );
  const closed7004 = closed.doctors.find((doctor) => doctor.contactCrmId === 7004);
  assert.ok(closed7004, "expected doctor 7004 on the closed-month board");
  assert.equal(
    closed7004.frequencyStatus,
    "missed",
    "the doctor who was not-due on the 15th becomes a real miss once August closes — the basis moves, the verdict follows",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OWNER'S THREE WORDS.
//
// on_plan, under and over are ONE axis — how a rep's visit count compares with the plan — and the
// owner gave the vocabulary for it verbatim on 2026-09-02: "change vocab to below exact above".
//
// The pull back towards "On plan / Under plan / Over plan" is strong, because each of those phrases
// reads sensibly on its own. What they cost is the axis: three separate phrases make the reader work
// out that they are one measurement, and they quietly imply that over-visiting is a pass and
// under-visiting a failure — the exact reading the owner's rule refuses, since BOTH are deviations.
//
// Pinned across files rather than within one, because the failure this guards is not a wrong word on
// one board. It is two boards printing different words for the same computed status, which is what
// this codebase looked like until today and which no test could see, because each board was
// internally consistent.
//
// There were three boards for one afternoon. rep-doctor-lists-{board,tables}.tsx were brought onto
// the same words and then deleted the same day: their route had been a redirect stub since the
// owner retired it on 2026-08-28, so the words were being kept consistent on a page nobody could
// open. The two files below are the whole live surface of this axis.
function runVocabularyTests() {
  const AXIS = [
    { status: "on_plan", word: "Exact" },
    { status: "under", word: "Below" },
    { status: "over", word: "Above" },
  ];

  // The KPIs board (/admin/kpis and its portal twin) and the Reps List chip. Both reachable, both
  // reading the same computed status out of rep-doctor-lists.ts.
  const kpis = readFileSync("src/components/crm/kpis-board-view.tsx", "utf8");
  const repsList = readFileSync("src/lib/crm/reps-list-activity.ts", "utf8");

  for (const { status, word } of AXIS) {
    // The KPIs board READS the word out of ACTIVITY_LABEL rather than spelling it again, so the two
    // surfaces cannot drift apart at all — the drift this test was written to detect is now
    // impossible rather than merely caught. What is pinned here is that binding.
    //
    // This replaced a `>${word}</th>` match on 2026-09-03. That match was pinning MARKUP SHAPE, not
    // vocabulary: the KPIs column heads became sortable, the word moved into a <Link> inside the
    // <th>, and the check went red while the board still displayed all three words correctly. A
    // source pin that fails when the file is merely restructured trains the next session to edit
    // the test, which is the one habit this file cannot afford.
    assert.ok(
      kpis.includes(`label={ACTIVITY_LABEL.${status}}`),
      `the KPIs board must head its ${status} column from ACTIVITY_LABEL.${status} — not with its own copy of "${word}"`,
    );
    assert.ok(
      !kpis.includes(`label="${word}"`),
      `the KPIs board must not hardcode "${word}" as a column head — that is how the two boards drifted apart before`,
    );
    assert.ok(
      repsList.includes(`  ${status}: "${word}",`),
      `ACTIVITY_LABEL must map ${status} to "${word}" — the Reps List chip and the KPIs board read the same status and must say the same word`,
    );
  }

  // The retired phrasing, asserted on the MAP ENTRY rather than on the bare phrase: the doc comment
  // above ACTIVITY_LABEL quotes the old wording deliberately, to say what not to go back to, and a
  // naive "the file must not contain 'On plan'" would pin that prose instead of the code.
  for (const stale of ['on_plan: "On plan"', 'under: "Under plan"', 'over: "Over plan"']) {
    assert.ok(!repsList.includes(stale), `the retired frequency wording ${stale} must be gone from the map`);
  }

  // The three words are the axis, and ONLY the axis. missed, not_due, off_plan and untouched are not
  // points on the same scale, and folding them in would say a doctor nobody reached is merely
  // "below". Exact is the only pass — over-visiting is a deviation on the owner's rule — so emerald
  // must never spread to a second status.
  assert.ok(repsList.includes('missed: "Missed"'), "missed keeps its own word — it is not a point on the plan axis");
  assert.ok(repsList.includes('untouched: "No activity"'), "untouched keeps its own word");
  const emerald = repsList.split("\n").filter((line) => line.includes("emerald") && line.includes(":"));
  assert.equal(
    emerald.length,
    1,
    `exactly one status may be green, and it must be the exact match — got: ${emerald.join(" | ")}`,
  );
  assert.ok(emerald[0].trim().startsWith("on_plan:"), `emerald belongs to on_plan alone — got: ${emerald[0]}`);
}

/**
 * COVERAGE IS SCORED AGAINST THE PART OF THE LIST THAT HAS COME DUE.
 *
 * The rule frequency has always followed, applied to the other KPI. A doctor first planned for the
 * 28th cannot have been visited on the 15th, so counting him in the denominator does not measure a
 * rep at all — it measures how far through the month the calendar is.
 *
 * The size of the error, measured on production 2026-09-03: August 2026 finished with 9,812 planned
 * rep-to-doctor pairs, of which 6,720 (68.5%) were still in the future on the morning of 3 August.
 * Dividing by all of them capped that day's coverage at 31.5% no matter what the field force did.
 * September was about to walk into the same wall from the other side — only 2,513 pairs were loaded
 * on the 3rd, so the denominator was set to roughly quadruple over the following fortnight and the
 * percentage to fall by two thirds while nobody's work changed.
 *
 * SCOPE, since 2026-09-04: this is the basis a caller that passes NO window gets — the Reps List
 * drill-down, which reads one rep's own month. The KPIs board moved to the whole-window basis that
 * day at the owner's instruction, and runWindowScoringTests below pins that one. Both are live, and
 * the pair is why each suite now names the caller it speaks for.
 *
 * Two properties are pinned here, and the second is what makes the rule safe to ship:
 *   1. a not-yet-due doctor is out of the denominator, UNLESS he was visited early — otherwise a
 *      rep who ran ahead of his own plan scores over 100%;
 *   2. for a COMPLETE month the denominator is the whole list again, so no closed month moves.
 */
export function runCoverageDueDenominatorTests() {
  const rows = (contactCrmId: number, planDate: string) => [
    plan({ agent_crm_id: 800, agent_hr_id: null, contact_crm_id: contactCrmId, plan_date: planDate }),
  ];
  const planRows = [
    ...rows(8001, "2026-08-03"), // due, and seen        -> in the denominator, in the numerator
    ...rows(8002, "2026-08-04"), // due, never seen      -> in the denominator only
    ...rows(8003, "2026-08-28"), // not due, never seen  -> OUT of the denominator entirely
    ...rows(8004, "2026-08-27"), // not due, seen EARLY  -> back IN, or the ratio passes 100%
  ];
  const visitRows = [
    visit({ agent_crm_id: 800, agent_hr_id: null, contact_crm_id: 8001, visit_date: "2026-08-03" }),
    visit({ agent_crm_id: 800, agent_hr_id: null, contact_crm_id: 8004, visit_date: "2026-08-10" }),
  ];

  const midMonth = repOf(board({ asOf: "2026-08-15", month: MONTH, planRows, visitRows }), "800");
  assert.equal(midMonth.plannedDoctors, 4, "the list itself is four doctors and the board still says so");
  assert.equal(midMonth.visitedDoctors, 2, "8001 and 8004 were reached");
  assert.equal(
    midMonth.coverageDueDoctors,
    3,
    "8003 is planned for the 28th and was never seen, so on the 15th he is not a miss — he is not due. 8004 is equally not due but WAS seen, and dropping him would let a rep who ran ahead of his plan score above 100%",
  );
  assert.equal(
    midMonth.coveragePct,
    67,
    "2 reached of the 3 doctors due so far = 67%. Dividing by all four gives 50% and marks the rep down for a call the plan schedules for a fortnight away",
  );

  // The same rows, scored after the month has closed. Every doctor is now due, the denominator is
  // the whole list again, and the figure is the one it always was — which is why no published month
  // and no historical comparison moves because of this rule.
  const closed = repOf(board({ asOf: "2026-08-31", month: MONTH, planRows, visitRows }), "800");
  assert.equal(
    closed.coverageDueDoctors,
    closed.plannedDoctors,
    "for a complete month the due denominator IS the whole list — the mid-month rule must leave closed months untouched",
  );
  assert.equal(closed.coveragePct, 50, "2 of 4 for the finished month, exactly as before this rule existed");
}

/**
 * THE WINDOW BASIS — the KPIs board's rule since 2026-09-04.
 *
 * The suite above pins the TO-DATE basis, which is what a caller that passes no window still gets
 * and what the Reps List drill-down reads. This one pins the other half: hand the builder a window
 * and it scores that window WHOLE, because the owner asked for the plain fraction plus a period
 * control rather than a denominator that grows under the reader.
 *
 * Owner, 2026-09-04: "you can show that until now, she covered twenty of hundred doctors ... so her
 * coverage is twenty percent. Also, make an option to filter by period and choose, for example, one
 * week, two weeks."
 *
 * Four properties, and the third is the one that was actually broken on the board: the period
 * picker moved the call rate alone, so a week's calls were scored against a whole month's list.
 */
export function runWindowScoringTests() {
  const rows = (contactCrmId: number, planDate: string) => [
    plan({ agent_crm_id: 900, agent_hr_id: null, contact_crm_id: contactCrmId, plan_date: planDate }),
  ];
  const planRows = [
    ...rows(9001, "2026-08-03"), // week 1, seen
    ...rows(9002, "2026-08-04"), // week 1, never seen
    ...rows(9003, "2026-08-28"), // week 4, never seen — still counted by a WHOLE-month window
    ...rows(9004, "2026-08-27"), // week 4, never seen
  ];
  const visitRows = [visit({ agent_crm_id: 900, agent_hr_id: null, contact_crm_id: 9001, visit_date: "2026-08-03" })];

  // 1. THE OWNER'S FRACTION. Scored mid-month, but with the whole month as the window: every one of
  //    the four is in the denominator, including the two the plan schedules for the 27th and 28th.
  //    This is the assertion that fails if anyone reinstates the due-so-far divisor.
  const wholeMonth = repOf(
    board({ asOf: "2026-08-15", month: MONTH, planRows, visitRows, window: { from: "2026-08-01", to: "2026-08-31" } }),
    "900",
  );
  assert.equal(wholeMonth.plannedDoctors, 4, "the window holds all four planned doctors");
  assert.equal(wholeMonth.visitedDoctors, 1, "only 9001 was reached");
  assert.equal(
    wholeMonth.coveragePct,
    25,
    "1 of 4 = 25%. A denominator counting only the doctors already due would read 1 of 2 = 50% and tell the manager a different story about the same month",
  );

  // 2. NOTHING IS EVER 'NOT DUE' INSIDE A WINDOW, which is what puts frequency on the same basis as
  //    coverage rather than quietly excusing next week's doctors.
  assert.equal(wholeMonth.notDueDoctors, 0, "the window is scored whole, so no doctor is held out of frequency");
  assert.equal(
    wholeMonth.coverageDueDoctors,
    wholeMonth.plannedDoctors,
    "with a window the due denominator IS the whole list — the two collapse, and the KPIs board reads plannedDoctors",
  );

  // 3. THE PERIOD ACTUALLY NARROWS THE PLAN SIDE. Week 1 must score week 1's doctors, not the
  //    month's. Until 2026-09-04 getRepDoctorLists took a month and nothing else, so a seven-day
  //    window still divided by all four.
  const weekOne = repOf(
    board({ asOf: "2026-08-15", month: MONTH, planRows, visitRows, window: { from: "2026-08-01", to: "2026-08-07" } }),
    "900",
  );
  assert.equal(weekOne.plannedDoctors, 2, "only 9001 and 9002 are planned inside week 1");
  assert.equal(weekOne.coveragePct, 50, "1 of the 2 doctors week 1 asked for");

  // 4. ROWS OUTSIDE THE WINDOW ARE DROPPED BY THE BUILDER ITSELF, not merely by the caller's query.
  //    A visit in week 4 must not mark a week 1 board, or a narrowed period imports work the window
  //    does not contain.
  const lateVisit = repOf(
    board({
      asOf: "2026-08-15",
      month: MONTH,
      planRows,
      visitRows: [
        ...visitRows,
        visit({ agent_crm_id: 900, agent_hr_id: null, contact_crm_id: 9003, visit_date: "2026-08-28" }),
      ],
      window: { from: "2026-08-01", to: "2026-08-07" },
    }),
    "900",
  );
  assert.equal(lateVisit.visitedDoctors, 1, "the 28 August visit is outside week 1 and must not count toward it");
  assert.equal(lateVisit.plannedDoctors, 2, "and the plan side is still just week 1's two doctors");
}

