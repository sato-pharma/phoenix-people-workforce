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
  // --- Rule 1: a company job title is not a GENERAL permission source. -------
  // Owner-approved exception (2026-08-14): the field force auto-provisions its
  // starting role from a closed two-title allowlist, so a new District Manager or
  // Medical Rep is not stranded on the Employee role for months waiting on a
  // manual elevation step. Every OTHER company title still provisions as Employee,
  // and the general role parser (normalizeRole — Rule 2 below) still maps NONE of
  // these titles; only the explicit provisioning allowlist in access-role.ts does.
  const APPROVED_FIELD_FORCE_PROVISIONING: Record<string, string> = {
    "District Sales Manager": "District Manager",
    "Medical Representative": "Medical Rep",
  };
  for (const title of phoenixCompanyJobTitles) {
    const expected = APPROVED_FIELD_FORCE_PROVISIONING[title] ?? "Employee";
    assert.equal(
      resolveEmployeeAccessRole({ jobTitle: title }),
      expected,
      `Job title "${title}" must provision as "${expected}".`,
    );
    assert.equal(
      resolveEmployeeAccessRole({ positionTitle: title }),
      expected,
      `Position title "${title}" must provision as "${expected}".`,
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
    // The most senior-SOUNDING title the company has, and still only a label: B-94's district
    // access comes from his assigned "District Manager" app role, never from these words. The
    // provisioning allowlist in access-role.ts was DELIBERATELY not widened for it — the owner
    // approved exactly two titles there in 2026-08, and a promotion is not a new hire.
    "Senior District Manager",
    "Medical Representative",
    "Regional Sales Manager",
  ]) {
    assert.equal(
      normalizeRole(title),
      "Employee",
      `"${title}" is a job-title label, not a permission role.`,
    );
  }
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "Senior District Manager" }), "Employee");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: "Senior District Manager" }), "Employee");
  // R&D Manager is the Research and Development Manager label only — not admin.
  assert.notEqual(normalizeRole("R&D Manager"), "Super Admin");
  assert.notEqual(normalizeRole("R&D Manager"), "Manager");
  assert.ok((phoenixCompanyJobTitles as readonly string[]).includes("Research and Development Manager"));
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "Talent Acquisition" }), "Employee");
  // Both retired HR seats resolve DOWN to Employee, never sideways to a successor. Retiring a
  // role removes it from the PhoenixRole union but not from the database: verified in production
  // 2026-08-28, exactly one app_auth_users row and one user_access_profiles row still read
  // "Talent Acquisition", and both belong to A-16 — is_active false, employment_status resigned.
  // An alias pointing that string at HR Advisory reads as continuity and is really a privilege
  // carry-forward, since normalizeRole is what a stale JWT's app_metadata passes through. The
  // 2026-06 retirement of "HR Specialist" already set this precedent and it is followed here.
  // The two new hires never reach this table — their role is written explicitly at provisioning.
  assert.equal(normalizeRole("Talent Acquisition"), "Employee", "a retired seat must not carry its grants forward");
  assert.equal(normalizeRole("talent acquisition"), "Employee", "case-insensitive, as stored values vary");
  assert.equal(normalizeRole("TalentAcquisition"), "Employee", "and punctuation-insensitive, via the second alias table");
  assert.equal(normalizeRole("HR Specialist"), "Employee", "the FIRST retired HR seat, demoted the same way in 2026-06");
  // The successors are real union members, so they resolve to themselves rather than through any
  // alias. If either is ever dropped from the union, this is what catches the silent fallback.
  assert.equal(normalizeRole("HR Advisory"), "HR Advisory");
  assert.equal(normalizeRole("HR Operations"), "HR Operations");
  // The HR Operations Specialist seat (2026-10-20): the KEY is a union member and resolves to itself;
  // its display TITLE, and the old seat's new title, are labels and resolve to nothing.
  assert.equal(normalizeRole("HR Administration"), "HR Administration");
  assert.equal(normalizeRole("HR Operations Specialist"), "Employee", "a seat's title is not its key");
  assert.equal(normalizeRole("HR Generalist"), "Employee", "a seat's title is not its key");

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

  // --- Field-force provisioning exception (owner-approved 2026-08-14). The two
  // allowlisted titles PROVISION to their real starting role, but the general role
  // PARSER (normalizeRole) still maps neither — a title can seed a starting role
  // only through the explicit provisioning allowlist, never through role parsing. -
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "District Sales Manager" }), "District Manager");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: "District Sales Manager" }), "District Manager");
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "DSM" }), "District Manager");
  assert.equal(resolveEmployeeAccessRole({ jobTitle: "Medical Representative" }), "Medical Rep");
  assert.equal(resolveEmployeeAccessRole({ positionTitle: "Medical Representative" }), "Medical Rep");
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
  // Regression guard for the cross-line/cross-department notification leak (probation
  // PR #1199, generalized here): permission recipients must be limited to the subject's
  // own manager chain (or an explicit company/system-scope role), never a same-department/
  // area/team/line coworker. `hasOrgScope` was the broad org-unit matcher that caused the
  // leak — it must not exist in this file anymore.
  assert.doesNotMatch(
    policySource,
    /hasOrgScope/,
    "permission recipients must not fall back to department/area/team/line org-unit matching",
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
