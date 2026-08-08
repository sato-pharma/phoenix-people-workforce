import assert from "node:assert/strict";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  canReadMarketingSalesEvidenceByRole,
  stripConfidentialSalesRows,
} from "../src/lib/marketing-requests/sales-evidence.ts";

// Two defects in the marketing sales-evidence panel, both verified against live production data.
//
//  1. ACCESS. The gate was a hard-coded role list — Marketing Manager, SFE Manager, Super Admin,
//     CEO — plus a system-scope bypass. The live approval chain is
//     National Sales Manager -> SFE Manager -> Marketing Manager -> CEO, and the NSM is in neither
//     the list nor system scope (scopeForRole puts it on "line"), so RUNG 1 OF 4 was hard-403'd and
//     decided with zero sales evidence. District Manager and Regional Manager were locked out the
//     same way. The chain is configurable per request, so the fix keys on "is this actor assigned
//     to a step on THIS request" rather than on more role names. The role half of that gate is
//     canReadMarketingSalesEvidenceByRole and is pure; the per-request half needs a database and is
//     exercised in the service, not here.
//
//  2. CONFIDENTIALITY. The panel read source_of_sales_import_rows with NO product filter, so
//     EGP 3,694,678 of restricted LA003 / LA004 / SS001 sales was reachable by Marketing Manager
//     and SFE Manager — neither of whom may see those products (src/lib/sales/access-scope.ts:
//     excluded from every total, KPI, chart, table, filter and export for everyone, revealable only
//     by CEO or Super Admin). stripConfidentialSalesRows closes that, and is applied to the rows as
//     they are fetched so every downstream figure is computed from filtered rows.
//
// Both functions are pure and called for real below — no database, no source-text matching.

function ctx(role: PhoenixRole, scope: AccessContext["scope"] = "line"): AccessContext {
  return { hrId: "TEST-1", loginId: "test-1", role, scope, source: "session" };
}

/** Roles whose remit covers every marketing request — the company-wide oversight path. */
const OVERSIGHT_ROLES: PhoenixRole[] = ["Marketing Manager", "SFE Manager", "Super Admin", "CEO"];

/** Roles with no company-wide claim. An NSM/DM/RM reaches the panel only as a named approver on
 *  the request itself; Product Manager only as a CC reviewer; Medical Rep never. */
const NON_OVERSIGHT_ROLES: PhoenixRole[] = [
  "National Sales Manager",
  "District Manager",
  "Regional Manager",
  "Medical Rep",
  "Product Manager",
];

function testRolePredicateAllowsCompanyWideOversight() {
  for (const role of OVERSIGHT_ROLES) {
    assert.equal(
      canReadMarketingSalesEvidenceByRole(ctx(role, "company")),
      true,
      `${role} has company-wide marketing oversight and must keep reading sales evidence`,
    );
  }
}

function testRolePredicateAllowsSystemScope() {
  // System scope is the server-to-server path and is role-independent — it must not be narrowed by
  // this change. Checked on a role that is otherwise denied, so it proves the SCOPE is what allows.
  for (const role of NON_OVERSIGHT_ROLES) {
    assert.equal(
      canReadMarketingSalesEvidenceByRole(ctx(role, "system")),
      true,
      `system scope must allow sales evidence regardless of role (${role})`,
    );
  }
}

function testRolePredicateDeniesEveryoneElse() {
  for (const role of NON_OVERSIGHT_ROLES) {
    assert.equal(
      canReadMarketingSalesEvidenceByRole(ctx(role)),
      false,
      `${role} has no company-wide claim on marketing sales evidence — it must fall through to the per-request approver check, not be allowed outright`,
    );
  }
  // The regression that started this: the NSM is rung 1 of the live chain. It must NOT be readmitted
  // by widening the role list, or the gate drifts away from the configurable chain all over again.
  assert.equal(
    canReadMarketingSalesEvidenceByRole(ctx("National Sales Manager", "line")),
    false,
    "National Sales Manager must be admitted per-request as an assigned approver, never by role",
  );
}

const RESTRICTED_ROWS = [
  { product_code: "LA003", product_name: "Lacto Basic 1", value: 1_000 },
  { product_code: "LA004", product_name: "Lacto Basic 2", value: 2_000 },
  { product_code: "SS001", product_name: "Satoslim", value: 3_000 },
];
const OPEN_ROWS = [
  { product_code: "TE003", product_name: "Tebofortine 40mg", value: 79 },
  { product_code: "TE002", product_name: "Tebofortine Forte 80", value: 120 },
];

function testConfidentialRowsStrippedForDisallowedRoles() {
  // Marketing Manager and SFE Manager are the two that could already open this panel; the NSM is the
  // role this change newly admits. None of the three may see the restricted products.
  const disallowed: PhoenixRole[] = [
    "Marketing Manager",
    "SFE Manager",
    "National Sales Manager",
    "Medical Rep",
  ];
  for (const role of disallowed) {
    const result = stripConfidentialSalesRows([...RESTRICTED_ROWS, ...OPEN_ROWS], role);
    assert.deepEqual(
      result.rows.map((row) => row.product_code),
      ["TE003", "TE002"],
      `${role} must not receive any LA003/LA004/SS001 row — that is the leak this closes`,
    );
    assert.equal(
      result.withheld,
      true,
      `${role} had confidential rows removed, so the panel must be told to announce the filter`,
    );
  }
}

function testConfidentialRowsKeptForCeoAndSuperAdmin() {
  for (const role of ["CEO", "Super Admin"] as PhoenixRole[]) {
    const rows = [...RESTRICTED_ROWS, ...OPEN_ROWS];
    const result = stripConfidentialSalesRows(rows, role);
    assert.deepEqual(
      result.rows.map((row) => row.product_code),
      ["LA003", "LA004", "SS001", "TE003", "TE002"],
      `${role} may reveal the restricted products, so every row must survive`,
    );
    assert.equal(
      result.withheld,
      false,
      `${role} had nothing withheld, so the panel must not claim figures were filtered`,
    );
  }
}

function testOpenProductsAreNeverStripped() {
  const result = stripConfidentialSalesRows(OPEN_ROWS, "Marketing Manager");
  assert.deepEqual(
    result.rows.map((row) => row.product_code),
    ["TE003", "TE002"],
    "a non-restricted product must never be removed — over-filtering understates the customer",
  );
  assert.equal(
    result.withheld,
    false,
    "nothing was removed, so no 'confidential products excluded' note may be shown",
  );
}

function testEmptyInputWithholdsNothing() {
  const result = stripConfidentialSalesRows([] as Array<{ product_code?: string | null }>, "Marketing Manager");
  assert.deepEqual(result.rows, [], "an empty history stays empty");
  assert.equal(
    result.withheld,
    false,
    "a customer with no sales at all must not be labelled as having confidential sales withheld",
  );
}

function testCodeMatchingIgnoresCaseAndWhitespace() {
  // Import rows are distributor-supplied text; a stray space or lower-case code must not be a way
  // past the lock.
  const rows = [
    { product_code: " la003 " },
    { product_code: "la004" },
    { product_code: "  SS001" },
    { product_code: "te003" },
  ];
  const result = stripConfidentialSalesRows(rows, "Marketing Manager");
  assert.deepEqual(
    result.rows.map((row) => row.product_code),
    ["te003"],
    "case and whitespace variants of a restricted code must still be stripped",
  );
  assert.equal(result.withheld, true, "the case/whitespace variants counted as withheld");
}

function testRowWithoutAProductCodeSurvives() {
  const rows = [{ product_code: null }, { product_code: "" }, { product_code: "LA003" }];
  const result = stripConfidentialSalesRows(rows, "Marketing Manager");
  assert.equal(
    result.rows.length,
    2,
    "a row carrying no product code has no product dimension to gate on and must pass through",
  );
  assert.equal(result.withheld, true, "the LA003 row was still removed");
}

export function runMarketingSalesEvidenceAccessTests() {
  testRolePredicateAllowsCompanyWideOversight();
  testRolePredicateAllowsSystemScope();
  testRolePredicateDeniesEveryoneElse();
  testConfidentialRowsStrippedForDisallowedRoles();
  testConfidentialRowsKeptForCeoAndSuperAdmin();
  testOpenProductsAreNeverStripped();
  testEmptyInputWithholdsNothing();
  testCodeMatchingIgnoresCaseAndWhitespace();
  testRowWithoutAProductCodeSurvives();
}
