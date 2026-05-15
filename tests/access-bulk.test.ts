import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  accessBulkCanonicalHeaders,
  buildAccessBulkHeaderMap,
  resolveAccessBulkHeader,
  validateAccessBulkRows,
  type AccessBulkDirectoryEmployee,
} from "../src/lib/admin/access-bulk.ts";

const bulkRouteSource = readFileSync(new URL("../app/api/admin/users/bulk/route.ts", import.meta.url), "utf8");
const bulkActionRouteSource = readFileSync(new URL("../app/api/admin/users/bulk-action/route.ts", import.meta.url), "utf8");
const accessManagerSource = readFileSync(new URL("../src/components/admin/access-control-manager.tsx", import.meta.url), "utf8");

const directoryEmployees: AccessBulkDirectoryEmployee[] = [
  {
    fullName: "Active Employee",
    hrId: "E1001",
    lineName: "CNS",
    managerHrId: "M1001",
  },
  {
    fullName: "Active Manager",
    hrId: "M1001",
    lineName: "CNS",
    managerHrId: null,
  },
];

export function runAccessBulkTests() {
  assert.deepEqual(
    accessBulkCanonicalHeaders,
    ["HR_ID", "Name", "Email", "Role", "Line", "Manager_HR_ID", "Sales_Scope", "Active", "Notes"],
    "Bulk template headers must stay aligned with upload parsing.",
  );
  assert.equal(resolveAccessBulkHeader(" Is Active "), "Active");
  assert.equal(resolveAccessBulkHeader("Sales Scope"), "Sales_Scope");
  assert.equal(resolveAccessBulkHeader("unknown privilege"), null);

  const headerMap = buildAccessBulkHeaderMap([
    "HR_ID *",
    "Name",
    "Email",
    "Role *",
    "Line *",
    "Manager_HR_ID",
    "Sales_Scope",
    "Active *",
    "Notes",
    "Password",
  ]);
  assert.deepEqual(headerMap.missingRequiredHeaders, []);
  assert.deepEqual(headerMap.unknownHeaders, ["Password"]);

  const invalidRows = validateAccessBulkRows({
    actorRole: "HR Specialist",
    directoryEmployees,
    rows: [
      {
        row: 5,
        values: {
          Active: "TRUE",
          Email: "active.employee@company.com",
          HR_ID: "E1001",
          Line: "CNS",
          Manager_HR_ID: "M1001",
          Name: "Active Employee",
          Notes: "safe note",
          Role: "Employee",
          Sales_Scope: "TEAM",
        },
      },
      {
        row: 6,
        values: {
          Active: "maybe",
          Email: "active.employee@company.com",
          HR_ID: "E1001",
          Line: "Unknown",
          Manager_HR_ID: "MISSING",
          Name: "=FORMULA()",
          Role: "Super Admin",
        },
      },
      {
        row: 7,
        values: {
          Active: "TRUE",
          HR_ID: "RESIGNED1",
          Line: "CNS",
          Role: "Employee",
        },
      },
    ],
  });

  assert.equal(invalidRows.rows.length, 0, "Duplicate HR_ID/email rows should not partially mutate.");
  assert.equal(invalidRows.errorsByRow.get(5)?.some((error) => error.code === "duplicate_hr_id"), true);
  assert.equal(invalidRows.errorsByRow.get(5)?.some((error) => error.code === "duplicate_email"), true);
  assert.equal(invalidRows.errorsByRow.get(6)?.some((error) => error.code === "duplicate_hr_id"), true);
  assert.equal(invalidRows.errorsByRow.get(6)?.some((error) => error.code === "duplicate_email"), true);
  assert.equal(invalidRows.errorsByRow.get(6)?.some((error) => error.code === "invalid_active"), true);
  assert.equal(invalidRows.errorsByRow.get(6)?.some((error) => error.code === "unsafe_spreadsheet_text"), true);
  assert.equal(invalidRows.errorsByRow.get(6)?.some((error) => error.code === "unauthorized_super_admin_import"), true);
  assert.equal(invalidRows.errorsByRow.get(7)?.some((error) => error.code === "employee_not_active"), true);

  const validRows = validateAccessBulkRows({
    actorRole: "Super Admin",
    directoryEmployees,
    rows: [{
      row: 5,
      values: {
        Active: "TRUE",
        Email: "active.employee@company.com",
        HR_ID: "E1001",
        Line: "CNS",
        Manager_HR_ID: "M1001",
        Name: "Active Employee",
        Role: "Employee",
        Sales_Scope: "TEAM",
      },
    }],
  });
  assert.equal(validRows.rows.length, 1);
  assert.equal(validRows.rows[0].salesScopeOverride, "TEAM");

  assert.match(bulkRouteSource, /accessBulkTemplateFileName/, "Template download must use the canonical template filename.");
  assert.match(bulkRouteSource, /loadTemplateDirectory\(\)/, "Template download must be populated from active Employees master data.");
  assert.match(bulkRouteSource, /existingUsersResult\.data/, "Template download must include existing Users & Access values when available.");
  assert.match(bulkRouteSource, /Not provisioned\. Upload to create access profile/, "Template must identify active employees without access profiles.");
  assert.match(bulkRouteSource, /dataValidation/, "Template workbook must include Excel dropdown validation.");
  assert.match(bulkRouteSource, /Unknown columns are rejected/, "Unknown columns must not mutate access silently.");
  assert.match(bulkRouteSource, /Do not add passwords, setup links, reset URLs, or tokens/, "Template must warn against sensitive token data.");
  assert.doesNotMatch(bulkRouteSource, /setupUrl|resetUrl|token:/, "Bulk import route must not export setup/reset URLs or tokens.");
  assert.match(bulkActionRouteSource, /governanceReason/, "Bulk actions must preserve governance reasons.");
  assert.match(bulkActionRouteSource, /Duplicate loginIds are not allowed/, "Bulk action route must reject duplicate loginIds.");
  assert.match(bulkActionRouteSource, /user_admin", "update"/, "Bulk action route must enforce user_admin:update.");
  assert.match(accessManagerSource, /users_access_template_v1\.xlsx/, "UI must show the canonical template filename.");
  assert.match(accessManagerSource, /errorDetails/, "UI must render structured row-level import errors.");
}
