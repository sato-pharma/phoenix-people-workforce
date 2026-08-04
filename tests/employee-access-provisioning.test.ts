import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";
import {
  getRolePrivilegeRank,
  permissionMatrix,
  phoenixCompanyJobTitles,
} from "../src/lib/auth/permissions.ts";

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

  // ── Talent Acquisition can finish a hire (2026-08-04) ────────────────────────────────
  // Adding an employee always tried to create their login through upsertAccessUser, whose
  // Super-Admin-only gate threw for every other role. The error was caught and rendered as a
  // note, so CN-0006 and PD-0007 were created with no way to sign in and nobody was told.
  const talentAcquisition = permissionMatrix["Talent Acquisition"];

  assert.ok(
    talentAcquisition.recruitment?.includes("approve"),
    "Talent Acquisition must be able to mark an application hired (POST /api/recruitment/applications/[id]/convert asserts recruitment:approve)",
  );
  assert.ok(
    !talentAcquisition.recruitment?.includes("delete"),
    "Talent Acquisition must still NOT delete applications or requisitions",
  );

  // The widened grants must not have leaked into user administration: creating a login goes
  // through the narrow create-only entry point below, never the Users & Access surface.
  for (const resource of ["user_admin", "admin_access", "permission_admin"] as const) {
    assert.equal(
      talentAcquisition[resource]?.length ?? 0,
      0,
      `Talent Acquisition must hold no ${resource} permission`,
    );
  }

  // The provisioning path routes a Talent Acquisition actor to the narrow entry point and
  // leaves Super Admin on the original one.
  assert.match(provisioningSource, /provisionEmployeeAccountForRecruiting/);
  assert.match(accessControlSource, /export async function provisionEmployeeAccountForRecruiting/);

  // That entry point must stay CREATE-ONLY — if it could edit an existing account it would
  // become a way to change roles without Super Admin.
  assert.match(
    accessControlSource,
    /provisionEmployeeAccountForRecruiting[\s\S]{0,1400}already exists/,
    "provisionEmployeeAccountForRecruiting must refuse an account that already exists",
  );
  assert.match(
    accessControlSource,
    /provisionEmployeeAccountForRecruiting[\s\S]{0,1400}cannot grant a sales scope override/,
    "provisionEmployeeAccountForRecruiting must refuse a sales scope override",
  );

  // The rank boundary is what actually stops Talent Acquisition creating a privileged
  // account: assertActorMayManageUser rejects any target whose rank is >= the actor's.
  const talentAcquisitionRank = getRolePrivilegeRank("Talent Acquisition");
  for (const blockedRole of ["Super Admin", "CEO", "Finance Manager", "Talent Acquisition"] as const) {
    assert.ok(
      getRolePrivilegeRank(blockedRole) >= talentAcquisitionRank,
      `${blockedRole} must rank at or above Talent Acquisition so provisioning refuses it`,
    );
  }
  for (const allowedRole of ["Employee", "Medical Rep", "District Manager"] as const) {
    assert.ok(
      getRolePrivilegeRank(allowedRole) < talentAcquisitionRank,
      `${allowedRole} must rank below Talent Acquisition so a new hire can be provisioned`,
    );
  }
}
