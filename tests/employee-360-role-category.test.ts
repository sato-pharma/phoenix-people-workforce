import assert from "node:assert/strict";

import {
  EMPLOYEE_360_ROLE_META,
  EMPLOYEE_360_ROLE_ORDER,
  isFieldLeaderCategory,
  resolveEmployee360RoleCategory,
  type Employee360RoleCategory,
} from "../src/lib/employee-360/roles.ts";

// Employee 360 is scoped to six field-force role families shown as tabs; every
// other title is excluded (null) and shows an out-of-scope state. This locks that
// scoping — the exact ask ("those tabs … any other roles remove from this report").

export async function runEmployee360RoleCategoryTests() {
  // ── The six covered families, via their real descriptive titles ──
  const covered: [string, Employee360RoleCategory][] = [
    ["Medical Representative", "medical-rep"],
    ["Medical Rep", "medical-rep"],
    ["District Sales Manager", "district-manager"],
    ["District Manager", "district-manager"],
    ["Regional Sales Manager", "regional-manager"],
    ["National Sales Manager", "national-sales-manager"],
    ["Product Manager", "product-manager"],
    ["Group Product Manager", "product-manager"], // PM + GPM collapse into one tab
    ["Training Manager", "training-manager"],
  ];
  for (const [title, expected] of covered) {
    assert.equal(resolveEmployee360RoleCategory(title), expected, `${title} → ${expected}`);
  }

  // Case/whitespace-insensitive (titles come straight from the directory).
  assert.equal(resolveEmployee360RoleCategory("  district sales manager  "), "district-manager", "trimmed + lowercased");

  // ── Everyone else is OUT OF SCOPE (null) — the "remove other roles" rule ──
  for (const title of [
    "SFE Manager",
    "Marketing Manager",
    "Admin Assistant",
    "Office Coordinator",
    "Talent Acquisition",
    "HR Manager",
    "Finance Manager",
    "Financial Advisor",
    "R And D Manager",
    "QPPV",
    "Buffet",
    "CEO",
    "",
  ]) {
    assert.equal(resolveEmployee360RoleCategory(title), null, `${title || "(empty)"} is out of scope`);
  }
  assert.equal(resolveEmployee360RoleCategory(null), null, "null is out of scope");
  assert.equal(resolveEmployee360RoleCategory(undefined), null, "undefined is out of scope");

  // ── Field-leader flag: everyone but the Medical Rep delivers coaching/DVs ──
  assert.equal(isFieldLeaderCategory("medical-rep"), false, "Medical Rep is not a leader");
  for (const c of ["district-manager", "regional-manager", "national-sales-manager", "product-manager", "training-manager"] as const) {
    assert.equal(isFieldLeaderCategory(c), true, `${c} is a field leader`);
  }
  assert.equal(isFieldLeaderCategory(null), false, "null is not a leader");

  // ── Tab metadata + order integrity ──
  assert.equal(EMPLOYEE_360_ROLE_ORDER.length, 6, "exactly six role tabs");
  assert.equal(new Set(EMPLOYEE_360_ROLE_ORDER).size, 6, "no duplicate tabs");
  for (const c of EMPLOYEE_360_ROLE_ORDER) {
    const meta = EMPLOYEE_360_ROLE_META[c];
    assert.ok(meta && meta.label && meta.tab && meta.description, `${c} has complete tab metadata`);
  }
}
