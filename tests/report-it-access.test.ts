import assert from "node:assert/strict";

import { canViewAllReports, canExportReports } from "@/lib/report-it/service";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { permissionMatrix, permissionResources } from "@/lib/auth/permissions";
import type { AccessContext } from "@/lib/auth/permissions";

// Roles that see ALL reports and can export.
const ADMIN_REPORT_ROLES: PhoenixRole[] = ["Super Admin", "CEO", "Finance Manager"];

// Roles that may only see their own reports and cannot export.
const SELF_ONLY_ROLES: PhoenixRole[] = [
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "SFE Manager",
  "Training Manager",
  "Marketing Manager",
  "Talent Acquisition",
  "Manager",
];

function ctx(role: PhoenixRole, hrId = "test-001"): AccessContext {
  return { hrId, role, scope: "self", source: "session" };
}

export function runReportItAccessTests() {
  // ── canViewAllReports ─────────────────────────────────────────────────────

  for (const role of ADMIN_REPORT_ROLES) {
    assert.equal(
      canViewAllReports(ctx(role)),
      true,
      `${role} must be able to view all reports`,
    );
  }

  for (const role of SELF_ONLY_ROLES) {
    assert.equal(
      canViewAllReports(ctx(role)),
      false,
      `${role} must NOT be able to view all reports`,
    );
  }

  // ── canExportReports ──────────────────────────────────────────────────────

  for (const role of ADMIN_REPORT_ROLES) {
    assert.equal(
      canExportReports(ctx(role)),
      true,
      `${role} must be able to export reports`,
    );
  }

  for (const role of SELF_ONLY_ROLES) {
    assert.equal(
      canExportReports(ctx(role)),
      false,
      `${role} must NOT be able to export reports`,
    );
  }

  // ── No-hrId guard (canViewAllReports returns false for guest) ─────────────

  assert.equal(
    canViewAllReports({ hrId: null, role: "Super Admin", scope: "system", source: "system" }),
    true,
    "system/Super Admin with null hrId can still view all (service role caller)",
  );

  // ── Permission matrix: all roles have report_it ───────────────────────────

  assert.ok(
    permissionResources.includes("report_it"),
    "report_it must be present in permissionResources",
  );

  const allRoles: PhoenixRole[] = [
    "Super Admin", "CEO", "Finance Manager",
    "Employee", "Medical Rep", "District Manager", "Regional Manager",
    "National Sales Manager", "Product Manager", "Group Product Manager",
    "SFE Manager", "Training Manager", "Marketing Manager", "Talent Acquisition", "Manager",
  ];

  for (const role of allRoles) {
    const perms = permissionMatrix[role].report_it;
    assert.ok(
      Array.isArray(perms) && perms.includes("read") && perms.includes("create"),
      `${role} must have at least read+create on report_it (got: ${JSON.stringify(perms)})`,
    );
  }

  // ── Export permission shape: only admin roles ─────────────────────────────

  for (const role of ADMIN_REPORT_ROLES) {
    const perms = permissionMatrix[role].report_it ?? [];
    assert.ok(
      perms.includes("export"),
      `${role} must have export on report_it`,
    );
  }

  for (const role of SELF_ONLY_ROLES) {
    const perms = permissionMatrix[role].report_it ?? [];
    assert.equal(
      perms.includes("export"),
      false,
      `${role} must NOT have export on report_it`,
    );
  }
}
