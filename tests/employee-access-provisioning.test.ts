import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";
import {
  getRolePrivilegeRank,
  permissionMatrix,
  phoenixCompanyJobTitles,
} from "../src/lib/auth/permissions.ts";

export function runEmployeeAccessProvisioningTests() {
  // GOVERNANCE: a job title is descriptive only and is never a general permission
  // source. Provisioning resolves every job/position title — including ones that
  // look senior — to the least-privilege Employee role, EXCEPT the two field-force
  // titles allowlisted in access-role.ts (owner-approved 2026-08-10, asserted
  // below). The real access role for anyone else is assigned explicitly on
  // app_auth_users afterwards.
  //
  // Regional/National Sales Manager stay on this list on purpose: HIERARCHY and
  // LINE scope reach far beyond one team, so they are elevated by hand.
  for (const title of [
    "Regional Sales Manager",
    "Admin Assistant",
    "Admin Assist",
    "HR Manager",
    "HR Advisory",
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

  // ── Field-force titles DO provision with their role (owner-approved 2026-08-10) ──────
  // Six accounts (PD-0004, PD-0006, PD-0008, PD-0009, PD-0010, CN-0005) sat crippled on
  // the Employee role for weeks because the manual elevation step was forgotten. A DSM on
  // Employee cannot even approve his own reps' leave. These two titles are the entire
  // allowlist; both are privilege rank 100, so nothing gains admin reach.
  for (const [title, expected] of [
    ["District Sales Manager", "District Manager"],
    ["district sales manager", "District Manager"],
    ["  District   Sales   Manager  ", "District Manager"],
    ["DSM", "District Manager"],
    ["Medical Representative", "Medical Rep"],
    ["medical representative", "Medical Rep"],
    ["Medical Rep", "Medical Rep"],
  ] as const) {
    assert.equal(
      resolveEmployeeAccessRole({ jobTitle: title }),
      expected,
      `Job title "${title}" must provision as ${expected}, not Employee`,
    );
    assert.equal(
      resolveEmployeeAccessRole({ positionTitle: title }),
      expected,
      `Position title "${title}" must provision as ${expected}, not Employee`,
    );
  }

  // ── ANTI-ESCALATION: typed text must never become a privileged role ──────────────────
  // resolveEmployeeAccessRole must NOT delegate to normalizeRole/resolveJobFunctionRole:
  // both parse any canonical role string, and these are REAL employees.job_title values in
  // production. A parser fallback would hand out CEO from a job title.
  for (const title of [
    "Ceo",
    "CEO",
    "Super Admin",
    "Sfe Manager",
    "SFE Manager",
    "HR Advisory",
    "Finance Manager",
    "Marketing Manager",
    "Training Manager",
    "Group Product Manager",
    "Regional Manager",
    "Manager",
  ]) {
    assert.equal(
      resolveEmployeeAccessRole({ jobTitle: title }),
      "Employee",
      `Job title "${title}" must NOT auto-grant a privileged role — that would make typed text a permission source`,
    );
  }

  // The guardrail that keeps the above true: no parser fallback in the module.
  const accessRoleSource = readFileSync("src/lib/employees/access-role.ts", "utf8");
  for (const forbidden of ["normalizeRole", "resolveJobFunctionRole", "parseRoleStrict"]) {
    assert.ok(
      !accessRoleSource.includes(`${forbidden}(`),
      `access-role.ts must not call ${forbidden} — it resolves any role string and would turn a job title into a privilege grant`,
    );
  }

  // Blank/unknown titles fall back to least privilege.
  for (const title of [null, undefined, "", "   ", "Buffet", "Qppv", "Totally Made Up Title"]) {
    assert.equal(resolveEmployeeAccessRole({ jobTitle: title }), "Employee");
  }

  // The company job titles remain known *display labels* in the model. Outside the
  // field-force allowlist above, a label is never a permission source.
  const fieldForceTitles = new Set(["District Sales Manager", "Medical Representative"]);
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
    // TITLES, not roles — the distinction this whole file exists to hold. "Talent Acquisition" and
    // "Office Co-ordinator" are the two seats retired on 2026-08-28; they stay in the title list
    // because employees HELD them and a historical record must still resolve, while neither is a
    // PhoenixRole any more. The two new titles sit beside them, and both provision as Employee
    // exactly like every other non-field-force title: a job title has never been a permission
    // source here, which is the mistake being corrected — twice now, after "HR Specialist".
    "Talent Acquisition",
    // "HR Operations Coordinator" left the title list on 2026-10-20, renamed "HR Generalist" (owner:
    // "make the old account HR genralist"); "HR Operations Specialist" is the new seat's title. Both
    // are display labels: neither may provision the "HR Operations" or "HR Administration" role.
    "HR Generalist",
    "HR Operations Specialist",
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
    if (fieldForceTitles.has(title)) continue;
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

  // ── HR Advisory can finish a hire (2026-08-04) ────────────────────────────────
  // Adding an employee always tried to create their login through upsertAccessUser, whose
  // Super-Admin-only gate threw for every other role. The error was caught and rendered as a
  // note, so CN-0006 and PD-0007 were created with no way to sign in and nobody was told.
  // The seat that finishes a hire is the Talent Acquisition seat since "move recruiting off the HR Business Partner" (owner, 2026-10-08);
  // its blueprint answer "Yes — she closes the hire" is what this pins now.
  const hrAdvisory = permissionMatrix["HR Resourcing"];

  assert.ok(
    hrAdvisory.recruitment?.includes("approve"),
    "the Talent Acquisition seat must be able to mark an application hired (POST /api/recruitment/applications/[id]/convert asserts recruitment:approve)",
  );
  assert.ok(
    !permissionMatrix["HR Advisory"].recruitment?.includes("approve"),
    "HR Advisory no longer finishes a hire: recruiting moved off her seat on 2026-10-08",
  );
  assert.ok(
    !hrAdvisory.recruitment?.includes("delete"),
    "HR Advisory must still NOT delete applications or requisitions",
  );

  // The widened grants must not have leaked into user administration: creating a login goes
  // through the narrow create-only entry point below, never the Users & Access surface.
  for (const resource of ["user_admin", "admin_access", "permission_admin"] as const) {
    assert.equal(
      hrAdvisory[resource]?.length ?? 0,
      0,
      `HR Advisory must hold no ${resource} permission`,
    );
  }

  // The provisioning path routes a HR Advisory actor to the narrow entry point and
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

  // The rank boundary is what actually stops the HR seat creating a privileged account:
  // assertActorMayManageUser rejects any target whose rank is >= the actor's. The actor is HR
  // Operations (provisionEmployeeAccountForRecruiting refuses anyone else); this read the HR
  // Business Partner's rank until the owner retired the HR Business Partner seat on 2026-10-08, and the two ranks were the same.
  const hrAdvisoryRank = getRolePrivilegeRank("HR Operations");
  for (const blockedRole of ["Super Admin", "CEO", "Finance Manager", "HR Operations", "HR Resourcing"] as const) {
    assert.ok(
      getRolePrivilegeRank(blockedRole) >= hrAdvisoryRank,
      `${blockedRole} must rank at or above the HR seat so provisioning refuses it`,
    );
  }
  for (const allowedRole of ["Employee", "Medical Rep", "District Manager"] as const) {
    assert.ok(
      getRolePrivilegeRank(allowedRole) < hrAdvisoryRank,
      `${allowedRole} must rank below the HR seat so a new hire can be provisioned`,
    );
  }
}
