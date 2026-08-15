import assert from "node:assert/strict";

import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";

// The employee-portal sidebar must follow the APP ACCESS role, not the HR job title.
//
// The concrete case: a Medical Rep is elevated to act as a District Manager. Her app role
// (app_auth_users.role) is set to "District Manager", but HR deliberately keeps her
// employees.job_title as "Medical Representative". Every server-side permission check uses the app
// access role, so her real access IS District Manager — but the portal shell passed the job-title-
// derived roleLabel first, so resolvePortalRole classified her as a Medical Rep and hid Direct
// Orders and every other District Manager tab. resolvePortalRole now tries the access role first and
// only falls back to the title, so the nav matches the permissions she actually holds.
export function runPortalNavActingDmUsesAppRoleTests() {
  // 1) The acting-DM fix: job title "Medical Representative", app access role "District Manager".
  // She must get the District Manager sidebar — Direct Orders + Team Performance both appear.
  const actingDm = resolveEmployeePortalNavVisibility(
    "Medical Representative",
    "District Manager",
    "Anti Infective",
    null,
    "B-1",
  );
  assert.equal(
    actingDm.showDirectOrdersTab,
    true,
    "A Medical Rep acting as District Manager (app role = District Manager) must see Direct Orders — the nav follows the app access role, not the 'Medical Representative' job title",
  );
  assert.equal(
    actingDm.showTeamPerformanceTab,
    true,
    "The same acting-DM must see Team Performance — every District Manager tab follows the app access role",
  );

  // 2) A genuine Medical Rep is unaffected: both title and app role say Medical Rep, so Direct
  // Orders stays hidden. Guards against the fix accidentally widening the requester set.
  const genuineRep = resolveEmployeePortalNavVisibility(
    "Medical Representative",
    "Medical Rep",
    "Anti Infective",
    null,
    "X-1",
  );
  assert.equal(
    genuineRep.showDirectOrdersTab,
    false,
    "A genuine Medical Rep (app role = Medical Rep) must NOT see Direct Orders — Medical Rep is not a Direct Order requester role",
  );

  // 3) Historical fallback preserved: an un-upgraded manager account whose app role is still the
  // default "Employee" but whose real role lives in its title ("District Sales Manager") is still
  // classified by the title. accessRole "Employee" yields nothing definite, so the title fallback
  // supplies District Manager — exactly as before this change.
  const unUpgradedManager = resolveEmployeePortalNavVisibility(
    "District Sales Manager",
    "Employee",
    "Pedia",
    null,
    "Y-1",
  );
  assert.equal(
    unUpgradedManager.showDirectOrdersTab,
    true,
    "An un-upgraded District-Manager-by-title account (app role still default 'Employee') must keep Direct Orders — the job-title fallback is preserved",
  );
}
