import assert from "node:assert/strict";

import { canViewEmployeeAttendanceReport, resolveAttendanceScopeHrIds } from "../src/lib/attendance/employee-attendance.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

/**
 * Security boundary for the Fingerprint Analytics manager view:
 *   - self always;
 *   - whole-company viewers (CEO / Super Admin / company|system scope) see anyone;
 *   - any other manager sees their DIRECT reports only.
 * Matching is exact + normalized — never substring (B-1 must not leak B-10/B-100).
 */
function ctx(overrides: Partial<AccessContext>): AccessContext {
  return {
    hrId: "A-8",
    role: "Group Product Manager",
    scope: "line",
    source: "session",
    ...overrides,
  };
}

export async function runAttendanceManagerViewAccessTests() {
  const gpm = ctx({ hrId: "A-8", role: "Group Product Manager", scope: "line" });

  // Self — always.
  assert.equal(canViewEmployeeAttendanceReport(gpm, { hrId: "A-8", managerHrId: "A-9" }), true);

  // Direct report (B-155 reports to A-8) — allowed.
  assert.equal(canViewEmployeeAttendanceReport(gpm, { hrId: "B-155", managerHrId: "A-8" }), true);

  // Casing-insensitive: caller "a-8" still sees their direct report.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "a-8", scope: "line" }), { hrId: "B-155", managerHrId: "A-8" }),
    true,
  );

  // Not a direct report (reports to someone else) — denied.
  assert.equal(canViewEmployeeAttendanceReport(gpm, { hrId: "B-122", managerHrId: "A-12" }), false);

  // Substring trap: caller "B-1" must NOT see "B-10", nor anyone whose manager is "B-10"/"B-100".
  const b1 = ctx({ hrId: "B-1", scope: "line" });
  assert.equal(canViewEmployeeAttendanceReport(b1, { hrId: "B-10", managerHrId: "B-100" }), false);
  assert.equal(canViewEmployeeAttendanceReport(b1, { hrId: "X-1", managerHrId: "B-10" }), false);
  // But a genuine direct report of B-1 is allowed.
  assert.equal(canViewEmployeeAttendanceReport(b1, { hrId: "B-200", managerHrId: "B-1" }), true);

  // CEO — whole company (different person, no manager match needed).
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "C-1", role: "CEO", scope: "company" }), { hrId: "B-155", managerHrId: "A-8" }),
    true,
  );

  // Super Admin / system scope — whole company.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "S-1", role: "Super Admin", scope: "system" }), { hrId: "B-155", managerHrId: "A-8" }),
    true,
  );

  // ── Finance Manager: SELF ONLY (owner, 2026-08-10: "so he only sees himself") ────────────────
  // He holds attendance:read/export and scopeForRole gives the role "company", so the old
  // `context.scope === "company"` arm admitted him to EVERY employee's punch-and-deduction data —
  // /api/attendance/employee-fingerprint-export?hrId=<anyone> returned any one of 114 people's full
  // workbook by URL. Nothing linked there for him; it was reachable by typing it.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "F-1", role: "Finance Manager", scope: "company" }), { hrId: "B-155", managerHrId: "A-8" }),
    false,
    "the Finance Manager must NOT see an unrelated employee's attendance",
  );
  // Not even his own direct reports — this is what separates the owner's instruction from simply
  // deleting the company arm, which would have left him the manager fallback below.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "F-1", role: "Finance Manager", scope: "company" }), { hrId: "A-1", managerHrId: "F-1" }),
    false,
    "self-only means self-only: even a direct report of the Finance Manager is denied",
  );
  // …but his OWN report is untouched. The self check runs before the carve-out, which is the whole
  // reason /workspace/fingerprint-report still works for him.
  assert.equal(
    canViewEmployeeAttendanceReport(ctx({ hrId: "F-1", role: "Finance Manager", scope: "company" }), { hrId: "F-1", managerHrId: null }),
    true,
    "the Finance Manager keeps his own attendance report in full",
  );
  // The roles that legitimately keep whole-company attendance must be unaffected — this is the
  // negative control that fires if the carve-out is ever implemented by deleting a shared arm.
  for (const role of ["Super Admin", "CEO", "SFE Manager", "Training Manager"] as const) {
    assert.equal(
      canViewEmployeeAttendanceReport(ctx({ hrId: "X-1", role, scope: "company" }), { hrId: "B-155", managerHrId: "A-8" }),
      true,
      `${role} keeps whole-company attendance visibility`,
    );
  }

  // Guest / no-scope — denied even for self.
  assert.equal(canViewEmployeeAttendanceReport(ctx({ source: "guest" }), { hrId: "A-8", managerHrId: null }), false);
  assert.equal(canViewEmployeeAttendanceReport(ctx({ scope: "none" }), { hrId: "A-8", managerHrId: null }), false);

  // Missing identity — denied.
  assert.equal(canViewEmployeeAttendanceReport(ctx({ hrId: null }), { hrId: "B-155", managerHrId: "A-8" }), false);

  // resolveAttendanceScopeHrIds — findings #19/#20 fix. Bypass branches only (whole
  // company = null, no restriction); the direct-report expansion path hits Supabase
  // via loadAttendanceDirectReports and isn't unit-testable here, same limitation as
  // assertCanViewEmployeeAttendance above.
  assert.equal(
    await resolveAttendanceScopeHrIds(ctx({ scope: "system" })),
    null,
    "system scope must see the whole company",
  );
  // `scope: "company"` on its own NO LONGER grants whole-company attendance (changed 2026-08-10).
  // scopeForRole returns "company" for exactly Super Admin, CEO and Finance Manager; the first two
  // are named explicitly in the bypass, and the third must be self-only — so the scope arm was
  // admitting one role by accident and nobody by design. Asserted through a named role rather than
  // a bare scope, because a bare `scope: "company"` context now correctly falls to the
  // direct-report path, which needs Supabase and is not unit-testable here.
  assert.equal(
    await resolveAttendanceScopeHrIds(ctx({ hrId: "C-1", role: "CEO", scope: "company" })),
    null,
    "the CEO must still see the whole company",
  );
  // The Finance Manager's list is HIS OWN HR_ID — not null (which means no restriction at all), and
  // not his direct reports. This is the list-side half of the self-only carve-out; holding a role
  // out of one function but not the other is a hole.
  assert.deepEqual(
    await resolveAttendanceScopeHrIds(ctx({ hrId: "B-185", role: "Finance Manager", scope: "company" })),
    ["B-185"],
    "the Finance Manager's attendance scope must be exactly himself",
  );
  assert.equal(
    await resolveAttendanceScopeHrIds(ctx({ hrId: "S-1", role: "Super Admin", scope: "line" })),
    null,
    "Super Admin must see the whole company regardless of nominal scope",
  );
  assert.equal(
    await resolveAttendanceScopeHrIds(ctx({ hrId: "C-1", role: "CEO", scope: "line" })),
    null,
    "CEO must see the whole company regardless of nominal scope (matches its attendance:export grant)",
  );

  // Guest / no-scope — denied outright, never falls through to a direct-report lookup.
  await assert.rejects(
    () => resolveAttendanceScopeHrIds(ctx({ source: "guest" })),
    /Forbidden/,
    "guest source must be denied",
  );
  await assert.rejects(
    () => resolveAttendanceScopeHrIds(ctx({ scope: "none" })),
    /Forbidden/,
    "no-scope must be denied",
  );

  // Missing identity on a non-bypass caller — denied rather than silently unrestricted.
  await assert.rejects(
    () => resolveAttendanceScopeHrIds(ctx({ hrId: null, role: "Manager", scope: "team" })),
    /Forbidden/,
    "missing hrId on a non-bypass caller must be denied",
  );
}
