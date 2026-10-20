import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildManagerSummariesDetailed,
  buildScopedDoubleVisitDashboardCore,
  filterEmployeesForDoubleVisitAccess,
  filterRowsForAccess,
  resolveDoubleVisitAccessScope,
} from "../src/lib/double-visit-analytics/service.ts";
import { stripComments } from "./support/comment-strip.ts";
import { canAccessCoachingEmployee, scopeCoachingDirectoryForAccess } from "../src/lib/coaching/service.ts";
import { buildDownwardCut } from "../src/lib/crm/doctor-coverage-scope.ts";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "../src/lib/hr-id.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * THE DOWNWARD RULE on double-visit analytics and coaching.
 *
 * Owner, 2026-09-04: "Never an employee sees his direct manager. You see yourself and your scope
 * down." Owner, 2026-09-13: in Double Visit analytics an out-of-scope visitor's rows are hidden FROM
 * THE TOTALS TOO — the headline shrinks, and the KPI total must equal the leaderboard sum.
 *
 * Production shape: Product Manager B-155 reports to A-8, who carries the SAME line — so a line
 * scope put his own manager, her 29+ visits, and every DSM on the line onto his board.
 *
 * Every assertion below drives the SERVICE's own exported functions. A test that rebuilt the
 * pipeline or the chain itself is how an earlier attempt stayed green while the idle-manager false
 * zero shipped (memory: double-visit-skips-the-downward-rule).
 */

type Access = Parameters<typeof resolveDoubleVisitAccessScope>[0];
type Rows = Parameters<typeof filterRowsForAccess>[0];

function person(input: Partial<EmployeeDirectoryRow> & { hrId: string; jobTitle: string }): EmployeeDirectoryRow {
  return {
    areaName: null,
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

function row(input: { visitor: string; visited: string | null; visits: number; line?: string | null; date?: string }) {
  return {
    activity_date: input.date ?? "2026-09-02",
    area_name: null,
    double_visitor_hr_id: input.visitor,
    double_visitor_name: input.visitor,
    id: `${input.visitor}-${input.visited ?? "vacant"}-${input.visits}`,
    line_name: input.line ?? "Pedia",
    period: "AM",
    source_record_id: null,
    source_type: "ireports360",
    visit_count: input.visits,
    visit_type: 0,
    visit_type_description: null,
    visited_employee_hr_id: input.visited,
    visited_employee_name: input.visited,
    visited_employee_status: input.visited ? "active_mapped" : "unmapped",
  };
}

function access(role: string, hrId: string): Access {
  return { hrId, loginId: hrId, role, scope: "line", source: "session" } as unknown as Access;
}

const k = (id: string) => normalizeHrIdForAccess(id) as string;
const ck = (id: string) => canonicalHrIdKey(id) as string;

function directory(): EmployeeDirectoryRow[] {
  return [
    // The chain above the viewer, with a DEPARTED link in the middle: the climb must pass through it.
    person({ hrId: "N-1", fullName: "National Head", jobTitle: "National Sales Manager" }),
    person({ hrId: "G-0", fullName: "Departed Director", jobTitle: "Business Unit Director", managerHrId: "N-1", employmentStatus: "resigned" }),
    person({ hrId: "M-1", fullName: "Rasha Manager", jobTitle: "Group Product Manager", managerHrId: "G-0" }),
    // The viewer.
    person({ hrId: "A-8", fullName: "Ahmed Viewer", jobTitle: "Product Manager", managerHrId: "M-1" }),
    // A peer PM under the same manager — at his rank, so out.
    person({ hrId: "P-2", fullName: "Peer PM", jobTitle: "Product Manager", managerHrId: "M-1" }),
    // Same line, NOT his reports.
    person({ hrId: "R-1", fullName: "Line RSM", jobTitle: "Regional Sales Manager", managerHrId: "N-1" }),
    person({ hrId: "D-1", fullName: "Line DSM", jobTitle: "District Sales Manager", managerHrId: "R-1" }),
    person({ hrId: "REP-1", fullName: "Rep One", jobTitle: "Medical Representative", managerHrId: "D-1" }),
    person({ hrId: "REP-2", fullName: "Rep Two", jobTitle: "Medical Representative", managerHrId: "D-1" }),
    // Ranked by the MORE SENIOR of the two titles: a DSM position under a rep job title is a DSM.
    person({ hrId: "X-1", fullName: "Mixed Titles", jobTitle: "Medical Representative", positionTitle: "District Sales Manager", managerHrId: "R-1" }),
    // Off the ladder entirely, on the line.
    person({ hrId: "U-1", fullName: "Line Admin", jobTitle: "Line Coordinator", positionTitle: null, managerHrId: "N-1" }),
    // A Training Manager — no sales rank, but a real double visitor (role code TM). Owner 2026-09-13:
    // shown on a PM/GPM/RM board.
    person({ hrId: "T-1", fullName: "Line Trainer", jobTitle: "Training Manager", managerHrId: "N-1" }),
    // His OWN report with an off-ladder title — downward by construction, stays in.
    person({ hrId: "S-1", fullName: "His Assistant", jobTitle: "Brand Assistant", positionTitle: null, managerHrId: "A-8" }),
    // A National Sales Manager whose own boss is MIS-TITLED as a DSM (rank 2, "below" him on the
    // ladder) — only the identity-based chain cut can hide that boss.
    person({ hrId: "Q-0", fullName: "Mis-titled Boss", jobTitle: "District Sales Manager" }),
    person({ hrId: "Q-1", fullName: "NSM Under Mis-titled Boss", jobTitle: "National Sales Manager", managerHrId: "Q-0" }),
    // The CEO — never an allowed double visitor, whatever the viewer's scope.
    person({ hrId: "CEO-1", fullName: "Chief", jobTitle: "CEO" }),
    // Another line entirely.
    person({ hrId: "REP-9", fullName: "Other Line Rep", jobTitle: "Medical Representative", lineId: 2, lineName: "CNS", managerHrId: "D-9" }),
  ];
}

function rows(): Rows {
  return [
    row({ visitor: "A-8", visited: "REP-1", visits: 3 }), // his own
    row({ visitor: "A-8", visited: "D-1", visits: 4 }), // manager→manager: dropped by the FULL-directory manager keys
    row({ visitor: "M-1", visited: "REP-1", visits: 5 }), // his manager → hidden
    row({ visitor: "M-1", visited: "REP-2", visits: 4 }), // his manager → hidden
    row({ visitor: "N-1", visited: "REP-2", visits: 2 }), // above the departed link → hidden
    row({ visitor: "D-1", visited: "REP-2", visits: 6 }), // DSM at his rank → hidden (ladder)
    row({ visitor: "P-2", visited: "REP-1", visits: 1 }), // peer PM → hidden (ladder)
    row({ visitor: "CRM:777", visited: null, visits: 2 }), // unmapped visitor, vacant territory → KEPT
    row({ visitor: "T-1", visited: "REP-1", visits: 7 }), // Training Manager, no sales rank → KEPT (owner 2026-09-13)
  ] as unknown as Rows;
}

export function runDoubleVisitDownwardScopeTests() {
  const employees = directory();
  const allRows = rows();
  const pm = access("Product Manager", "A-8");

  // ── The key-domain trap, asserted UNCONDITIONALLY (an `if` guard here once asserted nothing). ──
  assert.notEqual(ck("A-8"), k("A-8"), "canonical and access key domains differ (a-8 vs a8) — the scope must pick one");

  // ── 1. The resolver: both cuts, access-domain keys, never readmitted. ───────────────────────────
  const scope = resolveDoubleVisitAccessScope(pm, employees);
  assert.equal(scope.all, false, "a Product Manager is not company-wide");
  if (scope.all) return;
  for (const id of ["M-1", "G-0", "N-1"]) {
    assert.ok(scope.excludedVisitorKeys.has(k(id)), `chain cut: ${id} is above the viewer and must be excluded (through a departed link)`);
    assert.ok(!scope.allowedHrIds.has(k(id)), `chain cut: ${id} must never sit in allowedHrIds`);
  }
  for (const id of ["P-2", "D-1", "R-1", "X-1"]) {
    assert.ok(scope.excludedVisitorKeys.has(k(id)), `ladder: ${id} is ranked at or above a Product Manager and must be excluded`);
  }
  // Owner, 2026-09-13 (questions workbook row 5, "Shown"): a visitor with NO sales rank is not cut by
  // the ladder on this board.
  for (const id of ["U-1", "T-1"]) {
    assert.ok(!scope.excludedVisitorKeys.has(k(id)), `ladder: ${id} has no sales rank and must NOT be excluded from a Product Manager's double-visit board`);
  }
  assert.ok(!scope.excludedVisitorKeys.has(k("A-8")), "the viewer is never excluded from his own scope");
  assert.ok(scope.allowedHrIds.has(k("A-8")), "the viewer stays in his own scope");
  assert.ok(scope.allowedHrIds.has(k("REP-1")), "a same-line rep stays in scope via the line widening");
  assert.ok(scope.allowedHrIds.has(k("S-1")), "his own off-ladder report stays in scope — the subtree is exempt from the ladder");
  assert.ok(!scope.allowedHrIds.has(k("REP-9")), "another line stays out");

  // ── 2. Employees are admitted by identity only — line labels never readmit an excluded manager. ─
  const scopedKeys = new Set(filterEmployeesForDoubleVisitAccess(employees, pm).map((e) => k(e.hrId)));
  assert.ok(!scopedKeys.has(k("M-1")), "his manager must not be readmitted to scopedEmployees through the line label");
  assert.ok(!scopedKeys.has(k("D-1")), "a same-line DSM must not be readmitted through the line label");
  assert.ok(scopedKeys.has(k("REP-2")), "a same-line rep is still a scoped employee");

  // ── 3. Rows: an excluded visitor's rows go, BEFORE the line-label fallback; an unmapped one stays. ─
  const scopedRowVisitors = filterRowsForAccess(allRows, pm, employees).map((r) => r.double_visitor_hr_id);
  assert.ok(!scopedRowVisitors.includes("M-1"), "his manager's visits to HIS reps are dropped, not merely unnamed");
  assert.ok(!scopedRowVisitors.includes("D-1"), "a same-line DSM's visits are dropped for a Product Manager");
  assert.ok(scopedRowVisitors.includes("CRM:777"), "an unmapped CRM visitor on a vacant territory survives the line-label fallback");

  // ── 4. The dashboard core: every emitter shrinks together, and the totals reconcile. ────────────
  const core = buildScopedDoubleVisitDashboardCore({ access: pm, dateTo: "2026-09-30", employees, rows: allRows });
  const leaderboardSum = core.managerSummaries.reduce((sum, s) => sum + s.totalDvs, 0);
  assert.equal(
    core.kpis.totalVisits,
    12,
    "the headline shrinks to his own 3 + the unmapped 2 + the Training Manager's 7 (owner 2026-09-13: out-of-scope rows leave the totals, unranked visitors stay)",
  );
  assert.ok(
    core.filteredRows.some((r) => r.double_visitor_hr_id === "T-1"),
    "a Training Manager's double visit to a same-line rep stays on a Product Manager's board",
  );
  assert.equal(core.kpis.totalVisits, leaderboardSum, "KPI total must equal the leaderboard sum");
  const names = (list: Array<{ managerHrId: string }>) => list.map((entry) => entry.managerHrId);
  assert.ok(!names(core.managerSummaries).includes(ck("M-1")), "his manager is absent from the leaderboard");
  assert.ok(!core.executiveReports.some((r) => ck(r.managerHrId) === ck("M-1")), "his manager is absent from the By Manager tab");
  assert.ok(
    !core.executiveSummary.idleManagers.some((m) => m.hrId === ck("M-1")),
    "his manager must NOT appear as an idle manager — a false zero about someone who did 9 visits",
  );
  assert.ok(!core.scopedEmployees.some((e) => k(e.hrId) === k("M-1")), "his manager is absent from the core's scoped employees");

  // ── 5. The ladder is RELATIVE: a GPM (rank 3) keeps DSMs and PMs, loses the RSM. ─────────────────
  const gpmScope = resolveDoubleVisitAccessScope(access("Group Product Manager", "M-1"), employees);
  assert.equal(gpmScope.all, false);
  if (!gpmScope.all) {
    assert.ok(!gpmScope.excludedVisitorKeys.has(k("D-1")), "a DSM is strictly below a Group Product Manager");
    assert.ok(!gpmScope.excludedVisitorKeys.has(k("A-8")), "a PM is strictly below a Group Product Manager");
    assert.ok(gpmScope.excludedVisitorKeys.has(k("R-1")), "an RSM is at a Group Product Manager's rank");
    assert.ok(!gpmScope.excludedVisitorKeys.has(k("T-1")), "a Training Manager has no sales rank and stays on a Group Product Manager's board");
  }

  // ── 6. Non-widening roles take the CHAIN cut only. ───────────────────────────────────────────────
  const dsmRows = filterRowsForAccess(
    [row({ visitor: "R-1", visited: "REP-1", visits: 7 }), row({ visitor: "D-1", visited: "REP-1", visits: 2 })] as unknown as Rows,
    access("District Manager", "D-1"),
    employees,
  ).map((r) => r.double_visitor_hr_id);
  assert.deepEqual(dsmRows, ["D-1"], "a DSM loses his own RSM's visits to his reps, and keeps his own");
  // The visitor-ROLE check reads the full directory: a CEO outside the DSM's scope is still not an
  // allowed double visitor (built from the scope it failed OPEN for anyone outside it).
  const dsmCore = buildScopedDoubleVisitDashboardCore({
    access: access("District Manager", "D-1"),
    dateTo: "2026-09-30",
    employees,
    rows: [row({ visitor: "CEO-1", visited: "REP-1", visits: 8 }), row({ visitor: "D-1", visited: "REP-1", visits: 2 })] as unknown as Rows,
  });
  assert.deepEqual(
    dsmCore.filteredRows.map((r) => r.double_visitor_hr_id),
    ["D-1"],
    "an out-of-scope CEO visitor is dropped by the role check, not let through because he is not in scope",
  );

  // ── 7. Company-wide viewers are untouched. ───────────────────────────────────────────────────────
  const sfe = access("SFE Manager", "Z-9");
  assert.equal(resolveDoubleVisitAccessScope(sfe, employees).all, true, "SFE Manager stays company-wide");
  const sfeCore = buildScopedDoubleVisitDashboardCore({ access: sfe, dateTo: "2026-09-30", employees, rows: allRows });
  assert.ok(sfeCore.filteredRows.some((r) => r.double_visitor_hr_id === "M-1"), "a company-wide viewer still sees every manager's visits");

  // ── 8. A manager-link cycle through the viewer terminates and never readmits the ancestor. ───────
  const cyclic = [
    person({ hrId: "C-1", jobTitle: "Product Manager", managerHrId: "C-2" }),
    person({ hrId: "C-2", jobTitle: "Group Product Manager", managerHrId: "C-1" }),
  ];
  const cyclicScope = resolveDoubleVisitAccessScope(access("Product Manager", "C-1"), cyclic);
  if (!cyclicScope.all) {
    assert.ok(!cyclicScope.allowedHrIds.has(k("C-2")), "an ancestor inside a cyclic subtree walk is still cut");
    assert.ok(cyclicScope.allowedHrIds.has(k("C-1")), "the viewer survives his own cycle");
  }

  // ── 9. The exported cut ranks by the MORE SENIOR title. ───────────────────────────────────────────
  const cut = buildDownwardCut({ role: "Product Manager", viewerHrId: "A-8", employees });
  assert.equal(cut.isStrictlyBelowViewer(employees.find((e) => e.hrId === "X-1")!), false, "a DSM position outranks a rep job title");
  assert.equal(cut.isStrictlyBelowViewer(employees.find((e) => e.hrId === "REP-1")!), true, "a rep is below a PM");

  // ── 10. Coaching, line-role branch: both cuts. ───────────────────────────────────────────────────
  const byId = (id: string) => employees.find((e) => e.hrId === id)!;
  assert.equal(canAccessCoachingEmployee(pm, byId("M-1"), employees), false, "coaching: a PM cannot open his own manager's reports");
  assert.equal(canAccessCoachingEmployee(pm, byId("P-2"), employees), false, "coaching: a PM cannot open a peer PM");
  assert.equal(canAccessCoachingEmployee(pm, byId("D-1"), employees), false, "coaching: a PM cannot open a same-line DSM");
  assert.equal(canAccessCoachingEmployee(pm, byId("REP-1"), employees), true, "coaching: a PM still opens a same-line rep");
  assert.equal(canAccessCoachingEmployee(pm, byId("S-1"), employees), true, "coaching: his own off-ladder report stays open");
  // The 2026-09-13 "Shown" answer was about the double-visit BOARD only. Coaching keeps the stricter
  // ladder — an unranked colleague outside his subtree stays closed — until the owner says otherwise.
  assert.equal(canAccessCoachingEmployee(pm, byId("T-1"), employees), false, "coaching: an unranked Training Manager outside his subtree stays closed");
  assert.equal(
    canAccessCoachingEmployee(access("National Sales Manager", "Q-1"), byId("Q-0"), employees),
    false,
    "coaching: the chain cut hides an NSM's own boss even when a mis-title ranks the boss below him",
  );
  assert.equal(
    canAccessCoachingEmployee(access("CEO", "Z-1"), byId("M-1"), employees),
    true,
    "coaching: company oversight is untouched",
  );

  // ── 11. Coaching role coverage (owner, 2026-10-20: every role a module applies to finds its people).
  // The SFE Manager's own seat is on the Head Office line, so the line branch found no field rep at
  // all; he reads coaching company-wide. Z-9 is not even in the directory — oversight needs no seat.
  const sfeCoach = access("SFE Manager", "Z-9");
  assert.equal(canAccessCoachingEmployee(sfeCoach, byId("REP-1"), employees), true, "coaching: the SFE Manager opens a field rep's reports");
  assert.equal(canAccessCoachingEmployee(sfeCoach, byId("REP-9"), employees), true, "coaching: the SFE Manager opens every line, not one");
  assert.equal(scopeCoachingDirectoryForAccess(sfeCoach, employees).length, employees.length, "coaching analytics: the SFE Manager's directory is the whole company");

  // A Product Manager sits in Marketing while the reps he coaches sit in Sales: "same department"
  // hid every rep on his own line. He now reads his line like a Group Product Manager, and the ladder
  // still keeps him to the seats beneath his own.
  const byDepartment = employees.map((e) => ({
    ...e,
    departmentName: ["A-8", "P-2", "M-1"].includes(e.hrId) ? "Marketing" : "Sales",
  }));
  const deptById = (id: string) => byDepartment.find((e) => e.hrId === id)!;
  assert.equal(canAccessCoachingEmployee(pm, deptById("REP-1"), byDepartment), true, "coaching: a Marketing-department PM opens a Sales rep on his own line");
  assert.equal(canAccessCoachingEmployee(pm, deptById("D-1"), byDepartment), false, "coaching: the cross-department line view still cuts a same-line DSM");
  assert.equal(canAccessCoachingEmployee(pm, deptById("REP-9"), byDepartment), false, "coaching: the cross-department line view never reaches another line");
  assert.deepEqual(
    scopeCoachingDirectoryForAccess(pm, byDepartment).map((e) => e.hrId).sort(),
    ["A-8", "REP-1", "REP-2", "S-1"],
    "coaching analytics: a PM's directory is himself, his own report and his line's reps — nobody above or beside him",
  );
  // The National Sales Manager stays department-safe: a Marketing seat on his line is not his.
  assert.equal(
    canAccessCoachingEmployee(access("National Sales Manager", "N-1"), deptById("P-2"), byDepartment),
    false,
    "coaching: an NSM still never opens a Marketing seat that merely shares his line",
  );

  // ── 12. Double-visit role coverage (owner, 2026-10-20: every role a module applies to finds its people).
  // 12a. A Product Manager's line OVERRIDE (doctor_coverage_config.line_overrides, keyed by the access
  //      key) reaches his second line, exactly as doctor coverage reads it — and the ladder still cuts.
  const overrides = { lineOverrides: { [k("A-8")]: [1, 2] } };
  const overrideScope = resolveDoubleVisitAccessScope(pm, employees, overrides);
  assert.equal(overrideScope.all, false);
  if (!overrideScope.all) {
    assert.ok(overrideScope.allowedHrIds.has(k("REP-9")), "an override's second line brings its reps onto a PM's board");
    assert.ok(overrideScope.allowedHrIds.has(k("REP-1")), "his recorded line stays when the override names it too");
    for (const id of ["M-1", "D-1", "P-2"]) {
      assert.ok(!overrideScope.allowedHrIds.has(k(id)), `an override never readmits ${id}, whom the downward rule cut`);
    }
  }
  const secondLineOnly = resolveDoubleVisitAccessScope(pm, employees, { lineOverrides: { [k("A-8")]: [2] } });
  if (!secondLineOnly.all) {
    assert.ok(!secondLineOnly.allowedHrIds.has(k("REP-1")), "the override WINS over the recorded line, as in doctor coverage");
    assert.ok(secondLineOnly.allowedHrIds.has(k("S-1")), "his own subtree is never lost to an override");
  }
  assert.ok(
    filterEmployeesForDoubleVisitAccess(employees, pm, overrides).some((e) => k(e.hrId) === k("REP-9")),
    "the scoped directory carries the override's line too",
  );
  // A visit he did not make himself, to a rep on the second line: only the override admits it.
  const secondLineVisit = [row({ visitor: "CRM:888", visited: "REP-9", visits: 2, line: "CNS" })] as unknown as Rows;
  assert.equal(filterRowsForAccess(secondLineVisit, pm, employees).length, 0, "without the override, the second line's visits stay off his board");
  assert.equal(filterRowsForAccess(secondLineVisit, pm, employees, overrides).length, 1, "with it, a visit to a rep on his second line is on his board");

  // 12b. The SFE Manager is an allowed double visitor with his own code, yet the By Manager tab never
  //      listed him: he sits above no rep in the org chart and was missing from the functional roles.
  const withSfe = [
    ...employees,
    person({ hrId: "SF-1", fullName: "SFE Head", jobTitle: "SFE Manager", lineId: 4, lineName: "Head Office" }),
  ];
  const sfeVisitCore = buildScopedDoubleVisitDashboardCore({
    access: access("CEO", "Z-1"),
    dateTo: "2026-09-30",
    employees: withSfe,
    rows: [row({ visitor: "SF-1", visited: "REP-1", visits: 3 })] as unknown as Rows,
  });
  const sfeReport = sfeVisitCore.executiveReports.find((r) => ck(r.managerHrId) === ck("SF-1"));
  assert.ok(sfeReport, "the SFE Manager appears in the By Manager list once he double-visits");
  assert.equal(sfeReport!.expectedMrCount, 1, "and his report is scoped to the reps he actually visited, never the whole company");

  // 12c. The manager profile's "not visited" list is his WHOLE team. An NSM's reps report to his DSMs,
  //      so the direct-report filter always read empty; the summary now carries the team's HR ids.
  const { summaries: teamSummaries } = buildManagerSummariesDetailed(
    [row({ visitor: "N-1", visited: "REP-1", visits: 2 }), row({ visitor: "A-8", visited: "REP-1", visits: 3 })] as unknown as Rows,
    employees,
    "2026-09-30",
  );
  const nsmSummary = teamSummaries.find((s) => s.managerHrId === ck("N-1"));
  assert.ok(nsmSummary, "the NSM has a summary");
  const nsmTeam = nsmSummary!.teamMrHrIds ?? [];
  assert.equal(nsmTeam.length, nsmSummary!.teamMrCount, "the team list is exactly the population the coverage figure counts");
  assert.ok(nsmTeam.includes("REP-1") && nsmTeam.includes("REP-2"), "reps two levels beneath him (under his DSM) are in his team");
  assert.ok(!nsmTeam.includes("REP-9"), "another line's rep is not");
  assert.equal(teamSummaries.find((s) => s.managerHrId === ck("A-8"))?.teamMrHrIds, null, "a PM has no org team, so no team list");
  const workspaceCode = stripComments(
    readFileSync("src/components/double-visit-analytics/double-visit-analytics-workspace.tsx", "utf8"),
  );
  assert.match(
    workspaceCode,
    /summaryByKey\.get\(selectedManagerKey\)\?\.teamMrHrIds \?\? null,/,
    "the manager profile is handed the selected manager's whole team",
  );
  assert.match(
    workspaceCode,
    /\(s\) => \(teamKeys \? teamKeys\.has\(hk\(s\.hrId\)\) : hk\(s\.managerHrId\) === managerKey\) && !visitedKeysAll\.has\(hk\(s\.hrId\)\),/,
    "the not-visited list reads the team, falling back to direct reports only for a manager with no org team",
  );
  assert.doesNotMatch(workspaceCode, /\(\{m\.hrId\}\)/, "the not-visited buttons show names, never HR codes");
}
