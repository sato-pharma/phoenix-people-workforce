import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  doubleVisitorViews,
  keepDoubleVisitors,
  perDoubleVisitorRows,
  visitLogPerDoubleVisitor,
} from "../src/lib/double-visit-analytics/chain-visitors.ts";
import { filterLogRows, ALL } from "../src/lib/double-visit-analytics/report-filters.ts";
import {
  buildManagerMrPairs,
  buildScopedDoubleVisitDashboardCore,
  doubleVisitPrivateCalendarItemsFromRows,
  filterRowsForAccess,
  type DoubleVisitDbRow,
} from "../src/lib/double-visit-analytics/service.ts";
import type { DoubleVisitLogEntry, DoubleVisitReportRow } from "../src/lib/double-visit-analytics/types.ts";
import { buildDoubleVisitHistory } from "../src/lib/employee-360/deep-service.ts";
import type { VisitRow } from "../src/lib/employee-360/service.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "../src/lib/hr-id.ts";

/**
 * 🔴 A CHAIN VISIT IS ONE VISIT, AND IT IS IN BOTH MANAGERS' RECORDS (owner, 2026-10-08):
 * "the rep submits the chain visit and chooses, for example, two managers; it is counted one visit for
 * the rep and for the two managers — one visit for the three, so the three have this visit in their
 * records, but the one who submitted is the medical rep."
 *
 * Phoenix CRM saves it as ONE row with two manager slots. The fixture is the production shape of
 * 6 October 2026: a rep, her District Manager in slot 1 and the Regional Manager in slot 2, on two
 * visits, plus one plain double visit by the District Manager alone the next day. Every assertion
 * drives the real builders — the rep receives each visit ONCE, and the second manager is counted on
 * every manager-side figure exactly as the first.
 */

type Access = Parameters<typeof filterRowsForAccess>[1];

function person(input: Partial<EmployeeDirectoryRow> & { hrId: string; jobTitle: string }): EmployeeDirectoryRow {
  return {
    areaName: "Giza 1",
    crmId: null,
    departmentName: null,
    displayName: input.fullName ?? input.hrId,
    employmentStatus: "active",
    fullName: input.fullName ?? input.hrId,
    lineId: 1,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    pendingManagerReplacementForHrId: null,
    positionTitle: input.jobTitle,
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

const EMPLOYEES: EmployeeDirectoryRow[] = [
  person({ hrId: "H-1", fullName: "Regional Head", jobTitle: "Regional Sales Manager" }),
  person({ hrId: "D-1", fullName: "District Lead", jobTitle: "District Sales Manager", managerHrId: "H-1" }),
  person({ hrId: "R-1", fullName: "Rep Probation", jobTitle: "Medical Representative", managerHrId: "D-1" }),
  person({ hrId: "CEO-1", fullName: "Chief", jobTitle: "CEO" }),
];

function row(input: {
  date: string;
  id: string;
  visitor: string;
  visitor2?: string;
  ampm?: "AM" | "PM";
}): DoubleVisitDbRow {
  const name = (hrId: string) => EMPLOYEES.find((employee) => employee.hrId === hrId)?.displayName ?? hrId;
  return {
    activity_date: input.date,
    area_name: "Giza 1",
    double_visitor_hr_id: input.visitor,
    double_visitor_name: name(input.visitor),
    ...(input.visitor2 ? { double_visitor2_hr_id: input.visitor2, double_visitor2_name: name(input.visitor2) } : {}),
    from_phoenix: true,
    id: input.id,
    line_name: "Pedia",
    period: input.ampm ?? "AM",
    source_record_id: `-${input.id}`,
    source_type: "ireports360",
    speciality: "Pediatrics",
    visit_count: 1,
    visit_type: 0,
    visit_type_description: "Regular",
    visited_employee_hr_id: "R-1",
    visited_employee_name: "Rep Probation",
    visited_employee_status: "active_mapped",
  };
}

function rows(): DoubleVisitDbRow[] {
  return [
    row({ date: "2026-10-06", id: "c1", visitor: "D-1", visitor2: "H-1" }),
    row({ date: "2026-10-06", id: "c2", visitor: "D-1", visitor2: "H-1", ampm: "PM" }),
    row({ date: "2026-10-07", id: "p1", visitor: "D-1" }),
  ];
}

function access(role: string, hrId: string): Access {
  return { hrId, loginId: hrId, role, scope: "line", source: "session" } as unknown as Access;
}

const ck = (id: string) => canonicalHrIdKey(id) as string;

function runHelperTests() {
  const [chain] = rows();
  const views = doubleVisitorViews(chain);
  assert.deepEqual(
    views.map((view) => [view.double_visitor_hr_id, view.double_visitor2_hr_id]),
    [["D-1", "H-1"], ["H-1", "D-1"]],
    "each manager on a chain visit gets his own view of it: himself first, the other manager beside him",
  );
  assert.equal(doubleVisitorViews(rows()[2]).length, 1, "a plain double visit has one view");
  assert.equal(perDoubleVisitorRows(rows()).length, 5, "two chain visits × two managers + one plain visit");

  const withoutSecond = keepDoubleVisitors(chain, (hrId) => hrId !== "H-1");
  assert.equal(withoutSecond?.double_visitor_hr_id, "D-1", "dropping the second manager keeps the first");
  assert.equal(withoutSecond?.double_visitor2_hr_id ?? null, null, "and takes the second off the row");
  const withoutFirst = keepDoubleVisitors(chain, (hrId) => hrId !== "D-1");
  assert.equal(withoutFirst?.double_visitor_hr_id, "H-1", "dropping the first promotes the second into slot 1");
  assert.equal(keepDoubleVisitors(chain, () => false), null, "nobody kept → no row");
}

function runDashboardTests() {
  const core = buildScopedDoubleVisitDashboardCore({
    access: access("Super Admin", "B-10"),
    dateTo: "2026-10-08",
    employees: EMPLOYEES,
    rows: rows(),
  });

  // THE REP: each visit once.
  assert.equal(core.kpis.totalVisits, 3, "the company total counts each visit ONCE — a chain visit is one visit");
  const rep = core.mrScores.find((score) => score.hrId === "R-1");
  assert.equal(rep?.totalDvs, 3, "the rep received three double visits, not five");
  assert.equal(rep?.distinctDoubleVisitors, 2, "and two managers gave them");

  // THE MANAGERS: both have the chain visits, counted the same way.
  const byManager = new Map(core.managerSummaries.map((summary) => [summary.managerHrId, summary]));
  assert.equal(byManager.get(ck("D-1"))?.totalDvs, 3, "the first manager: both chain visits and his own");
  assert.equal(
    byManager.get(ck("H-1"))?.totalDvs,
    2,
    "THE SECOND MANAGER has both chain visits in his own record, counted exactly as the first manager's are",
  );
  assert.equal(byManager.get(ck("H-1"))?.activeDvDays, 1, "and 6 October is a double-visit day of his");
  assert.equal(byManager.get(ck("H-1"))?.distinctMrs, 1, "with the rep among the reps he visited");
  assert.equal(core.kpis.doubleVisitorCount, 2, "two managers did double visits");
  assert.equal(core.kpis.activeDoubleVisitDays, 3, "manager-days: the first manager's two, the second's one");
  const leaderboardSum = core.managerSummaries.reduce((sum, summary) => sum + summary.totalDvs, 0);
  assert.equal(leaderboardSum, core.kpis.totalVisits + 2, "the leaderboard exceeds the total by exactly the chain visits");
}

function runScopeTests() {
  // A District Manager's board: the Regional Manager above him is hidden from his rows AND totals
  // (the downward rule), but the chain visit itself is HIS too and stays, with his credit.
  const dm = access("District Manager", "D-1");
  const scoped = filterRowsForAccess(rows(), dm, EMPLOYEES);
  assert.equal(scoped.length, 3, "every visit he was on stays on his board");
  assert.ok(
    scoped.every((entry) => entry.double_visitor2_hr_id == null),
    "the manager above him is taken off the chain rows, never named or credited on his board",
  );
  const core = buildScopedDoubleVisitDashboardCore({ access: dm, dateTo: "2026-10-08", employees: EMPLOYEES, rows: rows() });
  assert.ok(!core.managerSummaries.some((summary) => summary.managerHrId === ck("H-1")), "no leaderboard row for him");

  // A visitor who is never an allowed double visitor (the CEO) loses his credit, not the other's.
  const ceoChain = { ...rows()[0], double_visitor2_hr_id: "CEO-1", double_visitor2_name: "Chief" };
  const ceoCore = buildScopedDoubleVisitDashboardCore({
    access: access("Super Admin", "B-10"),
    dateTo: "2026-10-08",
    employees: EMPLOYEES,
    rows: [ceoChain],
  });
  assert.equal(ceoCore.kpis.totalVisits, 1, "the visit survives a disallowed second visitor");
  assert.deepEqual(ceoCore.managerSummaries.map((summary) => summary.managerHrId), [ck("D-1")], "and only the allowed manager is credited");
}

function runCalendarTests() {
  const selected = (hrId: string) => new Set([normalizeHrIdForAccess(hrId) as string]);
  const second = doubleVisitPrivateCalendarItemsFromRows(rows(), selected("H-1"));
  assert.equal(second.length, 1, "the second manager has the chain day on his own calendar");
  assert.equal(second[0].status, "performed");
  assert.equal(second[0].employeeHrId, "H-1");
  assert.ok(second[0].activityKind?.startsWith("chain"), "as a chain visit");
  assert.match(second[0].title, /2 visits/, "both chain visits, counted as the first manager's are");
  assert.match(second[0].title, /Rep Probation/, "with the rep named");
  assert.match(second[0].title, /District Lead/, "and the other manager named beside her");

  const first = doubleVisitPrivateCalendarItemsFromRows(rows(), selected("D-1"));
  const firstChain = first.find((item) => item.startDate === "2026-10-06");
  assert.match(firstChain?.title ?? "", /Regional Head/, "the first manager's chain day names the second manager");

  const rep = doubleVisitPrivateCalendarItemsFromRows(rows(), selected("R-1"));
  const repChain = rep.find((item) => item.startDate === "2026-10-06");
  assert.equal(repChain?.status, "received");
  assert.match(repChain?.title ?? "", /2 visits/, "the rep received the two chain visits ONCE each, not four");
  assert.ok(repChain?.activityKind?.startsWith("chain"), "and reads them as a chain visit");
}

function runLogAndReportTests() {
  const log: DoubleVisitLogEntry[] = rows().map((entry) => ({
    area: entry.area_name,
    date: entry.activity_date,
    doubleVisitorHrId: entry.double_visitor_hr_id,
    doubleVisitorName: entry.double_visitor_name,
    ...(entry.double_visitor2_hr_id
      ? { doubleVisitor2HrId: entry.double_visitor2_hr_id, doubleVisitor2Name: entry.double_visitor2_name ?? null }
      : {}),
    period: entry.period,
    visitCount: 1,
    visitedHrId: entry.visited_employee_hr_id,
    visitedName: entry.visited_employee_name,
    visitedStatus: "active_mapped",
  }));
  assert.equal(visitLogPerDoubleVisitor(log).length, 5, "the log, one entry per (visit, manager)");
  const pairs = buildManagerMrPairs(log);
  assert.equal(pairs.find((pair) => pair.managerHrId === ck("H-1"))?.visits, 2, "the second manager's pair with the rep holds both chain visits");
  assert.equal(pairs.find((pair) => pair.managerHrId === ck("D-1"))?.visits, 3, "the first manager's pair is unchanged");

  const reportRows = log.map(
    (entry) =>
      ({
        ...entry,
        activityDate: entry.date,
        areaName: entry.area,
        doubleVisitorRole: entry.doubleVisitorHrId === "D-1" ? "District Manager" : null,
        ...(entry.doubleVisitor2HrId ? { doubleVisitor2Role: "Regional Manager" } : {}),
        lineName: "Pedia",
        regionName: null,
        visitKind: "Regular",
      }) as unknown as DoubleVisitReportRow,
  );
  const filters = { areaFilter: ALL, periodFilter: ALL, regionFilter: ALL, roleFilter: ALL, search: "", visitKindFilter: ALL, visitorFilter: ALL };
  assert.equal(filterLogRows(reportRows, { ...filters, visitorFilter: "Regional Head" }).length, 2, "the second manager finds his chain visits under his own name");
  assert.equal(filterLogRows(reportRows, { ...filters, roleFilter: "Regional Manager" }).length, 2, "and under his own role");
  assert.equal(filterLogRows(reportRows, { ...filters, visitorFilter: "District Lead" }).length, 3, "the first manager still finds all three");
}

function runEmployee360Tests() {
  const visit = (over: Partial<VisitRow> & { crm_visit_id?: number }): VisitRow =>
    ({
      ampm: "AM",
      comment: null,
      contact_crm_id: 1,
      contact_name: "Dr One",
      crm_visit_id: -1,
      customer_name: null,
      double_crm_id: null,
      double_hr_id: "D-1",
      double_name: "District Lead",
      source: "phoenix",
      visit_date: "2026-10-06",
      visit_type: 0,
      visit_type_description: "Regular",
      ...over,
    }) as VisitRow;
  const history = buildDoubleVisitHistory(
    [
      visit({ crm_visit_id: -1, double2_hr_id: "H-1", double2_name: "Regional Head" }),
      visit({ crm_visit_id: -2, double2_hr_id: "H-1", double2_name: "Regional Head" }),
      visit({ crm_visit_id: -3, visit_date: "2026-10-07" }),
    ],
    new Set<string>(),
    new Map<string, string>(),
    "full",
  );
  assert.equal(history.totalReceived, 3, "the rep's Employee 360 receives each visit once");
  assert.equal(history.distinctVisitors, 2, "from two managers");
  assert.equal(history.daysReceived, 2, "three double visits on two days (6 and 7 Oct), owner 2026-10-27");
  const counts = Object.fromEntries(history.byVisitor.map((visitor) => [visitor.hrId, visitor.count]));
  assert.deepEqual(counts, { "d-1": 3, "h-1": 2 }, "the second manager is credited with both chain visits, as the first is");

  const tm = buildDoubleVisitHistory(
    [visit({ crm_visit_id: -4, double2_hr_id: "T-1", double2_name: "Trainer" })],
    new Set(["t-1"]),
    new Map<string, string>(),
    "full",
  );
  assert.equal(tm.tmCount, 1, "a Training Manager in slot 2 makes it a training double visit");
}

function runWiringTests() {
  const audit = readFileSync("src/lib/double-visit-analytics/audit-export.ts", "utf8");
  assert.match(
    audit,
    /for \(const row of perDoubleVisitorRows\(scopedRows\)\)/,
    "the coaching audit groups by coach over one entry per (visit, coach), so the second coach has his own tab",
  );
  const workspace = readFileSync("src/components/double-visit-analytics/double-visit-analytics-workspace.tsx", "utf8");
  assert.equal(
    (workspace.match(/visitLogPerDoubleVisitor\(visitLog\)/g) ?? []).length,
    2,
    "the dashboard's per-manager totals and profile read the log per (visit, manager)",
  );
}

export function runChainVisitOneVisitBothManagersTests() {
  runHelperTests();
  runDashboardTests();
  runScopeTests();
  runCalendarTests();
  runLogAndReportTests();
  runEmployee360Tests();
  runWiringTests();
}
