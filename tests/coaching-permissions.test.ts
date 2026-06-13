import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const permissionsSource = readFileSync(
  new URL("../src/lib/auth/permissions.ts", import.meta.url),
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

function assertNoCoachingManagementPermission(role: string) {
  const coachingLine = roleBlock(role).match(/coaching: \[[^\]]*\]|coaching: allActions/)?.[0] ?? "";
  assert.doesNotMatch(coachingLine, /create|update|delete|approve|export|allActions/, `${role} must not manage coaching reports`);
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
  // Product managers can now create coaching reports.
  assertCoachingPermission("Product Manager", '"read", "create"');
  assertCoachingPermission("Group Product Manager", '"read", "create"');
  assertNoCoachingManagementPermission("Talent Acquisition");
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
}
