import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { computeCallRate, type RepCallRate, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import { scopeCallRateRows } from "../src/lib/crm/call-rate-service.ts";
import {
  checkinAgentKey,
  indexCheckinsByAgentContactDay,
  pickCheckinForVisit,
  type CheckinForMatch,
} from "../src/lib/crm/checkin-match.ts";
import { DEFAULT_DOCTOR_COVERAGE_NORMS } from "../src/lib/crm/doctor-coverage-config.ts";
import { joinKpiRows } from "../src/lib/crm/kpis-board.ts";
import { type PlanSummary } from "../src/lib/crm/plan-board.ts";
import {
  applyCheckinFilter,
  applyVisitFilter,
  buildAgentCrmOrHrIdOrFilter,
  buildParticipantOrFilter,
  isCrmDoubleVisitRow,
  type VisitFilterableQuery,
} from "../src/lib/crm/reads.ts";
import { repDayPersonKey, resolveRepDayCheckinOwnerKeys } from "../src/lib/crm/rep-day.ts";
import { buildRepVisits, type VisitForRepDrilldown } from "../src/lib/crm/rep-visits.ts";
import { indexWeekPlansByRep } from "../src/lib/crm/reps-weekly-plans-board.ts";
import {
  buildRepDoctorListsBoard,
  repDoctorListRepKey,
  type PlanRow,
  type RepDoctorListRepRow,
  type VisitRow,
} from "../src/lib/crm/rep-doctor-lists.ts";

/**
 * A rep hired after the CRM cutover has NO CRM id. His native visits, check-ins and plan rows carry
 * `agent_hr_id` and a NULL `agent_crm_id`, and every read that keyed a rep on `agent_crm_id` alone
 * either lost him or merged him with every other new hire. These pin the hr-id fallback on each of
 * those keys — and that a rep WITH a CRM id keeps exactly the key he always had.
 */

type Call = [method: string, ...args: unknown[]];

function recordingQuery(calls: Call[]): VisitFilterableQuery {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  const query: VisitFilterableQuery = {
    eq: record("eq"),
    gte: record("gte"),
    ilike: record("ilike"),
    in: record("in"),
    is: record("is"),
    lte: record("lte"),
    neq: record("neq"),
    not: record("not"),
    or: record("or"),
  };
  return query;
}

function nativeVisit(overrides: Partial<VisitForCallRate> = {}): VisitForCallRate {
  return {
    agent_crm_id: null,
    agent_hr_id: "N-900",
    agent_name: "Same Name",
    ampm: "PM",
    comment: null,
    contact_crm_id: 555,
    crm_save_date: "2026-09-20T11:00:00",
    speciality: null,
    visit_date: "2026-09-20",
    visit_type: 0,
    visit_type_description: "Regular Visit",
    ...overrides,
  };
}

function callRate(agentCrmId: number | null, agentHrId: string | null, agentName: string): RepCallRate {
  const slice = (verified: number, target: number) => ({
    attainmentPct: Math.round((verified / 5 / target) * 100),
    campaign: 0,
    target,
    total: verified,
    totalRate: verified / 5,
    unverified: 0,
    verified,
    verifiedRate: verified / 5,
  });
  return {
    agentCrmId,
    agentHrId,
    agentName,
    am: slice(4, 2),
    campaignOnlyDays: 0,
    campaignOverLimitDays: [],
    campaignShare: 0,
    pm: slice(20, 10),
    pharmacy: { attainmentPct: null, campaign: 0, target: null, total: 0, totalRate: 0, unverified: 0, verified: 0, verifiedRate: 0 },
    unspecified: 0,
    awaitingValidation: 0,
    workingDays: 5,
  };
}

function docList(agentCrmId: number | null, agentHrId: string | null, repName: string): RepDoctorListRepRow {
  return {
    actualCalls: 30,
    agentCrmId,
    agentHrId,
    campaignCalls: 0,
    coverageDueDoctors: 100,
    coveragePct: 70,
    frequencyPct: 39,
    gradeA: 0,
    gradeB: 0,
    gradeC: 0,
    hasMeasurablePlan: true,
    missedDoctors: 30,
    notDueDoctors: 0,
    offPlanDoctors: 0,
    onPlanDoctors: 39,
    overDoctors: 5,
    plannedAccounts: 0,
    plannedCalls: 100,
    plannedCallsToDate: 100,
    plannedDoctors: 100,
    plannedUnclassified: 0,
    repKey: repDoctorListRepKey(agentCrmId, agentHrId) ?? "",
    repName,
    underDoctors: 26,
    underPlannedVsGrade: 0,
    unverifiedCalls: 0,
    visitedDoctors: 70,
  };
}

function plan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    agent_crm_id: null,
    agent_hr_id: "N-900",
    contact_crm_id: 7001,
    contact_grade: "A",
    contact_name: "Shared Doctor",
    crm_region_name: "Cairo",
    plan_date: "2026-08-03",
    plan_status: 1,
    speciality: "Internal Medicine",
    synced_at: "2026-08-21T09:00:00.000Z",
    ...overrides,
  };
}

function boardVisit(overrides: Partial<VisitRow> = {}): VisitRow {
  return {
    agent_crm_id: null,
    agent_hr_id: "N-900",
    agent_name: "Same Name",
    contact_crm_id: 7001,
    crm_contact_grade: "A",
    speciality: "Internal Medicine",
    visit_date: "2026-08-03",
    visit_type: 0,
    ...overrides,
  };
}

function weekPlan(agentCrmId: number | null, agentHrId: string | null, crmPlanId: number): PlanSummary {
  return {
    // The plan type says number; a plan filed in Phoenix by a rep with no CRM id carries null.
    agentCrmId: agentCrmId as number,
    agentHrId,
    contacts: 3,
    crmPlanId,
    entries: 3,
    firstDate: "2026-09-19",
    kind: "weekly",
    lastDate: "2026-09-24",
    month: null,
    repName: "",
    status: 1,
    syncedAt: null,
    year: null,
  };
}

function drilldownVisit(overrides: Partial<VisitForRepDrilldown> = {}): VisitForRepDrilldown {
  return {
    ...nativeVisit(),
    contact_name: "Dr Native",
    crm_contact_grade: "A",
    crm_region_id: null,
    crm_region_name: null,
    crm_visit_id: -9001,
    customer_name: null,
    double_hr_id: null,
    double2_hr_id: null,
    double2_name: null,
    double_name: null,
    ...overrides,
  };
}

export function runCrmNewHireKeyingTests() {
  // ── C3: the check-in matcher keys a no-CRM-id rep by his hr id ───────────────────────────────
  {
    const checkins: CheckinForMatch[] = [
      { agent_crm_id: null, agent_hr_id: "n-900", contact_crm_id: 555, check_date: "2026-09-20T10:55:00" },
      { agent_crm_id: null, agent_hr_id: "N-900", contact_crm_id: 0, check_date: "2026-09-20T10:55:00" },
    ];
    const index = indexCheckinsByAgentContactDay(checkins);
    const matched = pickCheckinForVisit(
      { agentCrmId: null, agentHrId: "N-900", contactCrmId: 555, visitDay: "2026-09-20", crmSaveDate: "2026-09-20T11:00:00" },
      index,
    );
    assert.ok(matched, "C3: a native visit with no CRM id must find its own check-in by hr id (any casing)");
    assert.equal(
      pickCheckinForVisit(
        { agentCrmId: null, agentHrId: "N-901", contactCrmId: 555, visitDay: "2026-09-20", crmSaveDate: "2026-09-20T11:00:00" },
        index,
      ),
      null,
      "C3: a DIFFERENT new hire at the same doctor that day must not borrow that check-in",
    );
    assert.equal(
      pickCheckinForVisit(
        { agentCrmId: null, agentHrId: "N-900", contactCrmId: 0, visitDay: "2026-09-20", crmSaveDate: "2026-09-20T11:00:00" },
        index,
      ),
      null,
      "C3: contact 0 is the no-contact placeholder and never matches",
    );
    assert.equal(checkinAgentKey(100, "X-1"), "100", "C3: a rep with a CRM id keeps the plain CRM-id key");
    assert.equal(checkinAgentKey(null, " N-5 "), "hr:n-5", "C3: the hr fallback key is canonical (trimmed, lower-cased)");
    assert.equal(checkinAgentKey(null, "  "), null, "C3: no identity at all is no key");
  }

  // ── C4: the call rate groups a no-CRM-id rep by hr id, never by name ─────────────────────────
  {
    const report = computeCallRate(
      [nativeVisit({ agent_hr_id: "N-900" }), nativeVisit({ agent_hr_id: "N-901", contact_crm_id: 556 })],
      [],
      { dateFrom: "2026-09-19", dateTo: "2026-09-20" },
    );
    assert.equal(report.reps.length, 2, "C4: two new hires who share a spelling are two reps, not one merged by name");
    assert.deepEqual(
      report.reps.map((rep) => rep.agentHrId).sort(),
      ["N-900", "N-901"],
      "C4: each rep carries his own hr id",
    );
    const sameRep = computeCallRate(
      [nativeVisit({ agent_hr_id: "N-900", agent_name: "Spelling One" }), nativeVisit({ agent_hr_id: "n-900", agent_name: "Spelling Two", contact_crm_id: 556 })],
      [],
      { dateFrom: "2026-09-19", dateTo: "2026-09-20" },
    );
    assert.equal(sameRep.reps.length, 1, "C4: one hr id under two name spellings is ONE rep");
  }

  // ── C5: the KPIs join keeps a no-CRM-id rep on ONE row ───────────────────────────────────────
  {
    const company = { basis: "company", kind: "company", label: "Whole company" } as const;
    const joined = joinKpiRows({
      callRates: [callRate(null, "N-900", "New Rep")],
      docLists: [docList(null, "n-900", "New Rep")],
      scope: company,
      workingDays: 5,
    });
    assert.equal(joined.length, 1, "C5: a new hire's call rate and doctor list must join to one row, not half a rep twice");
    assert.equal(joined[0].pmVerified, 20, "C5: the call-rate half survived the join");
    assert.equal(joined[0].coveragePct, 70, "C5: and so did the doctor-list half");

    const twoHires = joinKpiRows({
      callRates: [callRate(null, "N-900", "New Rep"), callRate(null, "N-901", "New Rep")],
      docLists: [],
      scope: company,
      workingDays: 5,
    });
    assert.equal(twoHires.length, 2, "C5: two different new hires stay two rows");

    const vendorRep = joinKpiRows({
      callRates: [callRate(11, "A-12", "Rep One")],
      docLists: [docList(11, null, "Rep One")],
      scope: company,
      workingDays: 5,
    });
    assert.equal(vendorRep.length, 1, "C5: a rep with a CRM id still joins on it, hr id or not");
  }

  // ── C2: the doctor-lists board keys a no-CRM-id rep by hr id ─────────────────────────────────
  {
    const board = buildRepDoctorListsBoard({
      employeeNameByHrId: new Map([
        ["N-900", "New Hire One"],
        ["N-901", "New Hire Two"],
      ]),
      excludedAgentCrmIds: [303],
      month: "2026-08",
      norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
      planRows: [plan({ agent_hr_id: "N-900" }), plan({ agent_hr_id: "n-901" })],
      visitRows: [boardVisit({ agent_hr_id: "N-900" })],
    });
    const one = board.reps.find((rep) => rep.repKey === "hr:n-900");
    const two = board.reps.find((rep) => rep.repKey === "hr:n-901");
    assert.ok(one && two, "C2: two new hires planning the same doctor are two reps, not one merged null-CRM rep");
    assert.equal(board.reps.filter((rep) => rep.agentCrmId == null).length, 2, "C2: and no third merged row");
    assert.equal(one.plannedDoctors, 1, "C2: each holds his own list");
    assert.equal(one.visitedDoctors, 1, "C2: his native visit counts against his own list");
    assert.equal(two.visitedDoctors, 0, "C2: and never against the other hire's list");
    assert.equal(two.missedDoctors, 1, "C2: the other hire's doctor stays missed");
    assert.equal(one.repName, "New Hire One", "C2: the directory names him");
    assert.equal(repDoctorListRepKey(101, "PHX-101"), "101", "C2: a rep with a CRM id keeps the plain CRM-id key");
  }

  // ── F1b: doubleOnly counts a partner who has only an hr id ───────────────────────────────────
  {
    const calls: Call[] = [];
    applyVisitFilter(recordingQuery(calls), { doubleOnly: true }, "");
    assert.deepEqual(
      calls,
      [["or", "and(source.eq.phoenix,double_hr_id.not.is.null),and(source.neq.phoenix,double_crm_id.not.is.null,double_crm_id.neq.0)"]],
      "F1b: a double visit is a real partner CRM id OR, on a Phoenix native row only, a resolved partner hr id — a vendor row's stray hr id is not a partner (audit finding A); the crm-id half names source.neq.phoenix so Postgres tests a Phoenix row before its joins (infrastructure audit, 2026-10-28)",
    );

    // Employee 360's visit read must carry the native marker, or isCrmDoubleVisitRow keeps the vendor
    // rule and a new hire's confirmed double visits never count as "doubles received".
    const employee360 = readFileSync("src/lib/employee-360/service.ts", "utf8");
    // The list became several concatenated literals when the Phoenix field set was appended on
    // 2026-10-07, so `columns: "...source..."` as ONE literal no longer matches. What matters is that
    // `source` is a select ITEM of this read, which is what the comma-bounded form pins. Since
    // 2026-11-05 the list is one constant, shared by the person's own record and an earlier one of
    // theirs (continuous-service.ts), and the own-record read must select it.
    const visitColumnsStart = employee360.indexOf("const EMPLOYEE_360_VISIT_COLUMNS =");
    assert.ok(visitColumnsStart >= 0, "Employee 360's visit columns are the one EMPLOYEE_360_VISIT_COLUMNS constant");
    const visitColumns = employee360.slice(visitColumnsStart, employee360.indexOf(";\n", visitColumnsStart));
    const ownVisitRead = employee360.slice(employee360.indexOf("async function fetchOwnRecordVisitRows"));
    assert.match(
      ownVisitRead.slice(0, ownVisitRead.indexOf("\n}")),
      /columns: EMPLOYEE_360_VISIT_COLUMNS,/,
      "F1b: Employee 360's own visit read selects the shared column list",
    );
    assert.match(
      visitColumns,
      /,source,/,
      "F1b: Employee 360 selects `source`, so a native double visit with an hr-id-only partner counts",
    );
  }

  // ── C6: the participant and check-in identity filters union CRM ids with hr ids ──────────────
  {
    const union = buildParticipantOrFilter({ participantCrmIds: [5], participantHrIds: ["N-900"] });
    assert.ok(
      union?.startsWith("agent_crm_id.in.(5),double_crm_id.in.(5),double2_crm_id.in.(5),agent_hr_id.in.("),
      "C6: the crm half comes first, and it asks BOTH partner slots",
    );
    assert.ok(union?.includes('"N-900"') && union.includes('"n-900"'), "C6: the hr half carries the casing variants, quoted");
    assert.ok(
      union?.includes(",double_hr_id.in.(") && union.includes(",double2_hr_id.in.("),
      "C6: agent OR either partner slot on the hr side too",
    );
    assert.equal(
      buildParticipantOrFilter({ participantCrmIds: [5] }),
      "agent_crm_id.in.(5),double_crm_id.in.(5),double2_crm_id.in.(5)",
      "C6: a crm-only caller reads the agent and both partner slots",
    );

    const hrOnly: Call[] = [];
    applyVisitFilter(recordingQuery(hrOnly), { participantHrIds: ["N-900"] }, "");
    assert.equal(hrOnly.length, 1, "C6: an hr-only participant filter is one or");
    assert.equal(hrOnly[0][0], "or");

    const closed: Call[] = [];
    applyVisitFilter(recordingQuery(closed), { participantHrIds: ["   "] }, "");
    assert.deepEqual(closed, [["in", "agent_crm_id", []]], "C6: a blank hr id list fails CLOSED, never an unfiltered read");

    assert.equal(buildAgentCrmOrHrIdOrFilter({ crmIds: [], hrIds: [" "] }), null, "C6: no usable check-in identity is no rows");
    assert.ok(
      buildAgentCrmOrHrIdOrFilter({ crmIds: [7], hrIds: ["N-900"] })?.startsWith("agent_crm_id.in.(7),agent_hr_id.in.("),
      "C6: check-ins union CRM ids with hr ids",
    );
    const checkinClosed: Call[] = [];
    applyCheckinFilter(
      recordingQuery(checkinClosed) as unknown as Parameters<typeof applyCheckinFilter>[0],
      { agentCrmOrHrIds: { crmIds: [], hrIds: [] } },
      "",
    );
    assert.deepEqual(checkinClosed, [["in", "agent_crm_id", []]], "C6: the check-in identity filter fails CLOSED too");
  }

  // ── C7: the rep-day drill-down recognises a no-CRM-id rep and his borrowed check-ins ─────────
  {
    assert.equal(repDayPersonKey(1234, "A-7"), "1234", "C7: a vendor row is still the plain CRM-id comparison");
    assert.equal(repDayPersonKey(0, null), null, "C7: the 0 sentinel names nobody");
    assert.equal(repDayPersonKey(null, "N-900"), "hr:n-900", "C7: a native row with no CRM id is known by hr id");
    const owners = resolveRepDayCheckinOwnerKeys("hr:n-950", [
      { agentID: null, agentHrId: "N-900", agentName: "New Hire One (Cairo / Pedia)" },
      { agentID: 1483, agentHrId: "A-20", agentName: "Vendor Rep" },
    ]);
    assert.equal(owners.get("hr:n-950"), null, "C7: self owns his own check-ins");
    assert.equal(owners.get("hr:n-900"), "New Hire One", "C7: a submitter with no CRM id can lend his check-ins");
    assert.equal(owners.get("1483"), "Vendor Rep", "C7: a vendor submitter keeps his CRM-id key");

    // The IO reads that moved to hr ids. Source pins, because each is a live database read.
    const workload = readFileSync("src/lib/crm/visit-workload.ts", "utf8");
    assert.match(workload, /\{ participantHrIds: \[hrId\] \}/, "C7: outstation workload reads a no-CRM-id person by hr id");
    assert.doesNotMatch(
      workload,
      /return emptyWorkload\(dates, "This rep has no CRM id, so their visits can't be matched\.", "unmapped"\)/,
      "C7: outstation workload no longer stops at a missing CRM id",
    );
    const repDay = readFileSync("src/lib/crm/rep-day.ts", "utf8");
    assert.match(repDay, /buildParticipantHrIdOrFilter\(\[self\.hrId\]\)/, "C7: the rep day reads a no-CRM-id rep by hr id");
    assert.doesNotMatch(repDay, /if \(!rep\.crmId\) return/, "C7: the rep day no longer returns an empty day for a missing CRM id");
    const partners = readFileSync("src/lib/crm/visit-partners.ts", "utf8");
    assert.match(partners, /participantHrIds: toQueryHr\.map/, "C7: visit partners walk a no-CRM-id person by hr id");
    const planActuals = readFileSync("src/lib/crm/plan-actuals-data.ts", "utf8");
    assert.match(planActuals, /\{ agentHrIds: \[agentHrId as string\] \}/, "C7: plan actuals read a no-CRM-id rep by hr id");
    const coverage = readFileSync("src/lib/crm/sfe-doctor-coverage.ts", "utf8");
    assert.match(coverage, /agentHrIds: scopedAgentHrIds/, "C7: a scoped coverage board reads a no-CRM-id rep's plan by hr id");
  }

  // ── F2: the call-rate service scopes a no-CRM-id rep by hr id, and selects the check-in hr id ─
  {
    const visits = [
      nativeVisit({ agent_hr_id: "N-900" }),
      nativeVisit({ agent_hr_id: "N-901" }),
      nativeVisit({ agent_crm_id: 11, agent_hr_id: "A-12" }),
    ];
    const checkins = [
      { agent_crm_id: null, agent_hr_id: "n-900", contact_crm_id: 555, check_date: "2026-09-20T10:55:00" },
      { agent_crm_id: null, agent_hr_id: "N-901", contact_crm_id: 555, check_date: "2026-09-20T10:55:00" },
      { agent_crm_id: 11, agent_hr_id: null, contact_crm_id: 555, check_date: "2026-09-20T10:55:00" },
    ];
    const newHire = scopeCallRateRows(visits, checkins, { agentHrId: " N-900 " });
    assert.equal(newHire.visits.length, 1, "F2: a rep with no CRM id gets his own visits by hr id");
    assert.equal(newHire.checkins.length, 1, "F2: and his own check-ins, whatever their casing");
    assert.equal(
      computeCallRate(newHire.visits, newHire.checkins, { dateFrom: "2026-09-19", dateTo: "2026-09-20" }).reps[0]?.pm.verified,
      1,
      "F2: so his visit is proved by his own check-in",
    );
    const vendor = scopeCallRateRows(visits, checkins, { agentCrmId: 11, agentHrId: "N-900" });
    assert.deepEqual(
      [vendor.visits.length, vendor.checkins.length, vendor.visits[0]?.agent_crm_id],
      [1, 1, 11],
      "F2: a CRM id still scopes on the CRM id alone",
    );
    const everyone = scopeCallRateRows(visits, checkins, {});
    assert.deepEqual([everyone.visits.length, everyone.checkins.length], [3, 3], "F2: no rep named is the whole field force");
    const service = readFileSync("src/lib/crm/call-rate-service.ts", "utf8");
    assert.match(service, /const CHECKIN_COLUMNS = "agent_crm_id,agent_hr_id,/, "F2: the service selects the check-in hr id the matcher needs");
  }

  // ── F3: the rep drill-down proves a no-CRM-id rep's visit with his own check-in ──────────────
  // A row that is not Phoenix CRM's own (a positive id) is matched by the hr-id key, to its OWN
  // check-in only. A Phoenix CRM row (the negative id the unified view gives it) needs none: since
  // 2026-10-02 it is its own check-in, because Phoenix shows a visit's location back as no check-in row
  // at all (src/lib/crm/phoenix-team-starts.ts, tests/phoenix-crm-visits-everywhere.test.ts).
  {
    const own = buildRepVisits(
      [drilldownVisit({ crm_visit_id: 9001 })],
      [{ agent_crm_id: null, agent_hr_id: "n-900", contact_crm_id: 555, check_date: "2026-09-20T10:55:00" }],
      { territoryIndex: new Map() },
    );
    assert.equal(own.rows[0]?.standing, "verified", "F3: the drill-down matches a visit with no CRM id to its check-in by hr id");
    const borrowed = buildRepVisits(
      [drilldownVisit({ crm_visit_id: 9001 })],
      [{ agent_crm_id: null, agent_hr_id: "N-901", contact_crm_id: 555, check_date: "2026-09-20T10:55:00" }],
      { territoryIndex: new Map() },
    );
    assert.equal(borrowed.rows[0]?.standing, "unverified", "F3: and never to another new hire's check-in");
    const phoenix = buildRepVisits([drilldownVisit()], [], { territoryIndex: new Map() });
    assert.equal(phoenix.rows[0]?.standing, "verified", "F3: a Phoenix CRM row is its own check-in — it borrows nobody's and needs none");
  }

  // ── F4: the weekly-plans tab finds the plans of a rep with no CRM id ─────────────────────────
  {
    const plansFor = indexWeekPlansByRep([
      weekPlan(11, "A-12", 1),
      weekPlan(null, "N-900", -2),
      weekPlan(null, "N-901", -3),
    ]);
    assert.deepEqual(
      plansFor({ agentCrmId: null, hrId: "n-900" }).map((plan) => plan.crmPlanId),
      [-2],
      "F4: a rep with no CRM id finds his own plan by canonical hr id, and not the other hire's",
    );
    assert.deepEqual(
      plansFor({ agentCrmId: 11, hrId: "A-12" }).map((plan) => plan.crmPlanId),
      [1],
      "F4: a rep with a CRM id keeps his numeric match",
    );
    assert.deepEqual(plansFor({ agentCrmId: null, hrId: "N-902" }), [], "F4: a rep who filed nothing still has no plan");
    const board = readFileSync("src/lib/crm/reps-weekly-plans-board.ts", "utf8");
    assert.match(board, /agentHrId: selectedPlan\.agentHrId,/, "F4: the plan actuals read is given the hr id");
    assert.doesNotMatch(
      board,
      /selectedPlan\.agentCrmId != null && selectedPlan\.firstDate/,
      "F4: the plan actuals read is no longer gated on a CRM id",
    );
    assert.match(
      board,
      /selectedPlan\.agentCrmId \?\? \{ agentCrmId: null, hrId: selectedPlan\.agentHrId \}/,
      "F4: a rep with no CRM id gets his contact list by hr id",
    );
  }

  // ── F5: a native double visit whose partner has only an hr id is a double visit ──────────────
  {
    assert.equal(
      isCrmDoubleVisitRow({ double_crm_id: null, double_hr_id: "N-900", source: "phoenix", visit_type: 0 }),
      true,
      "F5: a partner hired after the cutover (hr id, no CRM id) makes a native double visit",
    );
    assert.equal(
      isCrmDoubleVisitRow({ crm_visit_id: -42, double_crm_id: null, double_hr_id: "N-900", visit_type: -8 }),
      true,
      "F5: a native row is also known by its negative visit id",
    );
    assert.equal(
      isCrmDoubleVisitRow({ crm_visit_id: 9001, double_crm_id: null, double_hr_id: "mgr-2", source: "ireports360", visit_type: 0 }),
      false,
      "F5: a vendor row's stray hr id beside no partner is still not a double visit (audit finding A)",
    );
    assert.equal(
      isCrmDoubleVisitRow({ double_crm_id: 0, double_hr_id: "mgr-3", visit_type: 0 }),
      false,
      "F5: a row with no source marker keeps the vendor rule",
    );
    assert.equal(
      isCrmDoubleVisitRow({ double_crm_id: null, double_hr_id: "  ", source: "phoenix", visit_type: 0 }),
      false,
      "F5: a blank hr id is no partner",
    );
    assert.equal(
      isCrmDoubleVisitRow({ double_crm_id: null, double_hr_id: "N-900", source: "phoenix", visit_type: -11 }),
      false,
      "F5: a meeting is still not fieldwork",
    );
  }

  // ── F6/F7: the KPI data and the master table already reach a no-CRM-id rep ───────────────────
  {
    const kpiData = readFileSync("src/lib/crm/phoenix-kpi-data.ts", "utf8");
    assert.match(
      kpiData,
      /scanPlanEntries\(input\.month\.start, input\.month\.end\)/,
      "F6: the KPI plan read stays unfiltered — an hr-id filter would drop the vendor plan rows whose hr id is blank",
    );
    assert.match(kpiData, /canonicalHrIdKey\(hrId\) \?\? \(crmId != null/, "F6: and keys each plan row on its hr id first");
    const master = readFileSync("src/lib/crm/master.ts", "utf8");
    assert.match(
      master,
      /agentHrId: typeof row\.agent_hr_id === "string" \? row\.agent_hr_id : null,/,
      "F7: the master table hands the check-in matcher the hr id",
    );
    assert.match(master, /NEAREST_CHECKIN_COLUMNS =\s*"[^"]*\bagent_hr_id\b/, "F7: and selects it on the check-ins");
  }
}
