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
  assert.match(
    permissionsSource,
    /return context\.scope === "system" \|\| context\.role === "Super Admin" \|\| context\.role === "Training Manager";/,
    "canManageCoachingReports must only allow system, Super Admin, and Training Manager",
  );

  assertCoachingPermission("Super Admin", "allActions");
  assertCoachingPermission("Training Manager", '"read", "create", "update"');
  assertCoachingPermission("Employee", '"read"');
  assertCoachingPermission("Medical Rep", '"read"');
  assertCoachingPermission("CEO", '"read"');
  assertNoCoachingManagementPermission("Talent Acquisition");
  for (const role of [
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "SFE Manager",
    "Marketing Manager",
    "Manager",
  ] as const) {
    assertNoCoachingManagementPermission(role);
  }
}
