import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assignablePhoenixRoles,
  canAccess,
  canSeeEmployee,
  createAccessContext,
  filterEmployeeDirectoryForAccess,
  getExpensesScope,
  getPayrollScope,
  getSalesScope,
  isRolePermissionWithinHardBoundary,
  isSalaryRedactedForViewer,
  permissionMatrix,
  phoenixRoles,
  resolveNavigationMode,
  type PermissionAction,
  type PermissionResource,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import type { EmployeeDirectoryData, EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";

export async function runPhase22RoleMatrixSecurityTests() {
  const phase22Smoke = readFileSync("scripts/phase22-role-matrix-security-smoke.ts", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");

  assert.match(phase22Smoke, /Super Admin/);
  assert.match(phase22Smoke, /HR Advisory/);
  assert.match(phase22Smoke, /Finance Manager/);
  assert.match(phase22Smoke, /Marketing Manager/);
  assert.match(phase22Smoke, /CEO/);
  assert.match(phase22Smoke, /District Manager/);
  assert.match(phase22Smoke, /Medical Rep/);
  assert.match(phase22Smoke, /Employee/);
  assert.match(phase22Smoke, /Employee cannot see accidental direct report/);
  assert.match(phase22Smoke, /Medical Rep cannot see accidental direct report/);
  assert.match(phase22Smoke, /Admin payroll page redirects non-company payroll scopes to payslips/);
  assert.match(phase22Smoke, /Employee portal payroll fetch is current-HR-ID only/);
  assert.match(phase22Smoke, /Payroll upload mutation requires payroll import/);
  assert.match(phase22Smoke, /Sales upload mutation requires sales import/);
  assert.match(phase22Smoke, /Users bulk mutation requires user admin update/);
  assert.match(phase22Smoke, /every role-sensitive table in the list still exists/);
  assert.match(phase22Smoke, /role-sensitive business tables keep RLS enabled/);
  // Same expense data as outstation_expenses — dropping it silently narrows the RLS check.
  assert.match(phase22Smoke, /"expense_claims"/);
  assert.doesNotMatch(phase22Smoke, /\.insert\(/);
  assert.doesNotMatch(phase22Smoke, /\.update\(/);
  assert.doesNotMatch(phase22Smoke, /\.delete\(/);

  assert.match(permissionsSource, /function canSeeDirectReportsByRole/);
  assert.match(permissionsSource, /return canSeeDirectReportsByRole\(context\.role\) && isDirectReport/);

  const employee = createAccessContext({ hrId: "E-1", role: "Employee" });
  const medicalRep = createAccessContext({ hrId: "MR-1", role: "Medical Rep" });
  const districtManager = createAccessContext({ hrId: "DSM-1", role: "District Manager" });
  const hrAdvisory = createAccessContext({ hrId: "A-16", role: "HR Advisory" });
  const financeManager = createAccessContext({ hrId: "FIN-1", role: "Finance Manager" });
  const marketingManager = createAccessContext({ hrId: "A-9", role: "Marketing Manager" });
  const superAdmin = createAccessContext({ hrId: "SA-1", role: "Super Admin" });

  assert.equal(canSeeEmployee(employee, { hrId: "E-1", managerHrId: "DSM-1" }), true);
  assert.equal(canSeeEmployee(employee, { hrId: "E-2", managerHrId: "E-1" }), false);
  assert.equal(canSeeEmployee(medicalRep, { hrId: "MR-2", managerHrId: "MR-1" }), false);
  assert.equal(canSeeEmployee(districtManager, { hrId: "MR-2", managerHrId: "DSM-1" }), true);

  // Regional Manager / NSM subtree visibility (2026-08-05): with the directory index supplied
  // (list surfaces build it), they see through intermediate managers. Without it, the
  // conservative single-hop behaviour is preserved, and non-manager roles gain nothing.
  const regionalManager = createAccessContext({ hrId: "RSM-1", role: "Regional Manager" });
  const nationalSalesManager = createAccessContext({ hrId: "NSM-1", role: "National Sales Manager" });
  const indexKey = (hrId: string) => canonicalHrIdKey(hrId) ?? "";
  const subtreeIndex = new Map([
    [indexKey("DSM-1"), { managerHrId: "RSM-1", pendingManagerReplacementForHrId: null }],
    [indexKey("RSM-1"), { managerHrId: "NSM-1", pendingManagerReplacementForHrId: null }],
    [indexKey("MR-2"), { managerHrId: "DSM-1", pendingManagerReplacementForHrId: null }],
    [indexKey("E-9"), { managerHrId: "OTHER-BOSS", pendingManagerReplacementForHrId: null }],
  ]);
  assert.equal(
    canSeeEmployee(regionalManager, { hrId: "MR-2", managerHrId: "DSM-1" }, { byCanonicalHrId: subtreeIndex }),
    true,
    "an RM sees a rep two hops down once the directory index is supplied",
  );
  assert.equal(
    canSeeEmployee(regionalManager, { hrId: "MR-2", managerHrId: "DSM-1" }),
    false,
    "without an index the RM keeps the conservative single-hop behaviour",
  );
  assert.equal(
    canSeeEmployee(nationalSalesManager, { hrId: "MR-2", managerHrId: "DSM-1" }, { byCanonicalHrId: subtreeIndex }),
    true,
    "an NSM sees the whole chain through DM and RSM",
  );
  assert.equal(
    canSeeEmployee(regionalManager, { hrId: "E-9", managerHrId: "OTHER-BOSS" }, { byCanonicalHrId: subtreeIndex }),
    false,
    "someone outside the subtree stays invisible even with the index",
  );
  assert.equal(
    canSeeEmployee(employee, { hrId: "E-2", managerHrId: "E-1" }, { byCanonicalHrId: subtreeIndex }),
    false,
    "an Employee gains nothing from the index — the subtree walk is manager-roles only",
  );
  assert.equal(
    canSeeEmployee(districtManager, {
      hrId: "MR-3",
      managerHrId: "DEPARTED-DM",
      pendingManagerReplacementForHrId: "DSM-1",
    }),
    true,
    "the seat-continuity marker keeps a mid-replacement report visible to the stand-in DM",
  );
  const hrOperations = createAccessContext({ hrId: "A-17", role: "HR Operations" });

  // ── The shell moved (owner, 2026-08-28); the SCOPES then split (owner, 2026-08-29) ───────────
  // The retired HR Advisory seat was moved OUT of the admin shell on 2026-07-24 and into
  // the employee portal; its two successors are back on the admin shell.
  //
  // This block asserted scope "self" for BOTH seats in one loop, and said that asserting scope and
  // shell together is what catches a future "just give her company scope" shortcut. It still does
  // — for HR Advisory, where the reasoning below is unchanged and her company-wide visibility comes
  // from targeted per-feature carve-outs (canSeeEmployee, canAccessCompanyOrganogram,
  // canAccessCompanyVacancies), never a scope change. HR Operations was moved to "company" by the
  // owner's explicit ruling on 2026-08-29, so the two are asserted SEPARATELY now: a loop over both
  // seats cannot express "one moved and the other must not", and collapsing them again is how the
  // seat that did not move would quietly follow the seat that did.
  //
  // Why that move is not the shortcut this guard was built to stop. `canAccess` short-circuits on
  // scope === "system" ONLY, so "company" is inert against the permission matrix and hands her no
  // permission she did not already hold — tests/hr-operations-company-scope.test.ts proves it by
  // exhausting every resource/action pair under both scopes and requiring every answer to be
  // identical, so if "company" ever gains a shortcut of its own that suite goes red for every HR
  // grant at once. What the scope IS read by is four separate mechanisms, and getPayrollScope is
  // the one that mattered: /payroll and /admin/payslips-center redirect on it BEFORE reaching the
  // permission check, so the payroll and payslips grants she was already given bounced her at the
  // door while she resolved to "self" — granted on paper, refused in practice.
  assert.equal(hrAdvisory.scope, "self", "an HR Advisory AccessScope stays self — carve-outs, never scope");
  assert.equal(
    hrOperations.scope,
    "company",
    "HR Operations resolves to company scope on the owner's 2026-08-29 ruling — she administers " +
      "attendance, leave and payroll inputs for the whole company. If this ever reads \"self\" again, " +
      "her Payroll Report and Payslips Center rows are visible and both redirect on open",
  );
  // HR Advisory was the other seat in this loop until the owner retired it on 2026-10-08; the
  // dormant key holds nothing (tests/hr-advisory-module-access.test.ts pins that).
  for (const seat of [hrOperations]) {
    assert.equal(resolveNavigationMode(seat), "admin");
    assert.equal(await canAccess(seat, "employee_profile", "read"), true);
    assert.equal(await canAccess(seat, "employee_profile", "update"), true);
    // The self-service floor (HR_SEAT_SELF_SERVICE in hr-functions.ts). Composing a seat purely
    // from HR functions produced one that could administer everyone's leave and payslip and not
    // reach her own; /payslips throws an uncaught Forbidden rather than rendering an empty state.
    assert.equal(await canAccess(seat, "leave", "create"), true, "she must be able to request her own vacation");
    assert.equal(await canAccess(seat, "payslips", "read"), true, "she must be able to open her own payslip");
    assert.equal(await canAccess(seat, "attendance", "read"), true);
    assert.equal(await canAccess(seat, "employees", "read"), true);
    assert.equal(await canAccess(seat, "support_requests", "read"), true);
    assert.equal(await canAccess(seat, "support_requests", "update"), true);
    assert.equal(await canAccess(seat, "support_requests", "export"), true);
  }

  // ── What SEPARATES them ─────────────────────────────────────────────────────────────────────
  // The retired seat held every one of these at once. If a future change collapses the two
  // bundles back into one HR role, this block is what fails — which is the entire reason the
  // owner asked for a function catalogue rather than a second monolithic role name.
  // Recruiting was HR Advisory's function until "move recruiting off the HR Business Partner" (owner, 2026-10-08); it is the
  // Talent Acquisition seat's now, and neither of these two holds it.
  const hrResourcing = createAccessContext({ hrId: "A-18", role: "HR Resourcing" });
  assert.equal(await canAccess(hrResourcing, "recruitment", "create"), true, "recruiting is the Talent Acquisition seat's function");
  assert.equal(await canAccess(hrAdvisory, "recruitment", "create"), false, "…not HR Advisory's since 2026-10-08");
  assert.equal(await canAccess(hrOperations, "recruitment", "create"), false, "…nor HR Operations'");
  assert.equal(await canAccess(hrResourcing, "candidates", "read"), true);
  assert.equal(await canAccess(hrAdvisory, "candidates", "read"), false, "HR Advisory holds no candidate PII since recruiting moved");
  assert.equal(await canAccess(hrOperations, "candidates", "read"), false, "HR Operations holds no candidate PII");
  // The owner retired the HR Business Partner seat on 2026-10-08: the dormant key holds nothing, so
  // every grant it had reads false below; its hiring paperwork is the Super Admin's now.
  assert.equal(await canAccess(hrAdvisory, "employee_documents", "update"), false, "the retired key fills no HR Forms");
  assert.equal(await canAccess(hrOperations, "leave", "update"), true, "approving leave is HR Operations' function");
  assert.equal(await canAccess(hrAdvisory, "leave", "update"), false, "…and only hers");
  assert.equal(await canAccess(hrOperations, "contracts", "update"), true, "the records half");
  assert.equal(await canAccess(hrAdvisory, "contracts", "update"), false);
  // Owner-requested 2026-07-25 on the retired seat: the read-only Planning Calendar, no submission.
  // It follows workforce_insight, which HR Advisory held until the seat was retired on 2026-10-08;
  // the function is unassigned now (the Super Admin's), so the retired key reads nothing.
  assert.equal(await canAccess(hrAdvisory, "weekly_plans", "read"), false);
  assert.equal(await canAccess(hrAdvisory, "weekly_plans", "create"), false, "reading where the field force will be is not submitting a plan");
  // CHANGED 2026-09-01 (owner). This line asserted `false` for HR Operations until that day, and the
  // note above read "HR Operations never had a reason for it". He named /admin/weekly-plans/calendar
  // as a page he wants in her sidebar, and was told before agreeing that it shows her where every
  // medical rep plans to be. The grant is attached to time_attendance, so it traces to her own JD
  // line ("Attendance, Leave & Working-Time Administration") instead of borrowing Advisory's
  // function — see src/lib/auth/hr-functions.ts.
  //
  // The separation this block exists to protect is INTACT, and is now pinned more tightly than
  // before: READ is shared, every WRITE is still refused. Do not "restore" the false — assert the
  // two write lines instead if you are checking the boundary still holds.
  assert.equal(await canAccess(hrOperations, "weekly_plans", "read"), true, "owner 2026-09-01 — the Planning Calendar is a row in her sidebar");
  assert.equal(await canAccess(hrOperations, "weekly_plans", "create"), false, "reading the plan calendar is not submitting a plan");
  assert.equal(await canAccess(hrOperations, "weekly_plans", "update"), false, "approving or editing a plan belongs to the sales ladder, never to HR");

  // ── Salary redaction — HR ADVISORY ONLY since 2026-09-06 ────────────────────────────────────
  // Owner-requested 2026-07-25 on the retired seat: even with full employee-directory read
  // access, an HR seat must not see real salary figures for a named set of senior employees (her
  // own manager chain plus a handful of other seniors). The list is
  // HR_ADVISORY_SALARY_REDACTED_HR_IDS in permissions.ts.
  //
  // HR OPERATIONS CAME OFF IT ON 2026-09-06, on the owner's instruction — "yasmeen is the one
  // responsible for completing and adding all employees records" — after he was asked directly
  // whether that includes his own pay and the CEO's, and said it does.
  //
  // DO NOT "restore" the true on the line below to make the pair symmetrical again. The two seats
  // are deliberately different now, and the asymmetry is the point: HR Advisory advises on the
  // workforce, HR Operations maintains its records. Re-adding HR Operations does not merely hide
  // figures from her — filterEmployeeDirectoryForAccess also runs over the employee master EXPORT,
  // so her downloaded sheet comes back with these seven salary cells EMPTY, the importer reads a
  // blank cell as "leave it alone", and her upload silently stops updating them while reporting
  // success. That is the live incident this change fixed, on 2026-09-06.
  assert.equal(isSalaryRedactedForViewer(hrOperations, "B-10"), false, "owner 2026-09-06 — HR Operations owns the employee master, salary columns included");
  assert.equal(isSalaryRedactedForViewer(hrOperations, "AA"), false, "…the CEO's row included, asked and answered");
  assert.equal(isSalaryRedactedForViewer(hrAdvisory, "B-10"), true, "her direct manager (HR Manager) is redacted");
  assert.equal(isSalaryRedactedForViewer(hrAdvisory, "AA"), true, "the CEO is redacted");
  assert.equal(isSalaryRedactedForViewer(hrAdvisory, "A-12"), true, "a named NSM is redacted");
  assert.equal(isSalaryRedactedForViewer(hrAdvisory, "A-16"), false, "her own record is not redacted");
  assert.equal(isSalaryRedactedForViewer(superAdmin, "B-10"), false, "the redaction is HR-seat-specific, not global");

  function salaryRow(hrId: string): EmployeeDirectoryRow {
    return {
      hrId,
      baseSalary: 10000,
      basicSalary: 7000,
      extraCostOfLiving: 100,
      fuelAllowance: 200,
      grossSalary: 10300,
      medicalInsurance: 50,
      netSalary: 9500,
      salaryDetails: [{ category: "earning", id: "x", label: "X", notes: null, value: "1", valueType: "amount" }],
      socialInsurance: 300,
      socialInsuranceWage: 8000,
      taxes: 400,
    } as EmployeeDirectoryRow;
  }
  const directory = {
    employees: [salaryRow("B-10"), salaryRow("A-16")],
    lookups: { managers: [] },
    summary: {},
  } as unknown as EmployeeDirectoryData;
  // Since the owner retired the HR Business Partner seat (2026-10-08) the key holds no employees
  // grant, so the directory filter withholds B-10's row from it altogether — stronger than the
  // blanked salary cells it used to return. The redaction list itself is kept (asserted above), so
  // the key can never be handed back the directory with those salaries visible.
  const filteredForTalentAcquisition = filterEmployeeDirectoryForAccess(directory, hrAdvisory);
  assert.equal(
    filteredForTalentAcquisition.employees.find((row) => row.hrId === "B-10"),
    undefined,
    "the retired HR Business Partner key must not read B-10's row at all",
  );
  const filteredForSuperAdmin = filterEmployeeDirectoryForAccess(directory, superAdmin);
  assert.equal(
    filteredForSuperAdmin.employees.find((row) => row.hrId === "B-10")!.baseSalary,
    10000,
    "Super Admin still sees B-10's real salary — redaction does not mutate the underlying data",
  );

  // HR Operations reads the same rows unredacted (owner 2026-09-06). Asserted through the FILTER
  // rather than through isSalaryRedactedForViewer alone, because this is the function
  // app/api/employees/template/route.ts runs over the employee master EXPORT: if a null ever comes
  // back here, her downloaded sheet loses these cells, and an upload of that sheet quietly stops
  // updating the seven seniors' pay while still reporting success.
  const filteredForHrOperations = filterEmployeeDirectoryForAccess(directory, hrOperations);
  const hrOpsManagerRow = filteredForHrOperations.employees.find((row) => row.hrId === "B-10")!;
  assert.equal(hrOpsManagerRow.baseSalary, 10000, "HR Operations sees B-10's real base salary — she maintains it");
  assert.equal(hrOpsManagerRow.grossSalary, 10300, "…and the gross, so the export she edits carries it");
  assert.equal(hrOpsManagerRow.socialInsuranceWage, 8000, "…and the insurance wage, which alone drives the statutory filing");
  assert.notEqual(hrOpsManagerRow.salaryDetails, null, "…and the flexible salary details");

  // Read-side redaction alone is dangerous: HR Advisory's edit form for a
  // redacted employee necessarily carries blanked salary values, so saving ANY
  // unrelated field change would upsert nulls over the real figures unless the
  // write path re-splices the current DB values in first. Regression-guard that
  // the API route still does this — see app/api/employees/route.ts.
  const employeesRouteSource = readFileSync("app/api/employees/route.ts", "utf8");
  assert.match(
    employeesRouteSource,
    /isSalaryRedactedForViewer\(access, payload\.employee\.hrId\)/,
    "employees API POST must re-check isSalaryRedactedForViewer before upsertEmployee, or a blanked read becomes a destructive write",
  );
  assert.equal(await canAccess(hrAdvisory, "admin", "read"), false);
  assert.equal(await canAccess(hrAdvisory, "admin_access", "read"), false);
  assert.equal(await canAccess(hrAdvisory, "permission_admin", "read"), false);
  assert.equal(await canAccess(hrAdvisory, "user_admin", "read"), false);

  assert.equal(await canAccess(superAdmin, "employees", "read"), true);
  assert.equal(await canAccess(superAdmin, "employees", "update"), true);
  assert.equal(await canAccess(superAdmin, "support_requests", "read"), true);
  assert.equal(await canAccess(superAdmin, "support_requests", "update"), true);
  assert.equal(await canAccess(superAdmin, "recruitment", "approve"), true);
  assert.equal(await canAccess(superAdmin, "offers", "update"), true);

  assert.equal(await canAccess(financeManager, "payroll", "read"), true);
  assert.equal(await canAccess(financeManager, "support_requests", "create"), true);
  assert.equal(await canAccess(financeManager, "support_requests", "read"), false);
  assert.equal(await canAccess(financeManager, "recruitment", "read"), false);

  assert.equal(await canAccess(marketingManager, "weekly_plans", "approve"), false);
  // GPM-style commercial oversight: monthly + weekly sales are granted with line scope.
  assert.equal(await canAccess(marketingManager, "sales", "read"), true);
  assert.equal(await canAccess(marketingManager, "sales", "export"), true);
  assert.equal(await canAccess(marketingManager, "weekly_sales", "read"), true);
  assert.equal(getSalesScope(marketingManager), "LINE");
  assert.equal(await canAccess(marketingManager, "support_requests", "create"), true);
  assert.equal(await canAccess(marketingManager, "support_requests", "read"), false);
  assert.equal(await canAccess(marketingManager, "employees", "read"), false);
  assert.equal(await canAccess(marketingManager, "recruitment", "update"), false);
  assert.equal(await canAccess(marketingManager, "candidates", "read"), false);
  assert.equal(await canAccess(marketingManager, "offers", "read"), false);

  // EVERY role must be able to manage its OWN notification/Telegram settings. Both
  // profile pages (admin shell and employee portal) render the notification panel for
  // any signed-in user, and the self-service endpoints (PATCH /api/notifications/settings,
  // /api/integrations/telegram/*) gate on employee_profile:update. CEO was missing it,
  // so "Connect Telegram" returned 403 surfaced as the misleading "Unable to create
  // Telegram link." This is self-scoped only — employee_profile:update never edits OTHER
  // employees (that is the `employees` resource) — so granting it must not widen
  // cross-employee access.
  // Every role a person can hold. The retired HR Business Partner key (2026-10-08) holds nothing and
  // reaches nobody, so it has no profile to manage.
  for (const role of assignablePhoenixRoles) {
    const context = createAccessContext({ hrId: `SELF-${role}`, role });
    assert.equal(
      await canAccess(context, "employee_profile", "update"),
      true,
      `${role} must be able to manage own profile/notification settings (employee_profile:update)`,
    );
  }
  const ceo = createAccessContext({ hrId: "CEO-1", role: "CEO" });
  assert.equal(await canAccess(ceo, "employees", "read"), false, "CEO must not see the employee master");
  assert.equal(await canAccess(ceo, "employees", "update"), false, "CEO still cannot edit other employees");
  assert.equal(await canAccess(ceo, "admin", "read"), false, "CEO must not see generic admin tools");
  assert.equal(await canAccess(ceo, "support_requests", "create"), true, "CEO can submit HR support requests");
  assert.equal(await canAccess(ceo, "support_requests", "read"), false, "CEO must not read the HR support inbox");
  assert.equal(await canAccess(ceo, "recruitment", "read"), false, "CEO must not see HR recruitment");
  assert.equal(await canAccess(ceo, "candidates", "read"), false, "CEO must not see candidate PII");
  assert.equal(await canAccess(ceo, "offers", "read"), false, "CEO must not see HR offer lifecycle");
  assert.equal(await canAccess(ceo, "admin_access", "read"), false, "CEO must not see Users & Access");
  assert.equal(await canAccess(ceo, "permission_admin", "read"), false, "CEO must not see permission administration");
  assert.equal(await canAccess(ceo, "user_admin", "read"), false, "CEO must not see user administration");
  assert.equal(await canAccess(ceo, "probation", "read"), true, "CEO can read probation risk aggregates and read-only page");
  assert.equal(await canAccess(ceo, "probation", "create"), false, "CEO must not create probation reviews");
  assert.equal(await canAccess(ceo, "probation", "update"), false, "CEO must not update probation workflow");
  assert.equal(await canAccess(ceo, "probation", "approve"), false, "CEO must not approve probation decisions");

  // HR Resourcing — the Talent Acquisition seat — reads the inbox since 2026-10-08: the owner ticked
  // HR Support Requests for her on the access blueprint.
  // HR Advisory left this set when the owner retired the HR Business Partner seat on 2026-10-08.
  const hrAuthorityRoles = new Set<PhoenixRole>(["Super Admin", "HR Operations", "HR Resourcing"]);
  for (const role of phoenixRoles) {
    const context = createAccessContext({ hrId: `ROLE-${role}`, role });
    assert.equal(await canAccess(context, "support_requests", "create"), true, `${role} can submit HR support requests`);
    assert.equal(
      await canAccess(context, "support_requests", "read"),
      hrAuthorityRoles.has(role),
      `${role} HR support inbox read scope`,
    );
    assert.equal(
      await canAccess(context, "support_requests", "update"),
      hrAuthorityRoles.has(role),
      `${role} HR support inbox update scope`,
    );
    assert.equal(
      await canAccess(context, "support_requests", "export"),
      hrAuthorityRoles.has(role),
      `${role} HR support inbox export scope`,
    );
  }

  const blockedResources: PermissionResource[] = [
    "employee_documents",
    "recruitment",
    "candidates",
    "offers",
    "admin_access",
    "permission_admin",
    "user_admin",
  ];
  const blockedActions: PermissionAction[] = ["read", "create", "update", "delete", "approve", "export", "import"];
  // The HR Operations Specialist alone holds employee_documents outside the authority set (owner,
  // 2026-11-02, "Receive the hiring papers / OPEN HR FORMS FULL MODULE"), pinned to exactly these four.
  const specialistDocumentActions: PermissionAction[] = ["create", "export", "read", "update"];
  assert.deepEqual(
    [...(permissionMatrix["HR Administration"].employee_documents ?? [])].sort(),
    specialistDocumentActions,
    "the HR Operations Specialist holds employee_documents without delete, approve or import",
  );
  for (const role of phoenixRoles.filter((candidate) => !hrAuthorityRoles.has(candidate))) {
    for (const resource of blockedResources) {
      for (const action of blockedActions) {
        if (role === "HR Administration" && resource === "employee_documents" && specialistDocumentActions.includes(action)) {
          assert.equal(isRolePermissionWithinHardBoundary(role, resource, action), true, `${role} holds ${action} ${resource}`);
          continue;
        }
        assert.equal(
          isRolePermissionWithinHardBoundary(role, resource, action),
          false,
          `${role} cannot be hard-granted ${action} ${resource}`,
        );
      }
    }
    // The one non-authority seat that keeps the Employee Master: the HR Operations Specialist
    // (HR Administration, owner 2026-10-20 — "Employee Master import and export, all with no
    // salary"). Pinned EXACTLY: no `create` (adding a person stays with the HR Generalist and the
    // Super Admin) and no `delete`. The salary is withheld server-side for her (isSalaryBlindRole).
    if (role === "HR Administration") {
      assert.deepEqual(
        [...(permissionMatrix[role].employees ?? [])].sort(),
        ["export", "import", "read", "update"],
        `${role} keeps the Employee Master without create or delete`,
      );
      continue;
    }
    assert.equal(permissionMatrix[role].employees, undefined, `${role} has no employee master permissions`);
  }

  const accessAdminResources: PermissionResource[] = ["admin", "admin_access", "permission_admin", "user_admin"];
  for (const role of phoenixRoles.filter((candidate) => candidate !== "Super Admin")) {
    for (const resource of accessAdminResources) {
      assert.equal(permissionMatrix[role][resource], undefined, `${role} has no ${resource} permissions`);
      for (const action of blockedActions) {
        assert.equal(
          isRolePermissionWithinHardBoundary(role, resource, action),
          false,
          `${role} cannot be hard-granted ${action} ${resource}`,
        );
      }
    }
  }

  // Segregation of duties: the CEO account is observational on irreversible HR/finance
  // workflows. It must NOT approve contracts/resignations/expenses/outstation/deductions or
  // mutate attendance, but RETAINS leave + weekly-plan approval (owner decision) and read/export.
  for (const resource of ["contracts", "resignations", "expenses", "outstation", "deductions"] as const) {
    assert.equal(await canAccess(ceo, resource, "approve"), false, `CEO must not approve ${resource}`);
    assert.equal(await canAccess(ceo, resource, "read"), true, `CEO can still read ${resource}`);
  }
  for (const action of ["create", "update", "delete"] as const) {
    assert.equal(await canAccess(ceo, "attendance", action), false, `CEO must not ${action} attendance`);
  }
  assert.equal(await canAccess(ceo, "attendance", "read"), true, "CEO can still read attendance");
  assert.equal(await canAccess(ceo, "leave", "approve"), true, "CEO retains leave approval for direct reports");
  assert.equal(await canAccess(ceo, "weekly_plans", "approve"), true, "CEO retains weekly-plan approval");

  assert.equal(getPayrollScope(employee), "SELF");
  assert.equal(getPayrollScope(districtManager), "SELF");
  assert.equal(getPayrollScope(createAccessContext({ role: "Finance Manager" })), "COMPANY");
  assert.equal(getSalesScope(employee), "SELF");
  assert.equal(getSalesScope(districtManager), "TEAM");
  assert.equal(getExpensesScope(employee), "SELF");
  assert.equal(getExpensesScope(districtManager), "TEAM");

  // ── Finance Manager is excluded from Outstation and Expenses (owner, 2026-08-10) ──────────────
  // "NO EXCLUDE HIM 100% FROM OUTSTAION OR EXPENSES". Two things have to hold, and they fail in
  // opposite directions, so both are asserted:
  //
  //  1. NO `outstation` action of any kind. Deleting the key — rather than trimming actions — is
  //     what closes /api/admin/outstation/**, the Expense Command Center, the approval queue,
  //     manual entry, the historical upload and /workspace/submit-expense in one move.
  //  2. `expenses` is read ONLY, and its scope is SELF. The key survives at all for exactly one
  //     reason: `expenses:read` is what the whole /api/marketing-requests/** namespace is gated on
  //     (access-registry.ts), including /:id/decision and /finance-evidence — the two routes he
  //     executes the terminal `finance_execution` rung from. Delete it and the rung the owner
  //     activated the same morning becomes a dead end nobody can clear. SELF scope is what stops
  //     that residual grant handing back the company-wide expense read the removal closed.
  //
  // If the marketing routes ever move onto a marketing-specific resource, `expenses` should leave
  // his matrix outright and the first loop below should cover both resources.
  // (`financeManager` is already declared at the top of this function alongside the other role
  // fixtures — reused rather than shadowed.)
  for (const action of ["read", "create", "update", "delete", "approve", "export", "import"] as const) {
    assert.equal(
      await canAccess(financeManager, "outstation", action),
      false,
      `Finance Manager must hold NO outstation grant — found ${action}`,
    );
  }
  assert.equal(
    await canAccess(financeManager, "expenses", "read"),
    true,
    "expenses:read must survive — it is the gate on every /api/marketing-requests/** route, including the finance_execution decision",
  );
  for (const action of ["create", "update", "delete", "approve", "export", "import"] as const) {
    assert.equal(
      await canAccess(financeManager, "expenses", action),
      false,
      `expenses is read-only for the Finance Manager — found ${action}`,
    );
  }
  assert.equal(
    getExpensesScope(financeManager),
    "SELF",
    "Finance Manager expense scope must be SELF, or the residual expenses:read restores the company-wide expense read",
  );
}
