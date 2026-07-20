import { validateSalaryRows, type SalaryValidationIssue } from "@/lib/payroll/salary-import";

import type { AssembledRow } from "./assemble.ts";

/**
 * Pre-flight validation gate (accuracy booster). Reuses the same pure validator
 * the Excel-upload and Copilot paths run before materializing a batch, so an
 * Automated-Payroll sheet must satisfy identical money relationships (gross/net
 * via the locked policy, additions/deductions totals, negative + deductions-
 * exceed-net guards). Sources are intentionally NOT passed: joiner/leaver rows
 * carry a prorated base that legitimately differs from master, and the base/net
 * formulas already reconcile internally.
 */

export type PreflightResult = {
  ok: boolean;
  errorCount: number;
  issues: SalaryValidationIssue[];
};

export function preflightValidate(rows: AssembledRow[]): PreflightResult {
  const issues = validateSalaryRows(rows.map((entry) => entry.row));
  return { ok: issues.length === 0, errorCount: issues.length, issues };
}
