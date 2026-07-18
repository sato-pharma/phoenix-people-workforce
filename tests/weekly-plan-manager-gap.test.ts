import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Detection coverage for the "stuck weekly/monthly plan approver" gap listing (Part B).
 *
 * listWeeklyPlanManagerGapRecords() is the JS-client twin of the D4 drift detector — it hits the
 * DB, so these are source-text invariants (same style as weekly-plans-drift-check.test.ts).
 */
export function runWeeklyPlanManagerGapTests() {
  const driftSrc = readFileSync("src/lib/weekly-planning/drift-check.ts", "utf8");

  assert.match(
    driftSrc,
    /export async function listWeeklyPlanManagerGapRecords/,
    "drift-check must export listWeeklyPlanManagerGapRecords",
  );
  // Same status set as the D4 detector: submitted / manager_returned / ceo_returned.
  assert.match(
    driftSrc,
    /MANAGER_GAP_PLAN_STATUSES[\s\S]{0,120}"submitted"[\s\S]{0,60}"manager_returned"[\s\S]{0,60}"ceo_returned"/,
    "gap status set must mirror the D4 detector",
  );
  assert.match(
    driftSrc,
    /\.from\("employee_plan_headers"\)[\s\S]{0,220}\.in\("status", MANAGER_GAP_PLAN_STATUSES/,
    "must read employee_plan_headers filtered to the manager-gap statuses",
  );
  // Cross-references the directory INCLUDING inactive so resigned/missing managers are detected.
  assert.match(
    driftSrc,
    /getEmployeeDirectoryRows\(\{ includeInactive: true \}\)/,
    "must load the directory including inactive to detect resigned managers",
  );
  assert.match(
    driftSrc,
    /isActiveEmploymentStatus/,
    "must classify the manager's employment status (active/on_leave)",
  );
  // The D4 alert must be enriched with the real plan list, not just a count.
  assert.match(
    driftSrc,
    /driftCodes\.includes\("D4"\)[\s\S]{0,400}listWeeklyPlanManagerGapRecords\(\)/,
    "runWeeklyPlansDriftCheck must enrich the D4 alert with the real stuck-plan list",
  );
  assert.match(
    driftSrc,
    /needs reassignment/i,
    "the D4 enrichment must flag the plans as needing reassignment",
  );
  // Read-only: it lists plans, it never mutates the headers.
  assert.doesNotMatch(
    driftSrc,
    /\.from\("employee_plan_headers"\)[\s\S]{0,140}\.update\(/,
    "the gap listing must be read-only (no header mutation)",
  );
}
