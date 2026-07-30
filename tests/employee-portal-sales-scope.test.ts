import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createPortalSalesLineScope,
  employeeMatchesPortalSalesScope,
  portalSalesLinesMatch,
  salesRecordMatchesPortalSalesScope,
} from "../src/lib/employee-portal/sales-scope.ts";

export function runEmployeePortalSalesScopeTests() {
  // ── HIERARCHY roll-up must be the whole subtree, not direct reports ──────────
  // getMedicalRepPortalData feeds targetSalesHrIds from visibleTeamMembers. That list used
  // canSeeEmployee, a ONE-LEVEL isDirectReport check, so a Regional Manager resolved to self + their
  // District Managers — and DSMs carry no sales rows of their own. The incentive achievement and team
  // sales roll-up were therefore computed over people who never sell, reading 0% / EGP 0 while the
  // region was at ~105%. HIERARCHY is the only broken tier: SELF/TEAM are correct via canSeeEmployee,
  // and LINE/COMPANY never reach targetSalesHrIds (getScopedEmployeePortalSalesDashboard special-cases
  // LINE via the line filter).
  {
    const serviceSource = readFileSync(new URL("../src/lib/employee-portal/service.ts", import.meta.url), "utf8");
    assert.ok(
      serviceSource.includes("const visibleTeamMembers = directory.employees.filter("),
      "visibleTeamMembers must still be the roll-up roster",
    );
    assert.match(
      serviceSource,
      /salesScope === "HIERARCHY" \|\| access\.scope === "hierarchy"/,
      "the roll-up must detect a hierarchy-scoped viewer",
    );
    assert.match(serviceSource, /isWithinManagerHierarchy\(/, "a hierarchy viewer must expand to their full subtree");
    assert.match(
      serviceSource,
      /return canSeeEmployee\(access, row\);/,
      "non-hierarchy tiers (SELF/TEAM) must keep the existing one-level canSeeEmployee behaviour",
    );
  }

  // Attendance must follow the same rule: an RM owns the attendance-driven deduction days of every rep
  // in their region, but those reps report to a DSM, so a one-level check hid all of them.
  {
    const attendanceSource = readFileSync(
      new URL("../src/lib/attendance/employee-attendance.ts", import.meta.url),
      "utf8",
    );
    assert.match(attendanceSource, /function isHierarchyAttendanceViewer/, "attendance needs a hierarchy-viewer predicate");
    assert.match(attendanceSource, /async function loadAttendanceSubtreeHrIds/, "attendance needs a subtree resolver");
    assert.match(attendanceSource, /isWithinManagerHierarchy\(/, "the subtree resolver must use the canonical helper");
    const scopeIdx = attendanceSource.indexOf("export async function resolveAttendanceScopeHrIds(");
    assert.ok(scopeIdx > -1, "resolveAttendanceScopeHrIds must still exist");
    assert.match(
      attendanceSource.slice(scopeIdx),
      /includeSubtree: isHierarchyAttendanceViewer\(context\)/,
      "bulk attendance scope must widen for hierarchy viewers",
    );
    const assertIdx = attendanceSource.indexOf("export async function assertCanViewEmployeeAttendance(");
    assert.match(
      attendanceSource.slice(assertIdx, scopeIdx > assertIdx ? scopeIdx : undefined),
      /isHierarchyAttendanceViewer\(context\)/,
      "the per-employee attendance gate must admit a hierarchy viewer's whole subtree",
    );
  }

  assert.equal(portalSalesLinesMatch("Pedia", "Pedia line"), true);
  assert.equal(portalSalesLinesMatch("Anti-Infective", "Anti Infective line"), true);
  assert.equal(portalSalesLinesMatch("Anti Inf", "Anti Infective"), true);
  assert.equal(portalSalesLinesMatch("CNS", "Pedia"), false);

  const pediaScope = createPortalSalesLineScope({
    fallbackLine: "Pedia",
    lineId: 7,
    lineName: "Pedia line",
  });

  assert.equal(
    employeeMatchesPortalSalesScope({ lineId: 7, lineName: "Wrong display" }, pediaScope),
    true,
  );
  assert.equal(
    employeeMatchesPortalSalesScope({ lineId: null, lineName: "Pedia" }, pediaScope),
    true,
  );
  assert.equal(
    employeeMatchesPortalSalesScope({ lineId: 8, lineName: "CNS" }, pediaScope),
    false,
  );

  assert.equal(salesRecordMatchesPortalSalesScope({ line: "Pedia" }, pediaScope), true);
  assert.equal(salesRecordMatchesPortalSalesScope({ line: "CNS" }, pediaScope), false);
  assert.equal(salesRecordMatchesPortalSalesScope({ line: null }, pediaScope), true);
}
