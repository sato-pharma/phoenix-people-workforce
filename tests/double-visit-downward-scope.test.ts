import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  filterEmployeesForDoubleVisitAccess,
  filterRowsForAccess,
  resolveDoubleVisitAccessScope,
} from "../src/lib/double-visit-analytics/service.ts";
import { normalizeHrIdForAccess } from "../src/lib/hr-id.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * THE DOWNWARD RULE REACHES DOUBLE-VISIT ANALYTICS, NOT ONLY THE CRM BOARDS.
 *
 * Owner, 2026-09-04: "Never an employee sees his direct manager. You see yourself and your scope
 * down — downgrading, not upgrading." Asked how far: "remove dsms rsm and peer pms too."
 *
 * That was enforced in resolveDoctorCoverageScope the same day and nowhere else. Double-visit
 * analytics kept the wide shape until 2026-09-11, and measured in production Product Manager B-155
 * had his own manager A-8 inside this scope along with 8 seats at or above his rank — hidden
 * correctly on the CRM boards, visible here.
 *
 * 🔴 THE THREE FAILURES THIS PINS ARE SILENT, AND THE THIRD LOOKS LIKE THE FIX WORKING.
 *
 * A LINE IS NOT A DIRECTION. Line membership is everyone carrying that line id — manager, peers and
 * every seat above included. Widening a scope to "the line" therefore reintroduces exactly what the
 * rule removes, and nothing errors.
 *
 * THE DESCENDANT CHAIN MUST SURVIVE. The cut is applied to the LINE widening only. A person who
 * genuinely reports to the viewer is downward by construction, and ranking them out would delete a
 * PM's own DSM from her board — the empty-board failure that reads as a data fault.
 *
 * 🔴 THE LINE LABEL CAN UNDO THE WHOLE CUT. `allowedLines` exists so a line-tagged ROW with no
 * mapped employee (a resigned or vacant territory) is still counted. If the EMPLOYEE filter also
 * reads it, every member of the line is re-admitted as a person — the viewer's manager included —
 * while resolveDoubleVisitAccessScope still returns a correctly cut allowedHrIds. The scope looks
 * right and the board is wrong.
 */

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/double-visit-analytics/service.ts", import.meta.url)),
  "utf8",
);

/** Source with comments stripped, so a rule described in prose cannot satisfy a check. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function employee(input: Partial<EmployeeDirectoryRow>): EmployeeDirectoryRow {
  return {
    areaName: null,
    displayName: input.fullName ?? "Employee",
    employmentStatus: "active",
    fullName: input.fullName ?? "Employee",
    hrId: input.hrId ?? "E-1",
    jobTitle: input.jobTitle ?? "Medical Representative",
    lineId: input.lineId ?? 1,
    lineName: input.lineName ?? "Pedia",
    managerHrId: null,
    pendingManagerReplacementForHrId: null,
    positionTitle: input.jobTitle ?? "Medical Representative",
    regionName: null,
    ...input,
  } as EmployeeDirectoryRow;
}

const accessFor = (hrId: string, role: string) =>
  ({ hrId, loginId: hrId, role, scope: "line", source: "session" }) as unknown as Parameters<
    typeof resolveDoubleVisitAccessScope
  >[0];

const k = (id: string) => normalizeHrIdForAccess(id) as string;

/** One product line holding every rank, so the ladder can be read relative to any viewer. */
function pediaLine(): EmployeeDirectoryRow[] {
  return [
    employee({ fullName: "NSM", hrId: "N-1", jobTitle: "National Sales Manager" }),
    employee({ fullName: "GPM (the PM's own manager)", hrId: "A-8", jobTitle: "Group Product Manager", managerHrId: "N-1" }),
    employee({ fullName: "RSM", hrId: "R-1", jobTitle: "Regional Sales Manager", managerHrId: "N-1" }),
    employee({ fullName: "The PM", hrId: "B-155", jobTitle: "Product Manager", managerHrId: "A-8" }),
    employee({ fullName: "Peer PM", hrId: "P-2", jobTitle: "Product Manager", managerHrId: "A-8" }),
    employee({ fullName: "DSM outside the PM's chain", hrId: "D-9", jobTitle: "District Sales Manager", managerHrId: "R-1" }),
    employee({ fullName: "DSM reporting TO the PM", hrId: "D-1", jobTitle: "District Sales Manager", managerHrId: "B-155" }),
    employee({ fullName: "Rep", hrId: "M-1", jobTitle: "Medical Representative", managerHrId: "D-9" }),
    employee({ fullName: "Office seat on the line", hrId: "O-1", jobTitle: "Buffet", managerHrId: "N-1" }),
    employee({ fullName: "Other line rep", hrId: "M-20", jobTitle: "Medical Representative", lineId: 2, lineName: "CNS", managerHrId: "D-9" }),
  ];
}

export function runDoubleVisitDownwardScopeTests() {
  const people = pediaLine();
  const scope = resolveDoubleVisitAccessScope(accessFor("B-155", "Product Manager"), people);
  assert.equal(scope.all, false, "a Product Manager is never granted org-wide double-visit access");
  if (scope.all !== false) return;

  // ── 🔴 Cut 1: never your own manager ─────────────────────────────────────────────────────────
  assert.ok(
    !scope.allowedHrIds.has(k("A-8")),
    "the PM must not see his own manager — measured in production on 2026-09-11, B-155 could see A-8 here while she was correctly hidden on the CRM boards",
  );

  // ── 🔴 Cut 2: nobody at or above his own rank ────────────────────────────────────────────────
  for (const [hrId, who] of [
    ["P-2", "a peer Product Manager"],
    ["D-9", "a District Sales Manager outside his chain"],
    ["R-1", "a Regional Sales Manager"],
    ["N-1", "a National Sales Manager"],
  ] as const) {
    assert.ok(!scope.allowedHrIds.has(k(hrId)), `the PM must not see ${who} — the owner's words were "remove dsms rsm and peer pms too"`);
  }

  // An unranked title is excluded, deliberately: 12 head-office seats carry a line_id in
  // production (the CEO among them), so "unknown means field force" would put the CEO in scope.
  assert.ok(!scope.allowedHrIds.has(k("O-1")), "an office seat on the line is excluded, because an unranked title is excluded");

  // ── What must SURVIVE the cut ────────────────────────────────────────────────────────────────
  assert.ok(scope.allowedHrIds.has(k("B-155")), "the viewer is never excluded from his own scope — without this guard the ladder empties his board");
  assert.ok(scope.allowedHrIds.has(k("M-1")), "the reps on his line stay in scope — they are what the board is for");
  assert.ok(
    scope.allowedHrIds.has(k("D-1")),
    "a DSM who genuinely REPORTS to the PM stays, because the descendant chain is downward by construction and the ladder runs on the line widening only",
  );
  assert.ok(!scope.allowedHrIds.has(k("M-20")), "another product line is still out of scope");

  // ── 🔴 The line label must not re-admit a cut person ─────────────────────────────────────────
  // allowedLines is a ROW rule. If the EMPLOYEE filter reads it, every line member returns —
  // including the manager just cut — while allowedHrIds still looks correctly narrow.
  assert.ok(scope.allowedLines.size > 0, "the line label is still collected, so line-tagged rows with no mapped employee are counted");
  const visiblePeople = filterEmployeesForDoubleVisitAccess(people, accessFor("B-155", "Product Manager"));
  const visibleIds = new Set(visiblePeople.map((person) => k(person.hrId)));
  assert.ok(
    !visibleIds.has(k("A-8")),
    "the PM's own manager must not come back through the line LABEL — this is the path that silently undoes the cut while the scope itself still reads correctly",
  );
  for (const hrId of ["P-2", "R-1", "N-1", "D-9"]) {
    assert.ok(!visibleIds.has(k(hrId)), `${hrId} must not return through the line label either`);
  }
  assert.ok(visibleIds.has(k("M-1")), "the reps are still listed");
  assert.ok(visibleIds.has(k("B-155")), "the viewer is still listed");

  // ── The ladder is RELATIVE: a GPM outranks a PM, so he keeps what the PM loses ───────────────
  const gpmScope = resolveDoubleVisitAccessScope(accessFor("A-8", "Group Product Manager"), people);
  assert.equal(gpmScope.all, false, "a GPM is not granted org-wide access either");
  if (gpmScope.all !== false) return;
  assert.ok(gpmScope.allowedHrIds.has(k("B-155")), "the GPM sees the Product Manager below him");
  assert.ok(gpmScope.allowedHrIds.has(k("D-9")), "the GPM sees a District Sales Manager, who ranks below him");
  assert.ok(!gpmScope.allowedHrIds.has(k("N-1")), "but not the National Sales Manager above him");
  assert.ok(!gpmScope.allowedHrIds.has(k("R-1")), "nor a Regional Sales Manager at his own rank");

  // ── Roles with no line widening are untouched by this change ─────────────────────────────────
  const dsmScope = resolveDoubleVisitAccessScope(accessFor("D-1", "District Manager"), people);
  assert.equal(dsmScope.all, false, "a District Manager is not org-wide");
  if (dsmScope.all !== false) return;
  assert.equal(dsmScope.allowedLines.size, 0, "a DSM never gets the line widening, so the label set stays empty");
  assert.ok(!dsmScope.allowedHrIds.has(k("M-1")), "and he sees only his own subtree, not the line");

  // ── 🔴 A ROW between two cut people must not survive on the line LABEL ───────────────────────
  // The Manager Performance table is built from row VISITORS, not from the scoped employee list,
  // so cutting somebody from the scope alone never removes their name from it. Before this guard
  // an NSM→DSM row — both parties cut — still reached the PM's board carrying their names.
  const row = (visitor: string, visited: string, lineName: string | null, over: Record<string, unknown> = {}) =>
    ({
      area_name: null,
      double_visitor_hr_id: visitor,
      double_visitor_name: visitor,
      line_name: lineName,
      visited_employee_hr_id: visited,
      visited_employee_name: visited,
      ...over,
    }) as unknown as Parameters<typeof filterRowsForAccess>[0][number];

  const pmAccess = accessFor("B-155", "Product Manager");
  const kept = filterRowsForAccess(
    [
      row("N-1", "D-9", "Pedia"), // both cut — must NOT survive
      row("A-8", "P-2", "Pedia"), // the PM's own manager visiting a peer — must NOT survive
      row("D-1", "M-1", "Pedia"), // his own DSM visiting a rep — must survive
      row("GHOST-1", "GHOST-2", "Pedia"), // neither party in the directory — the label's real job
    ],
    pmAccess,
    people,
  ).map((r) => `${r.double_visitor_hr_id}->${r.visited_employee_hr_id}`);

  assert.ok(
    !kept.includes("N-1->D-9"),
    "a row between two people the cut removed must not return through the line label — the Manager Performance table reads row visitors, so this is how a cut manager keeps her name on a PM's board",
  );
  assert.ok(!kept.includes("A-8->P-2"), "nor a row whose visitor is the viewer's own manager");
  assert.ok(kept.includes("D-1->M-1"), "his own DSM's visit to a rep still counts");
  assert.ok(
    kept.includes("GHOST-1->GHOST-2"),
    "a line-tagged row whose people are NOT in the directory is still captured — that is what allowedLines is for, and narrowing it to nothing would lose resigned and vacant territories",
  );

  // ── 🔴 A manager-link CYCLE must not smuggle an ancestor back in ─────────────────────────────
  // descendantHrIds seeds allowedHrIds before the cut and the cut gates only the line widening, so
  // without the chain guard a cycle re-admits the exact person the rule removes. Production has 0
  // cycles today (measured 2026-09-11); this pins the guard rather than the data.
  const cyclic = pediaLine().map((person) =>
    person.hrId === "A-8" ? ({ ...person, managerHrId: "B-155" } as typeof person) : person,
  );
  const cyclicScope = resolveDoubleVisitAccessScope(accessFor("B-155", "Product Manager"), cyclic);
  assert.equal(cyclicScope.all, false, "still not org-wide");
  if (cyclicScope.all !== false) return;
  assert.ok(
    !cyclicScope.allowedHrIds.has(k("A-8")),
    "a cycle that puts the viewer's own manager inside his subtree must still not expose her — the descendant seed is chain-filtered for exactly this",
  );
  assert.ok(cyclicScope.allowedHrIds.has(k("B-155")), "and the viewer is never deleted from his own scope by that guard");

  // ── The ladder reads positionTitle FIRST, then jobTitle ─────────────────────────────────────
  // A directory row with a null job_title and a populated position_title is a real shape, and the
  // rest of this module resolves a role that way. Ranking on jobTitle alone leaves such a rep
  // UNRANKED, and an unranked seat is excluded — so he vanishes from the board meant to show him.
  const withPositionOnly = [
    ...pediaLine(),
    employee({ fullName: "Rep by position title", hrId: "M-9", jobTitle: null, positionTitle: "Medical Representative" }),
  ];
  const positionScope = resolveDoubleVisitAccessScope(accessFor("B-155", "Product Manager"), withPositionOnly);
  assert.equal(positionScope.all, false, "still not org-wide");
  if (positionScope.all !== false) return;
  assert.ok(
    positionScope.allowedHrIds.has(k("M-9")),
    "a rep carrying only a position title is ranked and stays in scope — ranking on jobTitle alone would silently drop him",
  );

  // ── 🔴 AN EXCLUSION MUST NEVER BE DERIVED FROM A SCOPE ───────────────────────────────────────
  // `managerHrIdKeys` drops manager-to-manager rows. Whether somebody IS a manager is a property of
  // that person, not of who is looking. Building it from `scopedEmployees` couples the exclusion to
  // the viewer, so the downward cut removes people from the exclusion set too and their rows are
  // recounted as ordinary visits — inflating totalVisits and counting a DSM inside mrCoverageCount
  // as a covered MR. That is a REGRESSION the cut introduces, not a pre-existing hole, and it lives
  // several layers inside an IO function, so it is pinned at the source instead.
  const service = code(SERVICE_SOURCE);
  const builders = service.match(/managerHrIdKeys\s*=\s*new Set\(\s*(\w+)/g) ?? [];
  assert.ok(builders.length >= 4, `expected every managerHrIdKeys builder to be found, saw ${builders.length}`);
  for (const builder of builders) {
    assert.ok(
      !/scopedEmployees/.test(builder),
      "every managerHrIdKeys set must be built from the whole directory, never from scopedEmployees — deriving an exclusion from a scope is what let the downward cut inflate a PM's KPIs",
    );
  }
}
