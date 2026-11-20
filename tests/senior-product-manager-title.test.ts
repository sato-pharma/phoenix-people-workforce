import assert from "node:assert/strict";

import { normalizeRole, phoenixCompanyJobTitles } from "../src/lib/auth/permissions.ts";
import { resolveEmployeeAccessRole } from "../src/lib/employees/access-role.ts";
import {
  isExpenseAnalysisRole,
  isProductManagerTitle,
  resolveJobFunctionRole,
} from "../src/lib/employees/job-function.ts";
import { COMPANY_ROLE_WORKBOOKS } from "../src/lib/hr/job-workbook.ts";
import { positionRules } from "../src/lib/imports/org-rules.ts";

/**
 * "Senior Product Manager" — the grade the owner gave Nourhan Abdelmoniem (AI-0037) on 2026-11-20.
 * It is a seniority label on the same job: same line, same seat, same app role. The title is read by
 * exact-key maps and exact-equality checks that answer a DEFAULT, not an error, when they miss, so
 * this pins that the grade lands wherever "Product Manager" lands. It is the product-manager twin of
 * runSeniorMedicalRepresentativeTitleTests and runSeniorDistrictManagerTitleTests.
 */
export function runSeniorProductManagerTitleTests() {
  const SENIOR = "Senior Product Manager";
  const PM = "Product Manager";

  // --- 1. The job FUNCTION is identical (portal routing, coaching mode, Employee 360, expenses).
  assert.equal(resolveJobFunctionRole(SENIOR), resolveJobFunctionRole(PM), "a seniority grade is the same job function");
  assert.equal(resolveJobFunctionRole(SENIOR), "Product Manager");
  assert.equal(resolveJobFunctionRole("SENIOR PRODUCT MANAGER"), "Product Manager", "matched case-insensitively");
  assert.equal(isExpenseAnalysisRole(SENIOR), isExpenseAnalysisRole(PM));
  assert.equal(isExpenseAnalysisRole(SENIOR), true, "a Product Manager's travel is analysed, senior grade or not");

  // --- 2. The exact-title test the calendar, the SFE coverage tally and the marketing sheet share.
  assert.equal(isProductManagerTitle(PM), true);
  assert.equal(isProductManagerTitle(SENIOR), true);
  assert.equal(isProductManagerTitle("  senior product manager "), true, "spacing and case never drop her");
  assert.equal(isProductManagerTitle("Group Product Manager"), false, "a Group Product Manager is a different, more senior title");
  assert.equal(isProductManagerTitle("Senior Group Product Manager"), false);
  assert.equal(isProductManagerTitle("Product Manager Assistant"), false, "an equality test, never a substring");
  assert.equal(isProductManagerTitle(null), false);
  assert.equal(isProductManagerTitle(undefined), false);
  assert.equal(isProductManagerTitle(""), false);

  // --- 3. It is a listed company job title, carries no access of its own, and the import keeps it.
  assert.ok((phoenixCompanyJobTitles as readonly string[]).includes(SENIOR), "listed as a company job title");
  assert.equal(resolveEmployeeAccessRole({ jobTitle: SENIOR }), "Employee", "a title never grants an app role");
  assert.equal(normalizeRole(SENIOR), "Employee", "a job-title label is not a permission role");
  assert.equal(positionRules["senior_product_manager"], SENIOR, "an import keeps the grade, never demotes it");
  assert.ok(
    COMPANY_ROLE_WORKBOOKS.some((entry) => entry.jobTitle === SENIOR && entry.role === "Product Manager"),
    "the HR job workbook carries a line for it",
  );
}
