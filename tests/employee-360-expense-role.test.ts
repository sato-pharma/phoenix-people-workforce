import assert from "node:assert/strict";

import { isExpenseAnalysisRole } from "../src/lib/employees/job-function.ts";

// Regression guard for the fix in PR #1061: the Expenses & Outstation section of
// Employee 360 was gated as "not Medical Rep" instead of "is a traveling manager",
// so HR, Finance, CEO, and other admin-function titles all saw (and fetched) it.
// isExpenseAnalysisRole must be an explicit allowlist (DM/RM/NSM/TM/PM/GPM), never
// a Medical-Rep-exclusion check.

export async function runEmployee360ExpenseRoleTests() {
  // ── Allowed: the traveling-manager roles the code comment documents ──
  const allowedTitles = [
    "District Sales Manager",
    "District Manager",
    "Regional Sales Manager",
    "Regional Manager",
    "National Sales Manager",
    "Training Manager",
    "Product Manager",
    "Group Product Manager",
  ];
  for (const title of allowedTitles) {
    assert.equal(isExpenseAnalysisRole(title), true, `${title} should see expense analysis`);
  }

  // ── Denied: Medical Rep (the section's original, correct exclusion) ──
  assert.equal(isExpenseAnalysisRole("Medical Representative"), false, "Medical Rep is denied");
  assert.equal(isExpenseAnalysisRole("Medical Rep"), false, "Medical Rep (canonical) is denied");

  // ── Denied: admin-function titles that previously slipped through because they
  //    aren't "Medical Rep" either. This is the actual regression this test locks. ──
  const deniedAdminTitles = [
    "Admin Manager",
    "Admin Assistant",
    "Financial Advisor",
    "Hr Manager",
    "Finance Manager",
    "Ceo",
    "Office Coordinator",
    "Talent Acquisition",
    "R And D Manager",
    "Buffet",
    "Qppv",
    "Marketing Manager",
    "Sfe Manager",
  ];
  for (const title of deniedAdminTitles) {
    assert.equal(isExpenseAnalysisRole(title), false, `${title} should NOT see expense analysis`);
  }

  // ── Edge cases ──
  assert.equal(isExpenseAnalysisRole(null), false, "null title is denied");
  assert.equal(isExpenseAnalysisRole(undefined), false, "undefined title is denied");
  assert.equal(isExpenseAnalysisRole(""), false, "empty title is denied");
  assert.equal(isExpenseAnalysisRole("  National Sales Manager  "), true, "whitespace is trimmed");
  assert.equal(isExpenseAnalysisRole("national sales manager"), true, "case-insensitive");
}
