import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  createAccessContext,
  getPayrollScope,
  normalizeRole,
  permissionMatrix,
  phoenixCompanyJobTitles,
  scopeForRole,
} from "../src/lib/auth/permissions.ts";
import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";

/**
 * Governance: a job title is descriptive only. Access and notification routing
 * are driven by the explicit app role, the permission matrix, and org structure
 * (manager_hr_id / department / line / area / team / configured approver) — never
 * by the words in a job title. These tests lock that separation in place.
 */
export function runTitlePermissionGovernanceTests() {
  // --- Rule 1: no company job title is ever a permission source. -------------
  for (const title of phoenixCompanyJobTitles) {
    assert.equal(
      resolveEmployeeAccessRole({ jobTitle: title }),
      "Employee",
      `Job title "${title}" must not grant a role; roles are assigned explicitly.`,
    );
    assert.equal(
      resolveEmployeeAccessRole({ positionTitle: title }),
      "Employee",
      `Position title "${title}" must not grant a role; roles are assigned explicitly.`,
    );
  }

  // --- Rule 2: senior-sounding title text must not normalize to a privileged
  // role. "HR Manager" and "R&D Manager" are labels. -------------------------
  for (const title of [
    "HR Manager",
    "R&D Manager",
    "R and D Manager",
    "Research and Development Manager",
    "District Sales Manager",
    "Medical Representative",
    "Regional Sales Manager",
  ]) {
    assert.equal(
      normalizeRole(title),
      "Employee",
      `"${title}" is a job-title label, not a permission role.`,
    );
  }
  // R&D Manager is the Research and Development Manager label only — not admin.
  assert.notEqual(normalizeRole("R&D Manager"), "Super Admin");
  assert.notEqual(normalizeRole("R&D Manager"), "Manager");
  assert.ok((phoenixCompanyJobTitles as readonly string[]).includes("Research and Development Manager"));
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "Talent Acquisition" }), "Employee");
  assert.equal(normalizeRole("Talent Acquisition"), "Talent Acquisition");

  // --- Rule 7 (titles list): low-privilege titles never gain elevated access. -
  for (const title of [
    "Admin Assist",
    "QPPV",
    "Buffet",
    "Office Co-ordinator",
    "Regulatory Affairs",
  ]) {
    assert.equal(resolveEmployeeAccessRole({ jobTitle: title }), "Employee");
    assert.equal(
      normalizeRole(title),
      "Employee",
      `"${title}" must not normalize to an elevated role.`,
    );
  }

  // --- Financial Advisor is BOTH a job title and an explicit app role (marketing finance
  // executor). Like "Talent Acquisition", the TITLE still provisions as Employee — only an
  // explicitly-assigned role string carries the role; a title can never confer it. -----------
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "Financial Advisor" }), "Employee");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: "Financial Advisor" }), "Employee");
  assert.equal(normalizeRole("Financial Advisor"), "Financial Advisor");

  // --- HR Specialist is NOT a manager. ---------------------------------------
  assert.equal(scopeForRole("Manager"), "team");
  assert.equal(normalizeRole("HR Specialist"), "Employee");
  // A generic HR Specialist (not on the designated allowlist) is scoped to self,
  // not company-wide — being "HR" does not confer manager/company reach.
  assert.equal(
    createAccessContext({ role: "HR Specialist", hrId: "Z-9999" }).scope,
    "self",
  );
  // The "HR Manager" title yields neither Manager nor HR Specialist automatically.
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "HR Manager" }), "Employee");
  assert.notEqual(normalizeRole("HR Manager"), "Talent Acquisition");
  assert.notEqual(normalizeRole("HR Manager"), "Manager");

  // --- Finance Manager: payroll/employee access comes from role+matrix, not the
  // title. The title provisions as Employee; the Employee role cannot read the
  // employee directory and only sees its own payroll. ------------------------
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "Finance Manager" }), "Employee");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: "Finance Manager" }), "Employee");
  assert.equal(permissionMatrix.Employee.employees, undefined);
  assert.equal(getPayrollScope({ role: "Employee" }), "SELF");
  // The explicitly-assigned Finance Manager role is what carries payroll reach.
  assert.ok((permissionMatrix["Finance Manager"].payroll ?? []).length > 0);
  assert.equal(getPayrollScope({ role: "Finance Manager" }), "COMPANY");

  // --- Product / Group Product Manager are product/line roles, not people
  // managers. They do not gain a team/manager scope from their title. ---------
  assert.equal(scopeForRole("Product Manager"), "line");
  assert.equal(scopeForRole("Group Product Manager"), "line");
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "Product Manager" }), "Employee");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: "Group Product Manager" }), "Employee");

  // --- District Sales Manager title does not grant District Manager access. --
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "District Sales Manager" }), "Employee");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: "District Sales Manager" }), "Employee");
  assert.equal(normalizeRole("District Sales Manager"), "Employee");
  assert.equal(normalizeRole("DSM"), "Employee");
  assert.equal(normalizeRole("Medical Representative"), "Employee");

  // --- Notification recipient resolution is identity/scope based, never
  // title-text based. These structural guarantees prove that:
  //   * a direct manager / manager chain is resolved via manager_hr_id;
  //   * permission recipients require a real permission AND an org-scope match;
  //   * no recipient is ever selected because their job title contains "Manager".
  // (So HR Manager only receives manager notifications when manager_hr_id points
  //  to them; Product Manager / District Sales Manager only within their own
  //  chain/team/scope or when explicitly assigned.) --------------------------
  const policySource = readFileSync("src/lib/notifications/policy.ts", "utf8");
  assert.match(policySource, /manager_hr_id/, "manager resolution must key off manager_hr_id");
  assert.match(policySource, /reportsTo\(/, "direct-report check must be identity based");
  assert.match(policySource, /inManagerChain\(/, "manager-chain check must walk manager_hr_id");
  assert.match(
    policySource,
    /hasOrgScope\(candidate, subject, "team"\)/,
    "permission recipients must be limited by team scope",
  );
  assert.match(
    policySource,
    /canAccess\(context, policy\.permissionResource/,
    "permission recipients must pass an explicit Phoenix permission check",
  );
  assert.doesNotMatch(
    policySource,
    /jobTitle|job_title|positionTitle|position_title/,
    "recipient resolution must not read job-title fields",
  );
}
