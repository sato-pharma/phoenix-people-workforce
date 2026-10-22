import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeCallRate, countCallRateWorkingDays, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import { NO_CRM_CUTOVER } from "../src/lib/crm/cutover.ts";
import { kpiFlagHint, kpiFlagLabel } from "../src/lib/crm/kpis-filters.ts";
import { type StartedRepWindow } from "../src/lib/crm/phoenix-team-starts.ts";
import {
  computePhoenixRepKpis,
  dailyFollowUp,
  employedWorkingDays,
  kpiRulesFor,
  phoenixRuleRepKeys,
  phoenixVisitHasCheckin,
  type PhoenixPanelContact,
  type PhoenixPlanEntry,
  type PhoenixVisit,
} from "../src/lib/crm/phoenix-kpi-rules.ts";

/**
 * Phase 6 — the Phoenix KPI rules the owner approved on 2026-09-13.
 *
 * September 2026 starts on a Tuesday, so its Saturday-to-Wednesday days are 1, 2, 5-9, 12-16,
 * 19-23 and 26-30: 22 working days. Thursday the 10th is "today" in the running-month case.
 */

const MONTH = { start: "2026-09-01", end: "2026-09-30" };

function visit(contact: number | null, day: string, extra: Partial<PhoenixVisit> = {}): PhoenixVisit {
  return {
    contact_crm_id: contact,
    visit_date: day,
    visit_type: 0,
    visit_type_description: null,
    comment: null,
    ampm: null,
    speciality: null,
    // Checked-in by default, so every existing fixture keeps testing full-credit visits. Rule 10's
    // own test overrides this to false on the specific visits it means to exclude.
    hasCheckin: true,
    ...extra,
  };
}

function cutoverRules() {
  assert.deepEqual(kpiRulesFor(NO_CRM_CUTOVER, "2026-09-01", "2026-09-30"), { rules: "legacy", note: null }, "no cutover date keeps every screen on the old rules");
  const setting = { cutoverDate: "2026-10-01", vendorSyncRetiredAt: null };
  assert.equal(kpiRulesFor(setting, "2026-10-01", "2026-10-31").rules, "phoenix", "a period starting on the cutover day uses the new rules");
  assert.deepEqual(kpiRulesFor(setting, "2026-09-01", "2026-09-30"), { rules: "legacy", note: null }, "a period wholly before the cutover keeps the old rules");
  const split = kpiRulesFor({ cutoverDate: "2026-09-15", vendorSyncRetiredAt: null }, "2026-09-01", "2026-09-30");
  assert.equal(split.rules, "legacy", "a period split by the cutover keeps the old rules whole");
  assert.match(split.note ?? "", /2026-09-15/, "and the board says why");
}

function workingDays() {
  assert.equal(countCallRateWorkingDays(MONTH.start, MONTH.end), 22);
  assert.equal(employedWorkingDays({ dateFrom: MONTH.start, dateTo: MONTH.end }), 22);
  assert.equal(
    employedWorkingDays({ dateFrom: MONTH.start, dateTo: MONTH.end, hireDate: "2026-09-12" }),
    15,
    "a mid-month joiner counts only the days from his hire date",
  );
  assert.equal(
    employedWorkingDays({ dateFrom: MONTH.start, dateTo: MONTH.end, lastWorkingDate: "2026-09-09" }),
    7,
    "a leaver counts only the days up to his last working date",
  );
  assert.equal(
    employedWorkingDays({ dateFrom: MONTH.start, dateTo: MONTH.end, holidays: new Set(["2026-09-06", "2026-09-10"]) }),
    21,
    "a public holiday on a Sunday removes a day; one on a Thursday removes nothing",
  );
}

function followUp() {
  assert.deepEqual(dailyFollowUp({ target: 10, monthWorkingDays: 22, visitsSoFar: 100, workingDaysLeft: 12 }), {
    target: 10,
    monthWorkingDays: 22,
    visitsSoFar: 100,
    workingDaysLeft: 12,
    neededPerDay: 10,
    reached: false,
  });
  const done = dailyFollowUp({ target: 2, monthWorkingDays: 22, visitsSoFar: 50, workingDaysLeft: 4 });
  assert.equal(done.neededPerDay, 0);
  assert.equal(done.reached, true);
  assert.equal(dailyFollowUp({ target: 10, monthWorkingDays: 22, visitsSoFar: 5, workingDaysLeft: 0 }).neededPerDay, null);
}

function pmPassesAtTenWithNoBand() {
  const panel: PhoenixPanelContact[] = [{ contactCrmId: 1, listType: "PM", grade: "A" }];
  const oneDay = (count: number) =>
    computePhoenixRepKpis({
      window: { dateFrom: "2026-09-05", dateTo: "2026-09-05", windowEnd: "2026-09-05" },
      month: MONTH,
      today: "2026-10-05",
      panel,
      planEntries: [],
      visits: Array.from({ length: count }, () => visit(1, "2026-09-05")),
    });
  assert.equal(oneDay(8).pm.meets, false, "8 PM visits a day no longer passes: the 8-12 band is gone");
  assert.equal(oneDay(10).pm.meets, true, "10 PM visits a day passes");
  assert.equal(oneDay(14).pm.meets, true, "above 10 still passes");
}

function oneRep() {
  const panel: PhoenixPanelContact[] = [
    { contactCrmId: 1, listType: "PM", grade: "A" },
    { contactCrmId: 2, listType: "PM", grade: "B" },
    { contactCrmId: 3, listType: "AM", grade: "A" },
    { contactCrmId: 4, listType: "PM", grade: null },
    { contactCrmId: 5, listType: "Pharmacy", grade: null },
    { contactCrmId: 6, listType: "AM", grade: "C" },
    { contactCrmId: 6, listType: "PM", grade: "C" },
  ];
  const planEntries: PhoenixPlanEntry[] = [
    { contactCrmId: 1, planDate: "2026-09-05", grade: "A", speciality: null },
    { contactCrmId: 2, planDate: "2026-09-06", grade: "B", speciality: null },
    { contactCrmId: 3, planDate: "2026-09-07", grade: "A", speciality: null },
    { contactCrmId: 4, planDate: "2026-09-08", grade: null, speciality: null },
    { contactCrmId: 5, planDate: "2026-09-08", grade: null, speciality: "Pharmacy" },
    { contactCrmId: 6, planDate: "2026-09-20", grade: "C", speciality: null },
    { contactCrmId: 7, planDate: "2026-09-09", grade: "B", speciality: null },
  ];
  const visits: PhoenixVisit[] = [
    // The list decides AM or PM: a PM-list doctor flagged AM is still a PM visit.
    visit(1, "2026-09-05", { ampm: "AM" }),
    visit(1, "2026-09-06", { ampm: "PM" }),
    visit(1, "2026-09-07", { ampm: "PM" }),
    visit(1, "2026-09-09", { ampm: "PM" }),
    // Thursday: off the call-rate calendar, still a visit to the doctor.
    visit(1, "2026-09-10", { ampm: "PM" }),
    visit(2, "2026-09-06", { ampm: "PM" }),
    visit(3, "2026-09-07", { ampm: "PM" }),
    visit(4, "2026-09-08", { ampm: "PM" }),
    visit(5, "2026-09-08", { speciality: "Pharmacy" }),
    visit(99, "2026-09-08", { ampm: "PM" }),
    visit(null, "2026-09-08", { visit_type: -8, ampm: "PM" }),
    // A contact on both lists: the visit's own flag settles it.
    visit(6, "2026-09-09", { ampm: "AM" }),
  ];
  const kpis = computePhoenixRepKpis({
    window: { dateFrom: MONTH.start, dateTo: "2026-09-10", windowEnd: MONTH.end },
    month: MONTH,
    today: "2026-09-10",
    panel,
    planEntries,
    visits,
  });

  assert.equal(kpis.workingDays, 7);
  // Every visit in this fixture is checked-in (the `visit()` default): rule 2 credits it regardless
  // of GPS being merely evidence, not the gate. `regularNoCheckinBucket` below covers the no-checkin case.
  assert.equal(kpis.pm.visits, 6, "PM counts every checked-in regular visit to a PM-list doctor");
  assert.equal(kpis.am.visits, 2, "AM counts the AM-list account flagged PM, and the both-lists doctor flagged AM");
  assert.equal(kpis.pharmacy.visits, 1);
  assert.equal(
    kpis.campaignVisits,
    2,
    "campaign is its own line, and a regular visit to a contact on no list of the rep's counts on it (owner: unplanned is now called campaign)",
  );
  assert.ok(!("unplannedVisits" in kpis), "there is no separate unplanned line any more");
  assert.equal(kpis.regularNoCheckin, 0, "every visit in this fixture is checked-in, so the no-checkin line is empty");
  assert.equal(kpis.pm.meets, false);
  assert.equal(kpis.pm.target, 10);
  assert.equal(kpis.am.target, 2);

  assert.deepEqual(kpis.coverage, { planned: 6, visited: 5, missed: 1, pct: 83, plannedOffList: 1 }, "coverage: planned doctors in the period with a visit, pharmacies out");

  assert.deepEqual(
    kpis.frequency,
    { judged: 5, met: 3, below: 2, ungraded: 1, pct: 60 },
    "frequency: A 3 met with 5 visits (extra is fine), B 2 below with 1, AM A 1 met, C 1 met, ungraded left out",
  );

  assert.ok(kpis.followUp, "the running month has a follow-up");
  assert.equal(kpis.followUp.pm.visitsSoFar, 6, "visits so far run through yesterday, on working days");
  assert.equal(kpis.followUp.pm.workingDaysLeft, 15, "days left run from today to the month's end");
  assert.equal(kpis.followUp.pm.neededPerDay, 14.27, "(10 x 22 - 6) / 15");
  assert.equal(kpis.followUp.am.neededPerDay, 2.8, "(2 x 22 - 2) / 15");

  const joiner = computePhoenixRepKpis({
    window: { dateFrom: MONTH.start, dateTo: "2026-09-10", windowEnd: MONTH.end },
    month: MONTH,
    today: "2026-09-10",
    hireDate: "2026-09-05",
    panel,
    planEntries,
    visits,
  });
  assert.equal(joiner.workingDays, 5, "a joiner's rate divides by the days he was employed");
  assert.equal(joiner.followUp?.pm.monthWorkingDays, 20);

  const closed = computePhoenixRepKpis({
    window: { dateFrom: MONTH.start, dateTo: MONTH.end, windowEnd: MONTH.end },
    month: MONTH,
    today: "2026-10-04",
    panel,
    planEntries,
    visits,
  });
  assert.equal(closed.followUp, null, "a finished month has no follow-up");
}

/**
 * Rule 10 (owner, 2026-09-20): a Regular visit with no matching GPS check-in earns no call-rate,
 * coverage or frequency credit, but it is never relabelled Campaign — it is counted on its own line.
 */
function regularNoCheckinBucket() {
  const panel: PhoenixPanelContact[] = [
    { contactCrmId: 1, listType: "PM", grade: "A" },
    { contactCrmId: 2, listType: "PM", grade: "A" },
  ];
  const planEntries: PhoenixPlanEntry[] = [
    { contactCrmId: 1, planDate: "2026-09-05", grade: "A", speciality: null },
    { contactCrmId: 2, planDate: "2026-09-06", grade: "A", speciality: null },
  ];
  const visits: PhoenixVisit[] = [
    // No matching GPS check-in: real activity, but it earns no credit anywhere and is never Campaign.
    visit(1, "2026-09-05", { ampm: "PM", hasCheckin: false }),
    // A second, checked-in visit to a different PM doctor — proves the two never blend.
    visit(2, "2026-09-06", { ampm: "PM", hasCheckin: true }),
  ];
  const kpis = computePhoenixRepKpis({
    window: { dateFrom: MONTH.start, dateTo: "2026-09-10", windowEnd: MONTH.end },
    month: MONTH,
    today: "2026-09-10",
    panel,
    planEntries,
    visits,
  });

  assert.equal(kpis.regularNoCheckin, 1, "the no-checkin visit is counted on its own line");
  assert.equal(kpis.pm.visits, 1, "only the checked-in visit earns PM call-rate credit");
  assert.equal(kpis.campaignVisits, 0, "a no-checkin regular visit is never relabelled Campaign");
  assert.deepEqual(
    kpis.coverage,
    { planned: 2, visited: 1, missed: 1, pct: 50, plannedOffList: 0 },
    "the no-checkin doctor is planned but not credited as visited",
  );
  assert.deepEqual(
    kpis.frequency,
    { judged: 2, met: 0, below: 2, ungraded: 0, pct: 0 },
    "neither doctor reaches the grade-A PM norm of 3: the no-checkin visit banks no frequency credit either",
  );
}

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

/**
 * A Phoenix CRM visit is its own check-in under the Phoenix rules too (re-audit, 2026-10-22). The
 * check-in door serves no iReports360 check-in on a started rep's Phoenix days, so the matcher alone
 * found none: 2,291 Phoenix visits in the week of 17 Oct, 0 credited, and every started rep scored 0.
 */
function phoenixVisitIsItsOwnCheckin() {
  assert.equal(phoenixVisitHasCheckin({ source: "phoenix", crm_visit_id: -42 }, false), true, "a Phoenix visit needs no vendor check-in");
  assert.equal(phoenixVisitHasCheckin({ source: null, crm_visit_id: -7 }, false), true, "a negative visit id is a Phoenix row too");
  assert.equal(phoenixVisitHasCheckin({ source: "ireports360", crm_visit_id: 9001 }, false), false, "a vendor visit with no check-in stays unproved");
  assert.equal(phoenixVisitHasCheckin({ source: "ireports360", crm_visit_id: 9001 }, true), true, "a vendor visit with a matched check-in is proved");

  // End to end through the rules: a started rep's Phoenix visits, none of which any vendor check-in matches.
  const kpis = computePhoenixRepKpis({
    window: { dateFrom: MONTH.start, dateTo: "2026-09-10", windowEnd: MONTH.end },
    month: MONTH,
    today: "2026-09-10",
    panel: [{ contactCrmId: 1, listType: "PM", grade: "A" }],
    planEntries: [{ contactCrmId: 1, planDate: "2026-09-05", grade: "A", speciality: null }],
    visits: [visit(1, "2026-09-05", { ampm: "PM", hasCheckin: phoenixVisitHasCheckin({ source: "phoenix" }, false) })],
  });
  assert.equal(kpis.pm.visits, 1, "the Phoenix visit earns its PM call");
  assert.equal(kpis.regularNoCheckin, 0, "and is never parked on the no-check-in line");
  assert.equal(kpis.coverage.visited, 1, "its doctor is covered");

  // The loader must select the two columns the rule reads, and must ask the rule — not the matcher alone.
  const loader = read("src/lib/crm/phoenix-kpi-data.ts");
  assert.match(loader, /const VISIT_COLUMNS =\s*"[^"]*\bsource,crm_visit_id"/, "the KPI loader selects source and crm_visit_id");
  assert.match(loader, /hasCheckin: phoenixVisitHasCheckin\(\s*row,/, "the KPI loader decides rule 10 through phoenixVisitHasCheckin");
}

/**
 * Rule 2 on the two call-rate boards that already existed: under the Phoenix rules every submitted
 * regular visit counts and GPS is evidence only. Before the cutover the headline stays "proved".
 */
function callRateBasisAndWording() {
  // Saturday 2026-08-01, one working day: ten PM visits, four of them with a GPS check-in.
  const visits: VisitForCallRate[] = Array.from({ length: 10 }, (_, index) => ({
    agent_crm_id: 100,
    agent_hr_id: "hr-1",
    agent_name: "Test Rep",
    ampm: "PM",
    comment: null,
    contact_crm_id: 5000 + index,
    crm_save_date: "2026-08-01T11:00:00",
    speciality: null,
    visit_date: "2026-08-01",
    visit_type: 0,
    visit_type_description: "Regular Visit",
  }));
  visits.push({ ...visits[0], contact_crm_id: 0, visit_type: -8, visit_type_description: "Campaign (Prospection)" });
  const checkins = visits.slice(0, 4).map((row) => ({ agent_crm_id: 100, contact_crm_id: row.contact_crm_id, check_date: "2026-08-01T10:55:00" }));
  const window = { dateFrom: "2026-08-01", dateTo: "2026-08-01" };

  const legacy = computeCallRate(visits, checkins, window).reps[0];
  assert.equal(legacy.pm.verified + legacy.pm.unverified, 10, "ten regular PM visits, campaign apart");
  assert.equal(legacy.pm.verifiedRate, 4, "before the cutover the headline is the GPS-proved count");

  const report = computeCallRate(visits, checkins, { ...window, basis: "submitted" });
  const phoenix = report.reps[0];
  assert.equal(report.basis, "submitted");
  assert.equal(phoenix.pm.verifiedRate, 10, "under the Phoenix rules every submitted regular visit counts; GPS is evidence only");
  assert.equal(phoenix.pm.attainmentPct, 100, "ten PM visits in one working day meets the PM target of 10");
  assert.equal(phoenix.pm.verified, 4, "the proof buckets are unchanged, so the GPS evidence still shows");

  const service = read("src/lib/crm/call-rate-service.ts");
  assert.match(service, /kpiRulesFor\(cutover, input\.dateFrom, input\.dateTo\)/, "the call-rate service reads the cutover for its own period");
  assert.match(service, /basis: rules\.rules === "phoenix" \? "submitted" : "verified"/, "only the Phoenix rules switch the basis");

  const repsPlans = read("src/lib/crm/reps-plans.ts");
  assert.match(
    repsPlans,
    /rowBasis === "submitted" \? session\.verified \+ session\.unverified : session\.verified/,
    "the Reps Plans totals count the same visits the per-rep headline counts",
  );
  assert.match(
    repsPlans,
    /const rowBasis = row\.basis \?\? basis;/,
    "and they count it PER REP, because one board holds both rules at once since the switch went per team",
  );
  for (const bucket of ["am", "pm", "pharmacy"] as const) {
    assert.ok(
      repsPlans.includes(`${bucket}Headline += headlineOfRow(row.${bucket}, rowBasis)`),
      `the ${bucket} total accumulates each row at that row's own basis`,
    );
  }
  assert.match(repsPlans, /totalsOf\([\s\S]{0,80}report\.workingDays, rateBasis\)/, "the totals are given the report's basis");

  assert.equal(kpiFlagLabel("perfect-frequency", "phoenix"), "Every graded doctor at their grade norm", "frequency passes at the grade norm, not exactly as planned");
  assert.notEqual(kpiFlagLabel("perfect-frequency"), kpiFlagLabel("perfect-frequency", "phoenix"), "before the cutover the old label stays");
  assert.match(kpiFlagHint("below-pm-target", "phoenix"), /Submitted/, "the PM hint names submitted visits under the Phoenix rules");
}

/**
 * The per-team switch: WHO is scored by the Phoenix rules, when one board holds both rules at once.
 *
 * Owner, 2026-10-07: "I want everything to be switched gradually based on the go live teams" — Delta (1)
 * from Saturday 3 October, Cairo and Giza from the 10th, everybody else still on the vendor. So the
 * decision cannot be a board-level one: `kpiRulesFor` answers for the COMPANY and `phoenixRuleRepKeys`
 * names the people, one row at a time.
 */
function perTeamRuleReps() {
  const windows: StartedRepWindow[] = [
    // Delta (1), live since 3 October and still live.
    { hrIdKey: "b-155", agentCrmId: 1166, from: "2026-10-03", until: null },
    // Cairo, live from the 10th.
    { hrIdKey: "b-200", agentCrmId: 2001, from: "2026-10-10", until: null },
    // A seat someone left on the 6th: his window is half-open, so the 6th itself is already out.
    { hrIdKey: "b-300", agentCrmId: 3001, from: "2026-10-03", until: "2026-10-06" },
    // A row the roster could not key — it must never reach a Set that is looked up by key.
    { hrIdKey: null, agentCrmId: 4001, from: "2026-10-03", until: null },
  ];

  const october = phoenixRuleRepKeys(windows, "2026-10-01");
  assert.equal(october.size, 0, "a period that STARTS before every team start is scored by the old rules, whole");

  const fromTheFourth = phoenixRuleRepKeys(windows, "2026-10-04");
  assert.deepEqual([...fromTheFourth].sort(), ["b-155", "b-300"], "only the teams already live on the period's first day");

  const fromTheSixth = phoenixRuleRepKeys(windows, "2026-10-06");
  assert.deepEqual([...fromTheSixth], ["b-155"], "the window is half-open: `until` is the first day NOT counted");

  const fromTheTenth = phoenixRuleRepKeys(windows, "2026-10-10");
  assert.deepEqual([...fromTheTenth].sort(), ["b-155", "b-200"], "Cairo joins on its own start Saturday");

  assert.equal(phoenixRuleRepKeys(windows, "not-a-day").size, 0, "an unreadable period start names nobody, never everybody");
  assert.ok(!fromTheTenth.has(""), "a row with no roster key is dropped, never keyed as empty");

  // A team start must NOT reach the company-wide decision. Folding it in there would return "phoenix"
  // for the whole board and score an unstarted rep by rules his own app does not follow yet.
  assert.equal(kpiRulesFor.length, 3, "kpiRulesFor stays a company-wide question — no per-team argument");
  assert.deepEqual(
    kpiRulesFor(NO_CRM_CUTOVER, "2026-10-10", "2026-10-31"),
    { rules: "legacy", note: null },
    "with the company-wide cutover still unset, a team start does not flip the whole board",
  );

  // Both boards read the per-rep set, and each tests ONE row against it rather than switching wholesale.
  const service = read("src/lib/crm/call-rate-service.ts");
  assert.match(service, /phoenixRuleRepKeys\(startedWindows, input\.dateFrom\)/, "the call-rate service builds the per-rep set for its own period");
  const board = read("src/lib/crm/kpis-board.ts");
  assert.match(board, /phoenixRuleRepKeys\(startedWindows, range\.dateFrom\)/, "the KPIs board builds it for the window it is drawing");
  assert.match(
    board,
    /hasNoGpsFeed\(rate, rate\.basis \?\? basis\)/,
    "the no-GPS-feed note asks the ROW's own basis — under the Phoenix rules a rep with no GPS is not flagged",
  );

  // The per-rep basis is what the rate itself carries, so a mixed board cannot be read with one rule.
  const callRate = read("src/lib/crm/call-rate.ts");
  assert.match(callRate, /basis \?\? rep\.basis \?\? "verified"/, "an explicit basis wins, else the row's own stamp, else the old rules");
}

export function runPhoenixKpiRulesTests() {
  cutoverRules();
  workingDays();
  followUp();
  pmPassesAtTenWithNoBand();
  oneRep();
  regularNoCheckinBucket();
  callRateBasisAndWording();
  perTeamRuleReps();
  phoenixVisitIsItsOwnCheckin();
}
