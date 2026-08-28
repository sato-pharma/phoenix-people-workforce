import assert from "node:assert/strict";

import type { PhoenixRole } from "@/lib/auth/permissions";
import { permissionMatrix, permissionResources } from "@/lib/auth/permissions";

// canViewAllReports now delegates to canAccess(ctx, "report_it", "export") which
// queries the DB for overrides. The gate is verified here via the static matrix.
const ADMIN_REPORT_ROLES: PhoenixRole[] = ["Super Admin", "CEO", "Finance Manager"];

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
  "HR Advisory",
  "HR Operations",
  "Manager",
];

export function runReportItAccessTests() {
  // ── Permission matrix: report_it resource exists ──────────────────────────

  assert.ok(
    permissionResources.includes("report_it"),
    "report_it must be present in permissionResources",
  );

  // ── All roles have at least read + create ─────────────────────────────────

  const allRoles: PhoenixRole[] = [
    "Super Admin", "CEO", "Finance Manager",
    "Employee", "Medical Rep", "District Manager", "Regional Manager",
    "National Sales Manager", "Product Manager", "Group Product Manager",
    "SFE Manager", "Training Manager", "Marketing Manager", "HR Advisory", "HR Operations", "Manager",
  ];

  for (const role of allRoles) {
    const perms = permissionMatrix[role].report_it;
    assert.ok(
      Array.isArray(perms) && perms.includes("read") && perms.includes("create"),
      `${role} must have at least read+create on report_it (got: ${JSON.stringify(perms)})`,
    );
  }

  // ── Export (= view-all) only granted to admin-report roles ────────────────

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
