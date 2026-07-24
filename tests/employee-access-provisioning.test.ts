import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";
import { phoenixCompanyJobTitles } from "../src/lib/auth/permissions.ts";

export function runEmployeeAccessProvisioningTests() {
  // GOVERNANCE: a job title is descriptive only and is never a permission
  // source. Provisioning resolves every job/position title — including ones that
  // look senior — to the least-privilege Employee role. The real access role is
  // assigned explicitly on app_auth_users afterwards.
  for (const title of [
    "Regional Sales Manager",
    "District Sales Manager",
    "Medical Representative",
    "Admin Assistant",
    "Admin Assist",
    "HR Manager",
    "Talent Acquisition",
    "R&D Manager",
    "Research and Development Manager",
    "Finance Manager",
    "National Sales Manager",
    "Product Manager",
    "CEO",
  ]) {
    assert.equal(
      resolveEmployeeAccessRole({ jobTitle: title }),
      "Employee",
      `Job title "${title}" must not auto-grant a role; roles are assigned explicitly.`,
    );
    assert.equal(
      resolveEmployeeAccessRole({ positionTitle: title }),
      "Employee",
      `Position title "${title}" must not auto-grant a role; roles are assigned explicitly.`,
    );
  }

  // The company job titles remain known *display labels* in the model, but a
  // label is never a permission source: each one still provisions as Employee.
  const expectedCompanyTitles = [
    "District Sales Manager",
    "Medical Representative",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Admin Assist",
    "SFE Manager",
    "QPPV",
    "Buffet",
    "Training Manager",
    "Marketing Manager",
    "Office Co-ordinator",
    "Regulatory Affairs",
    "Talent Acquisition",
    "Finance Manager",
    "CEO",
    "HR Manager",
    "R&D Manager",
    "Research and Development Manager",
    "Financial Advisor",
  ];
  for (const title of expectedCompanyTitles) {
    assert.ok(
      (phoenixCompanyJobTitles as readonly string[]).includes(title),
      `${title} must remain in the Phoenix company title list`,
    );
    assert.equal(
      resolveEmployeeAccessRole({ jobTitle: title }),
      "Employee",
      `${title} is a display label only and must not grant a permission role`,
    );
  }

  const provisioningSource = readFileSync("src/lib/employees/access-provisioning.ts", "utf8");
  assert.match(provisioningSource, /resolveEmployeeAccessRole\(employee\)/);
  assert.match(provisioningSource, /upsertAccessUser/);

  const manualEmployeeRoute = readFileSync("app/api/employees/route.ts", "utf8");
  const bulkEmployeeRoute = readFileSync("app/api/imports/employees/confirm/route.ts", "utf8");
  assert.match(manualEmployeeRoute, /provisionNewHireAccess/);
  assert.match(bulkEmployeeRoute, /provisionNewHireAccess/);

  const accessControlSource = readFileSync("src/lib/admin/access-control.ts", "utf8");
  assert.match(accessControlSource, /from\("app_auth_users"\)/);
  assert.match(accessControlSource, /from\("user_access_profiles"\)/);
  assert.match(accessControlSource, /provisionSupabaseAuthIdentity/);
}
