import assert from "node:assert/strict";

import { permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { readFileSync } from "node:fs";

const permissionsSource = readFileSync(
  new URL("../src/lib/auth/permissions.ts", import.meta.url),
  "utf8",
);

const coachingPortalAccessSource = readFileSync(
  new URL("../src/lib/coaching/portal-access.ts", import.meta.url),
  "utf8",
);

function roleBlock(role: string) {
  const escapedRole = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = permissionsSource.match(new RegExp(`  ${escapedRole.includes(" ") ? `"${escapedRole}"` : escapedRole}: \\{[\\s\\S]*?\\n  \\},`));
  assert.ok(match, `${role} permission block must exist`);
  return match[0];
}

function assertCoachingPermission(role: string, expected: string) {
  const expectedPattern = expected === "allActions" ? "allActions" : `\\[${expected}\\]`;
  assert.match(
    roleBlock(role),
    new RegExp(`coaching: ${expectedPattern}`),
    `${role} coaching permission must be [${expected}]`,
  );
}

/**
 * Asserts against the COMPOSED matrix rather than the source text.
 *
 * The other helpers here scrape permissions.ts for a literal `"Role": { ... }` block, which works
 * only while every role's grants are written out by hand. The two HR bundles are composed from
 * hr-functions.ts (`hrBundleGrants("HR Advisory")`), so no literal block exists for them and the
 * scraper returns null — reported, correctly, as "permission block must exist". Reading the matrix
 * is what this assertion actually meant all along, and it survives a role whose grants are built
 * rather than typed. The scrapers above are left alone: for a hand-written role they additionally
 * pin the FORMATTING, which is what catches a silent widening in review.
 */
function assertNoCoachingManagementPermission(role: PhoenixRole) {
  const actions = permissionMatrix[role].coaching ?? [];
  for (const forbidden of ["create", "update", "delete", "approve", "export"] as const) {
    assert.ok(
      !actions.includes(forbidden),
      `${role} must not manage coaching reports — holds coaching:${forbidden}`,
    );
  }
}

export function runCoachingPermissionTests() {
  // canManageCoachingReports allows system scope, Super Admin, Training Manager, and the
  // product managers (Product / Group Product Manager submit coaching forms — using the
  // shared form for now, with a dedicated form planned later).
  for (const needle of [
    'context.scope === "system"',
    'context.role === "Super Admin"',
    'context.role === "Training Manager"',
    'context.role === "Product Manager"',
    'context.role === "Group Product Manager"',
  ]) {
    assert.ok(
      permissionsSource.includes(needle),
      `canManageCoachingReports must allow ${needle}`,
    );
  }

  assertCoachingPermission("Super Admin", "allActions");
  assertCoachingPermission("Training Manager", '"read", "create", "update"');
  assertCoachingPermission("Employee", '"read"');
  assertCoachingPermission("Medical Rep", '"read"');
  assertCoachingPermission("CEO", '"read"');
  // Product managers are coaches: they create AND update/submit their own coaching reports.
  assertCoachingPermission("Product Manager", '"read", "create", "update"');
  assertCoachingPermission("Group Product Manager", '"read", "create", "update"');
  assertNoCoachingManagementPermission("HR Advisory");
  assertNoCoachingManagementPermission("HR Operations");
  for (const role of [
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "SFE Manager",
    "Marketing Manager",
    "Manager",
  ] as const) {
    assertNoCoachingManagementPermission(role);
  }

  // resolveEmployeeCoachingPortalMode is a SEPARATE gate from the permission matrix and from the
  // sidebar flag: it decides whether the portal renders the "team" view at all, and a role missing
  // from it dead-ends on an empty state even with coaching:read + a visible tab. Regional Manager
  // was exactly that case until 2026-07-30. Keep all three field-manager roles listed here.
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager"] as const) {
    assert.match(
      coachingPortalAccessSource,
      new RegExp(`access\\.role === "${role}"`),
      `resolveEmployeeCoachingPortalMode must return the "team" view for ${role} — otherwise the Team Coaching tab renders an empty state`,
    );
  }
}
