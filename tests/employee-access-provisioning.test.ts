import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";

export function runEmployeeAccessProvisioningTests() {
  assert.equal(
    resolveEmployeeAccessRole({ jobTitle: "Regional Sales Manager" }),
    "Regional Manager",
  );
  assert.equal(
    resolveEmployeeAccessRole({ positionTitle: "District Sales Manager" }),
    "District Manager",
  );
  assert.equal(
    resolveEmployeeAccessRole({ jobTitle: "Medical Representative" }),
    "Medical Rep",
  );
  assert.equal(
    resolveEmployeeAccessRole({ jobTitle: "Admin Assistant" }),
    "Employee",
  );

  const provisioningSource = readFileSync("src/lib/employees/access-provisioning.ts", "utf8");
  assert.match(provisioningSource, /resolveEmployeeAccessRole\(employee\)/);
  assert.match(provisioningSource, /upsertAccessUser/);

  const manualEmployeeRoute = readFileSync("app/api/employees/route.ts", "utf8");
  const bulkEmployeeRoute = readFileSync("app/api/imports/employees/confirm/route.ts", "utf8");
  const offerApprovalRoute = readFileSync("app/api/offers/[offerRef]/approve/route.ts", "utf8");
  assert.match(manualEmployeeRoute, /provisionNewHireAccess/);
  assert.match(bulkEmployeeRoute, /provisionNewHireAccess/);
  assert.match(offerApprovalRoute, /provisionNewHireAccess/);

  const accessControlSource = readFileSync("src/lib/admin/access-control.ts", "utf8");
  assert.match(accessControlSource, /from\("app_auth_users"\)/);
  assert.match(accessControlSource, /from\("user_access_profiles"\)/);
  assert.match(accessControlSource, /provisionSupabaseAuthIdentity/);
}
