import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_DOCTOR_COVERAGE_NORMS } from "../src/lib/crm/doctor-coverage-config.ts";
import type { DoctorCoverageScope } from "../src/lib/crm/doctor-coverage-roles.ts";
import {
  buildKpiCoverageDetail,
  joinKpiRows,
  legacyKpiCoverageDoctors,
  selectKpiCoverageRep,
  type KpiCoverageDoctor,
} from "../src/lib/crm/kpis-board.ts";
import { buildKpisQuery, EMPTY_KPI_FILTERS } from "../src/lib/crm/kpis-filters.ts";
import {
  computePhoenixCoverageDoctors,
  computePhoenixRepKpis,
  type PhoenixRepInput,
  type PhoenixVisit,
} from "../src/lib/crm/phoenix-kpi-rules.ts";
import {
  buildRepDoctorListsBoard,
  REP_DOCTOR_DRILLDOWN_CAP,
  type PlanRow,
  type RepDoctorListsInput,
  type VisitRow,
} from "../src/lib/crm/rep-doctor-lists.ts";

/**
 * The KPIs board's Coverage tab lists — owner, 2026-09-16: "when i press on coverage tab covered dr
 * appear with the last visit date and not covered appears".
 *
 * What each check below guards, because every one of these fails as a PLAUSIBLE screen:
 *
 *   1. The lists must add up to the Covered and Not reached counts on the same row. A list read by a
 *      second rule would name a doctor as "not covered" beside a count that says he was — an
 *      accusation against a named rep that the numbers contradict.
 *   2. A rep's list must be WHOLE. The doctor-list builder caps what it ships at
 *      REP_DOCTOR_DRILLDOWN_CAP; a cut list silently drops doctors from "not covered".
 *   3. A `rep` in the URL can only open somebody already on the viewer's board. Anything else is a
 *      doctor list for a rep outside the viewer's reach.
 *   4. The last visit date and the plan days are the rep's OWN inside the period, never a visit
 *      from outside the window.
 */

const TODAY = "2026-09-16";
const COMPANY: DoctorCoverageScope = { basis: "company", kind: "company", label: "Whole company" };

function read(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ── The legacy rules (live today) ─────────────────────────────────────────────────────────────

function plan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    agent_crm_id: 501,
    agent_hr_id: "PHX-501",
    contact_crm_id: 7001,
    contact_grade: "A",
    contact_name: "Amal Farouk",
    crm_region_name: "Cairo",
    plan_date: "2026-09-02",
    plan_status: 1,
    speciality: "Internal Medicine",
    synced_at: "2026-09-16T06:00:00.000Z",
    ...overrides,
  };
}

function visit(overrides: Partial<VisitRow> = {}): VisitRow {
  return {
    agent_crm_id: 501,
    agent_hr_id: "PHX-501",
    agent_name: "Rep Five Hundred One",
    contact_crm_id: 7001,
    crm_contact_grade: "A",
    speciality: "Internal Medicine",
    visit_date: "2026-09-03",
    visit_type: 0,
    ...overrides,
  };
}

const PLAN_ROWS: PlanRow[] = [
  // Two plan days, one of them saved twice — the list shows each DAY once.
  plan({ contact_crm_id: 7001, plan_date: "2026-09-02" }),
  plan({ contact_crm_id: 7001, plan_date: "2026-09-09" }),
  plan({ contact_crm_id: 7001, plan_date: "2026-09-02" }),
  // Seen before his planned day: still covered.
  plan({ contact_crm_id: 7002, contact_name: "Basem Nour", contact_grade: "B", plan_date: "2026-09-16" }),
  // No name on the plan: the builder calls him "Contact 7003", which the board must never print.
  plan({ contact_crm_id: 7003, contact_name: null, contact_grade: "C", plan_date: "2026-09-06" }),
  // Planned for next week: not covered, and not due yet.
  plan({ contact_crm_id: 7004, contact_name: "Dina Samir", plan_date: "2026-09-24" }),
  plan({ contact_crm_id: 7005, contact_name: "Ehab Lotfy", plan_date: "2026-09-08" }),
  // A pharmacy is not a doctor, visited or not.
  plan({ contact_crm_id: 7006, contact_name: "El Ezaby Pharmacy", speciality: "Pharmacy", plan_date: "2026-09-02" }),
  plan({ agent_crm_id: 502, agent_hr_id: "PHX-502", contact_crm_id: 7101, contact_name: "Farida Mansour", plan_date: "2026-09-03" }),
  plan({ agent_crm_id: 503, agent_hr_id: "PHX-503", contact_crm_id: 7201, contact_name: "Gamal Anwar", plan_date: "2026-09-03" }),
  // Hired after the CRM cutover: no CRM id, keyed by hr id.
  plan({ agent_crm_id: null, agent_hr_id: "PHX-900", contact_crm_id: 7301, contact_name: "Hana Adel", plan_date: "2026-09-01" }),
];

const VISIT_ROWS: VisitRow[] = [
  visit({ contact_crm_id: 7001, visit_date: "2026-09-03" }),
  visit({ contact_crm_id: 7001, visit_date: "2026-09-10" }),
  visit({ contact_crm_id: 7002, crm_contact_grade: "B", visit_date: "2026-09-05" }),
  visit({ contact_crm_id: 7006, speciality: "Pharmacy", visit_date: "2026-09-02" }),
  // Off plan: counted beside coverage, never on either list.
  visit({ contact_crm_id: 7007, visit_date: "2026-09-04" }),
  visit({ agent_crm_id: null, agent_hr_id: "PHX-900", agent_name: "Rep Nine Hundred", contact_crm_id: 7301, visit_date: "2026-09-02" }),
];

function legacyBoard(overrides: Partial<RepDoctorListsInput> = {}) {
  return buildRepDoctorListsBoard({
    employeeNameByHrId: new Map(),
    excludedAgentCrmIds: [],
    month: "2026-09",
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: PLAN_ROWS,
    visitRows: VISIT_ROWS,
    window: { from: "2026-09-01", to: "2026-09-30" },
    uncapped: true,
    ...overrides,
  });
}

const ids = (doctors: readonly KpiCoverageDoctor[]) => doctors.map((doctor) => doctor.contactCrmId);

export function runKpiCoverageLegacyListTests() {
  const board = legacyBoard();
  const rows = joinKpiRows({ callRates: [], docLists: board.reps, scope: COMPANY, workingDays: 5 });

  const rep = rows.find((row) => row.agentCrmId === 501);
  assert.ok(rep, "rep 501 is on the board");
  assert.equal(rep.coverageRepKey, "501", "a rep with a CRM id opens by the doctor-list builder's own key");
  const hrOnly = rows.find((row) => row.agentHrId === "phx-900");
  assert.ok(hrOnly, "the rep with no CRM id is on the board");
  assert.equal(hrOnly.coverageRepKey, "hr:phx-900", "a rep with no CRM id opens by his hr id");

  // 1. THE LISTS ADD UP TO THE ROW — for every rep on the board, not just the fixture's main one.
  for (const row of rows) {
    assert.ok(row.coverageRepKey, `${row.repName} has a key to open his list by`);
    const detail = buildKpiCoverageDetail({
      repKey: row.coverageRepKey,
      repName: row.repName,
      doctors: legacyKpiCoverageDoctors(board.doctors, row.coverageRepKey),
      todayIso: TODAY,
    });
    assert.equal(detail.covered.length, row.visitedDoctors, `${row.repName}: Covered lists exactly the Covered count`);
    assert.equal(detail.notCovered.length, row.missedDoctors, `${row.repName}: Not covered lists exactly the Not reached count`);
  }

  const detail = buildKpiCoverageDetail({
    repKey: "501",
    repName: rep.repName,
    doctors: legacyKpiCoverageDoctors(board.doctors, "501"),
    todayIso: TODAY,
  });
  assert.equal(rep.plannedDoctors, 5, "five planned doctors: the pharmacy is not one of them");
  assert.deepEqual(ids(detail.covered), [7001, 7002], "covered, newest visit first");
  assert.deepEqual(ids(detail.notCovered), [7003, 7005, 7004], "not covered: the late ones by planned day, then the one not due yet");

  // 4. THE LAST VISIT DATE — what the owner asked to see.
  assert.deepEqual(
    detail.covered[0],
    {
      contactCrmId: 7001,
      name: "Amal Farouk",
      speciality: "Internal Medicine",
      grade: "A",
      visits: 2,
      lastVisitDate: "2026-09-10",
      planDates: ["2026-09-02", "2026-09-09"],
      // Before a team goes live the doctor is judged against the PLAN: three calls booked, all due, two made.
      frequency: { basis: "plan", required: 3, dueSoFar: 3, actual: 2, status: "below" },
      due: true,
    },
    "the covered doctor carries his latest visit, his visit count and each planned day once",
  );
  assert.equal(detail.covered[1].lastVisitDate, "2026-09-05", "a visit before the planned day still covers him");

  assert.equal(detail.notCovered[0].name, null, "the builder's 'Contact <id>' stand-in never reaches the screen as a name");
  assert.equal(detail.notCovered[0].lastVisitDate, null, "a doctor not covered has no last visit");
  assert.equal(detail.notCovered[0].visits, 0);
  assert.equal(detail.notCovered[0].due, true, "planned on the 6th, so he is already late on the 16th");
  assert.equal(detail.notCovered[2].due, false, "planned for the 24th, so he is not due yet");

  const everyListed = [...ids(detail.covered), ...ids(detail.notCovered)];
  assert.ok(!everyListed.includes(7006), "the pharmacy is on neither list");
  assert.ok(!everyListed.includes(7007), "the off-plan doctor is on neither list");
  assert.ok(!everyListed.includes(7101), "another rep's doctor is on neither list");

  // 2. A REP'S LIST IS NEVER CUT. The builder ships REP_DOCTOR_DRILLDOWN_CAP rows by default; the KPIs
  //    board asks for all of them, because it picks one rep's doctors out of the whole set.
  const many = Array.from({ length: REP_DOCTOR_DRILLDOWN_CAP + 3 }, (_, index) =>
    plan({ contact_crm_id: 20000 + index, contact_name: `Doctor ${index}` }),
  );
  const capped = legacyBoard({ planRows: many, visitRows: [], uncapped: false });
  assert.equal(capped.doctors.length, REP_DOCTOR_DRILLDOWN_CAP, "without `uncapped` the drill-down cap still applies");
  assert.equal(capped.doctorsTotal, REP_DOCTOR_DRILLDOWN_CAP + 3);
  const whole = legacyBoard({ planRows: many, visitRows: [] });
  assert.equal(whole.doctors.length, REP_DOCTOR_DRILLDOWN_CAP + 3, "`uncapped` ships every doctor row");
  const wholeRep = whole.reps.find((row) => row.repKey === "501");
  assert.ok(wholeRep);
  assert.equal(
    buildKpiCoverageDetail({
      repKey: "501",
      repName: wholeRep.repName,
      doctors: legacyKpiCoverageDoctors(whole.doctors, "501"),
      todayIso: TODAY,
    }).notCovered.length,
    wholeRep.missedDoctors,
    "a rep with more planned doctors than the cap still gets every one of them listed",
  );
}

// ── Which rep's list opens ────────────────────────────────────────────────────────────────────

export function runKpiCoverageRepSelectionTests() {
  const board = legacyBoard();
  const team: DoctorCoverageScope = {
    agentHrIds: ["phx-501", "phx-502", "phx-900"],
    basis: "team",
    kind: "agents",
    label: "Your team",
  };
  const rows = joinKpiRows({ callRates: [], docLists: board.reps, scope: team, workingDays: 5 });
  assert.deepEqual(
    rows.map((row) => row.coverageRepKey).sort(),
    ["501", "502", "hr:phx-900"],
    "the out-of-scope rep never reaches the rows a list can be chosen from",
  );

  assert.equal(selectKpiCoverageRep(rows, "502")?.agentCrmId, 502, "a rep on the board opens by his key");
  assert.equal(selectKpiCoverageRep(rows, "hr:phx-900")?.agentHrId, "phx-900", "so does a rep with no CRM id");
  // 3. THE URL CANNOT WIDEN SCOPE.
  assert.equal(selectKpiCoverageRep(rows, "503"), null, "a rep outside the viewer's reach opens nothing, even by his real key");
  assert.equal(selectKpiCoverageRep(rows, "nobody"), null, "an unknown key opens nothing");
  assert.equal(selectKpiCoverageRep(rows, null), null, "with several reps, nothing opens until one is chosen");

  const one = rows.filter((row) => row.coverageRepKey === "502");
  assert.equal(selectKpiCoverageRep(one, null)?.agentCrmId, 502, "a board of one rep opens his list unasked");
  assert.equal(selectKpiCoverageRep(one, "503")?.agentCrmId, 502, "and a stale `rep` in the URL cannot open anybody else");
  assert.equal(selectKpiCoverageRep([], "502"), null, "an empty board opens nothing");

  // The open rep rides in the URL on the Coverage tab only, so leaving the tab closes the list.
  const onCoverage = new URLSearchParams(
    buildKpisQuery({ month: "2026-09", period: "w2", tab: "coverage", filters: EMPTY_KPI_FILTERS, rep: "hr:phx-900" }),
  );
  assert.equal(onCoverage.get("rep"), "hr:phx-900", "the Coverage tab carries the open rep");
  assert.equal(onCoverage.get("period"), "w2", "beside the period");
  // Frequency carries it too since the 2026-10-14 portal split: the same doctor list, read as visits asked for
  // against visits made.
  assert.equal(
    new URLSearchParams(
      buildKpisQuery({ month: "2026-09", period: "month", tab: "frequency", filters: EMPTY_KPI_FILTERS, rep: "501" }),
    ).get("rep"),
    "501",
    "the Frequency tab carries the open rep",
  );
  for (const tab of ["summary", "call-rate", "am-pm", "pharmacies"]) {
    const query = new URLSearchParams(
      buildKpisQuery({ month: "2026-09", period: "month", tab, filters: EMPTY_KPI_FILTERS, rep: "501" }),
    );
    assert.equal(query.get("rep"), null, `the ${tab} tab never carries a rep`);
  }
  assert.equal(
    buildKpisQuery({ month: "2026-09", period: "month", tab: "coverage", filters: EMPTY_KPI_FILTERS, rep: null }),
    "month=2026-09&tab=coverage",
    "no open rep, no parameter",
  );

  // The board picks the rep from `reps` — the rows left AFTER the scope gate, the medical-reps rule
  // and the filters — never from a wider set, so the URL can only open somebody already on screen.
  assert.match(
    read("src/lib/crm/kpis-board.ts"),
    /const reps = applyKpiFilters\(scopedReps, filters\);[\s\S]*?selectKpiCoverageRep\(reps, input\.coverageDoctors\.rep\)/,
    "getKpisBoard chooses the open rep from the filtered, in-scope rows",
  );

  // The admin page asks for the lists on the Coverage and Frequency tabs — one list, read two ways, as
  // the portal reports read it (owner, 2026-10-29: frequency by brick) — so no other tab ships one.
  assert.match(
    read("app/(admin)/admin/kpis/page.tsx"),
    /coverageDoctors: tab === "coverage" \|\| tab === "frequency" \? \{ rep: one\(params\?\.rep\) \?\? null \} : null/,
    "the admin KPIs page asks for the doctor lists on the Coverage and Frequency tabs only",
  );
  // The portal split the board on 2026-10-14: the doctor lists went with the Coverage and Frequency
  // reports (one list, read two ways), and the consolidated KPIs page ships none at all.
  assert.match(
    read("src/components/crm/portal-kpi-report-page.tsx"),
    /coverageDoctors: report === "call-rate" \? null : \{ rep: one\(params\?\.rep\) \?\? null \}/,
    "the portal Coverage and Frequency reports ask for the doctor lists, and Call Rate does not",
  );
  assert.match(
    read("app/employee-portals/kpis/page.tsx"),
    /coverageDoctors: null/,
    "the portal's consolidated KPIs page ships no doctor list",
  );
  const view = read("src/components/crm/kpis-board-view.tsx");
  assert.match(view, /<CoverageDoctors context=\{context\} detail=\{detail\} surface="desktop" \/>/, "the desktop table shows the open list");
  assert.match(view, /<CoverageDoctors context=\{context\} detail=\{detail\} surface="mobile" \/>/, "and so do the phone cards");

  // A date is one unit on screen. Measured 2026-09-16 at 1024px: with plain spaces a long list of
  // planned days wrapped as "3 Sep · 5" over "Sep · 7 Sep", so no-break spaces hold each date together
  // and keep every separator on the day before it.
  assert.match(
    view,
    /const day = `\$\{Number\(match\[3\]\)\}\\u00A0\$\{MONTHS\[Number\(match\[2\]\) - 1\]\}`;/,
    "a day and its month never split across two lines",
  );
  assert.match(view, /return withYear \? `\$\{day\}\\u00A0\$\{match\[1\]\}` : day;/, "nor a date and its year");
  assert.match(view, /days\.join\("\\u00A0· "\)/, "and a wrapped list of planned days never starts a line on a separator");
}

// ── Ordering and "not due yet" ────────────────────────────────────────────────────────────────

export function runKpiCoverageDetailOrderTests() {
  const doctor = (overrides: Partial<Omit<KpiCoverageDoctor, "due">>): Omit<KpiCoverageDoctor, "due"> => ({
    contactCrmId: 1,
    name: "Doctor",
    speciality: null,
    grade: null,
    visits: 0,
    lastVisitDate: null,
    planDates: ["2026-09-01"],
    ...overrides,
  });
  const detail = buildKpiCoverageDetail({
    repKey: "501",
    repName: "Rep",
    todayIso: TODAY,
    doctors: [
      doctor({ contactCrmId: 3, name: null, visits: 1, lastVisitDate: "2026-09-10" }),
      doctor({ contactCrmId: 2, name: "Zeinab Fawzy", visits: 1, lastVisitDate: "2026-09-10" }),
      doctor({ contactCrmId: 1, name: "Adel Ramzy", visits: 1, lastVisitDate: "2026-09-10" }),
      doctor({ contactCrmId: 4, name: "Mona Galal", visits: 3, lastVisitDate: "2026-09-14" }),
      doctor({ contactCrmId: 6, name: "Tomorrow", planDates: ["2026-09-17"] }),
      doctor({ contactCrmId: 7, name: "Late", planDates: ["2026-09-15", "2026-09-20"] }),
      doctor({ contactCrmId: 8, name: "Today", planDates: ["2026-09-16"] }),
      doctor({ contactCrmId: 9, name: "Undated", planDates: [] }),
    ],
  });
  assert.deepEqual(ids(detail.covered), [4, 1, 2, 3], "newest visit first; a tie goes by name, with an unnamed doctor last");
  assert.deepEqual(
    ids(detail.notCovered).filter((id) => id !== 9),
    [7, 8, 6],
    "late doctors by their first planned day, today's counted as due, the not-yet-due one last",
  );
  const due = new Map(detail.notCovered.map((row) => [row.contactCrmId, row.due]));
  assert.equal(due.get(7), true, "one planned day already passed makes him due, even with a later one ahead");
  assert.equal(due.get(8), true, "a doctor planned for today is due today");
  assert.equal(due.get(6), false, "a doctor planned for tomorrow is not due yet");
  assert.equal(due.get(9), true, "an undated booking is never excused as not due");
}

// ── The Phoenix rules (dormant until the CRM cutover) ─────────────────────────────────────────

function phoenixVisit(contact: number, day: string, ampm: string | null, speciality: string | null = null): PhoenixVisit {
  // Checked-in by default: this file's fixtures test coverage/list ordering, not rule 10's
  // no-check-in split, so every visit here should still earn full credit.
  return {
    contact_crm_id: contact,
    visit_date: day,
    visit_type: 0,
    visit_type_description: null,
    comment: null,
    ampm,
    speciality,
    hasCheckin: true,
  };
}

const PHOENIX_INPUT: PhoenixRepInput = {
  window: { dateFrom: "2026-09-01", dateTo: TODAY, windowEnd: "2026-09-30" },
  month: { start: "2026-09-01", end: "2026-09-30" },
  today: TODAY,
  panel: [
    { contactCrmId: 1, listType: "PM", grade: "A" },
    { contactCrmId: 2, listType: "PM", grade: "B" },
    { contactCrmId: 3, listType: "AM", grade: null },
    { contactCrmId: 5, listType: "Pharmacy", grade: null },
  ],
  planEntries: [
    { contactCrmId: 1, planDate: "2026-09-05", grade: "A", speciality: "Internal Medicine", contactName: "Nour Hassan" },
    { contactCrmId: 1, planDate: "2026-09-12", grade: "A", speciality: "Internal Medicine", contactName: "Nour Hassan" },
    { contactCrmId: 2, planDate: "2026-09-06", grade: "B", speciality: "Pediatrics", contactName: "Omar Said" },
    { contactCrmId: 3, planDate: "2026-09-07", grade: "C", speciality: null, contactName: null },
    { contactCrmId: 5, planDate: "2026-09-08", grade: null, speciality: "Pharmacy", contactName: "Seif Pharmacy" },
    // The catch-all contact is not a doctor.
    { contactCrmId: 100000, planDate: "2026-09-08", grade: null, speciality: null, contactName: "Catch-all" },
    { contactCrmId: 8, planDate: "2026-09-22", grade: "B", speciality: "Cardiology", contactName: "Rana Aly" },
  ],
  visits: [
    phoenixVisit(1, "2026-09-05", "PM"),
    phoenixVisit(1, "2026-09-09", "PM"),
    phoenixVisit(3, "2026-09-07", "AM"),
    phoenixVisit(5, "2026-09-08", null, "Pharmacy"),
  ],
};

export function runKpiCoveragePhoenixListTests() {
  const kpis = computePhoenixRepKpis(PHOENIX_INPUT);
  const doctors = computePhoenixCoverageDoctors(PHOENIX_INPUT);
  assert.equal(kpis.coverage.planned, 4, "four doctors planned: the pharmacy and the catch-all are out");

  // 1. THE LISTS ADD UP TO THE PHOENIX COUNTS.
  const detail = buildKpiCoverageDetail({ repKey: "hr:phx-1", repName: "Rep", doctors, todayIso: TODAY });
  assert.equal(detail.covered.length, kpis.coverage.visited, "Covered lists exactly coverage.visited");
  assert.equal(detail.notCovered.length, kpis.coverage.missed, "Not covered lists exactly coverage.missed");
  assert.deepEqual(ids(detail.covered), [1, 3], "newest visit first");
  assert.deepEqual(ids(detail.notCovered), [2, 8], "the late doctor first, the one planned for the 22nd last");
  assert.equal(detail.notCovered[1].due, false, "the 22nd has not come yet");

  assert.deepEqual(
    doctors.find((row) => row.contactCrmId === 1),
    {
      contactCrmId: 1,
      name: "Nour Hassan",
      speciality: "Internal Medicine",
      grade: "A",
      visits: 2,
      lastVisitDate: "2026-09-09",
      planDates: ["2026-09-05", "2026-09-12"],
      // Grade A asks for three visits in the month and he has had two: the Frequency report's reading.
      frequency: { basis: "grade", required: 3, dueSoFar: 3, actual: 2, status: "below" },
    },
    "the covered doctor carries the name from the plan, the last visit, both planned days and the frequency verdict",
  );
  assert.equal(doctors.find((row) => row.contactCrmId === 3)?.name, null, "no name on the plan stays null, never an id");
  assert.equal(doctors.find((row) => row.contactCrmId === 3)?.grade, "C", "the plan's grade stands in when the list has none");

  // 3b. THE FREQUENCY REPORT READS THE SAME DOCTORS. Its verdicts add up to the Frequency count on the
  //     row: at norm is `met`, and below or not visited is `below`, because the list and the percentage
  //     come out of the one norm function.
  const verdicts = (status: string) => doctors.filter((row) => row.frequency.status === status).length;
  assert.equal(verdicts("at-norm"), kpis.frequency.met, "the doctors at norm are the Frequency count's met");
  assert.equal(
    verdicts("below") + verdicts("not-visited"),
    kpis.frequency.below,
    "the doctors below norm, seen or not, are the Frequency count's below",
  );
  assert.equal(doctors.find((row) => row.contactCrmId === 2)?.frequency.status, "not-visited", "grade B asks for two and he had none");
  assert.equal(doctors.find((row) => row.contactCrmId === 3)?.frequency.status, "ungraded", "an AM doctor graded C has no norm");

  // 4. A NARROWER PERIOD NARROWS THE LIST. Week 6-12: doctor 1's visit on the 5th is outside it, and
  //    so is his plan day on the 5th.
  const week: PhoenixRepInput = {
    ...PHOENIX_INPUT,
    window: { dateFrom: "2026-09-06", dateTo: "2026-09-12", windowEnd: "2026-09-12" },
  };
  const weekKpis = computePhoenixRepKpis(week);
  const weekDoctors = computePhoenixCoverageDoctors(week);
  assert.equal(weekDoctors.length, weekKpis.coverage.planned, "the week lists exactly the week's planned doctors");
  assert.equal(weekDoctors.filter((row) => row.visits > 0).length, weekKpis.coverage.visited);
  const weekOne = weekDoctors.find((row) => row.contactCrmId === 1);
  assert.equal(weekOne?.visits, 1, "only the visit inside the week counts");
  assert.equal(weekOne?.lastVisitDate, "2026-09-09");
  assert.deepEqual(weekOne?.planDates, ["2026-09-12"], "only the planned day inside the week is shown");
  assert.ok(!weekDoctors.some((row) => row.contactCrmId === 8), "a doctor planned after the week is not on its list");
}
