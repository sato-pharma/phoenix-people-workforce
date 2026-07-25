import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACTIVITY_CODE_TO_TYPE,
  ACTIVITY_TYPE_TO_CODE,
  weeklyPlanActivityCodes,
  weeklyPlanActivityTypes,
  weeklyPlanStatuses,
  WEEKLY_PLAN_ELIGIBLE_JOB_TITLES,
} from "../src/lib/weekly-planning/types.ts";
import {
  buildWeekKey,
  ceoApprovalDeadlineForWeek,
  deriveMonthKey,
  getWeekRange,
  isPlanWorkingDay,
  managerApprovalDeadlineForWeek,
  submissionDeadlineForWeek,
  validateWeekKey,
} from "../src/lib/weekly-planning/week.ts";
import * as Wf from "../src/lib/weekly-planning/workflow.ts";
import {
  assertWeeklyPlanTransition,
  getNextStatus,
  isEligibleJobTitle,
  isTerminalStatus,
  WeeklyPlanWorkflowError,
} from "../src/lib/weekly-planning/workflow.ts";
import { permissionResources } from "../src/lib/auth/permissions.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function runWeeklyPlanningFoundationTests(): Promise<void> {
  // 1. buildWeekKey determinism: same date produces same week key across 10 calls.
  {
    const testDate = "2026-06-07"; // A Sunday
    const keys = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      keys.add(buildWeekKey(testDate));
    }
    assert.equal(keys.size, 1, "buildWeekKey must be deterministic across 10 calls");
  }

  // 2. buildWeekKey sensitivity: different weeks produce different keys.
  {
    const k1 = buildWeekKey("2026-06-07");
    const k2 = buildWeekKey("2026-06-14");
    const k3 = buildWeekKey("2026-05-31");
    assert.notEqual(k1, k2, "different weeks must produce different keys");
    assert.notEqual(k1, k3, "different weeks must produce different keys");
    assert.notEqual(k2, k3, "different weeks must produce different keys");
  }

  // 3. getWeekRange: Sunday start = weekStartDate; Thursday = weekEndDate.
  {
    // 2026-06-01 is a Monday. The preceding Sunday is 2026-05-31.
    const range = getWeekRange("2026-06-01");
    assert.equal(range.weekStartDate, "2026-05-31", "weekStartDate must be Sunday 2026-05-31");
    assert.equal(range.weekEndDate, "2026-06-04", "weekEndDate must be Thursday 2026-06-04");
  }

  // 3b. getWeekRange: providing Sunday directly should return same Sunday.
  {
    const range = getWeekRange("2026-06-07");
    assert.equal(range.weekStartDate, "2026-06-07", "Sunday input must return same Sunday as weekStartDate");
    assert.equal(range.weekEndDate, "2026-06-11", "weekEndDate must be Thursday 2026-06-11");
  }

  // 4. deriveMonthKey: returns YYYY-MM matching the Sunday of the week.
  {
    // 2026-06-01 (Monday) -> Sunday 2026-05-31 -> month key 2026-05
    const mk = deriveMonthKey("2026-06-01");
    assert.equal(mk, "2026-05", "month key must reflect the Sunday's month");

    // 2026-06-07 (Sunday) -> Sunday 2026-06-07 -> month key 2026-06
    const mk2 = deriveMonthKey("2026-06-07");
    assert.equal(mk2, "2026-06", "month key of a Sunday must be its own month");
  }

  // 5. validateWeekKey: valid keys pass; malformed / out-of-range fail.
  {
    const validKeys = ["2026-W01", "2026-W23", "2026-W53", "2000-W09", "2100-W52"];
    for (const k of validKeys) {
      assert.equal(validateWeekKey(k), true, `"${k}" should be valid`);
    }
    const invalidKeys = ["", "2026-W00", "2026-W54", "26-W01", "2026W01", "2026-w23", "2026-W1", "2026-W-1", "abc"];
    for (const k of invalidKeys) {
      assert.equal(validateWeekKey(k), false, `"${k}" should be invalid`);
    }
  }

  // 6. isPlanWorkingDay: Sun, Mon, Tue, Wed, Thu -> true; Fri -> false; Sat -> false.
  {
    // Week of 2026-06-07 (Sun) to 2026-06-13 (Sat)
    assert.equal(isPlanWorkingDay("2026-06-07"), true, "Sunday must be working");
    assert.equal(isPlanWorkingDay("2026-06-08"), true, "Monday must be working");
    assert.equal(isPlanWorkingDay("2026-06-09"), true, "Tuesday must be working");
    assert.equal(isPlanWorkingDay("2026-06-10"), true, "Wednesday must be working");
    assert.equal(isPlanWorkingDay("2026-06-11"), true, "Thursday must be working");
    assert.equal(isPlanWorkingDay("2026-06-12"), false, "Friday must be non-working");
    assert.equal(isPlanWorkingDay("2026-06-13"), false, "Saturday must be non-working by default");
  }

  // 6b. isPlanWorkingDay: Saturday becomes working if policy says so.
  {
    assert.equal(
      isPlanWorkingDay("2026-06-13", { saturdayOff: "working" }),
      true,
      "Saturday must be working when policy is 'working'",
    );
    assert.equal(
      isPlanWorkingDay("2026-06-11", { thursdayOff: "full_day" }),
      false,
      "Thursday must be off when policy is full_day",
    );
  }

  // 7. submissionDeadlineForWeek: Thursday of the prior week at 17:00 Africa/Cairo.
  {
    // 2026-W24: Sunday of W24 = 2026-06-07. Prior Thursday = 2026-06-04 at 17:00 Cairo.
    // June is Cairo EEST (UTC+3), so 17:00 Cairo = 14:00 UTC (DST-safe, not a flat UTC hour).
    const deadline = submissionDeadlineForWeek("2026-W24");
    assert.ok(deadline instanceof Date, "must return a Date");
    assert.equal(deadline.getUTCFullYear(), 2026, "year must be 2026");
    assert.equal(deadline.getUTCMonth(), 5, "month must be June (index 5)");
    assert.equal(deadline.getUTCDate(), 4, "date must be 4 (Thursday before W24 Sunday)");
    assert.equal(deadline.getUTCHours(), 14, "must be 17:00 Cairo (EEST, UTC+3) = 14:00 UTC");
    assert.equal(deadline.getUTCMinutes(), 0, "must be 00 minutes");
  }

  // 8. managerApprovalDeadlineForWeek: Saturday noon of the prior week, Africa/Cairo.
  {
    // 2026-W24: Sunday = 2026-06-07. Saturday before = 2026-06-06 at 12:00 Cairo.
    // June is Cairo EEST (UTC+3), so 12:00 Cairo = 09:00 UTC.
    const deadline = managerApprovalDeadlineForWeek("2026-W24");
    assert.ok(deadline instanceof Date, "must return a Date");
    assert.equal(deadline.getUTCDate(), 6, "date must be 6 (Saturday before W24)");
    assert.equal(deadline.getUTCMonth(), 5, "month must be June");
    assert.equal(deadline.getUTCHours(), 9, "must be 12:00 Cairo (EEST, UTC+3) = 09:00 UTC");
    assert.equal(deadline.getUTCMinutes(), 0, "must be 00 minutes");
  }

  // 9. ceoApprovalDeadlineForWeek: Sunday 10:00 AM of the plan's week, Africa/Cairo.
  {
    // 2026-W24: Sunday = 2026-06-07 at 10:00 Cairo.
    // June is Cairo EEST (UTC+3), so 10:00 Cairo = 07:00 UTC.
    const deadline = ceoApprovalDeadlineForWeek("2026-W24");
    assert.ok(deadline instanceof Date, "must return a Date");
    assert.equal(deadline.getUTCDate(), 7, "date must be 7 (Sunday of W24)");
    assert.equal(deadline.getUTCMonth(), 5, "month must be June");
    assert.equal(deadline.getUTCHours(), 7, "must be 10:00 Cairo (EEST, UTC+3) = 07:00 UTC");
    assert.equal(deadline.getUTCMinutes(), 0, "must be 00 minutes");
  }

  // 10. assertWeeklyPlanTransition: valid, invalid, terminal, reason-required.
  {
    // Valid: draft -> submit
    assert.doesNotThrow(
      () => assertWeeklyPlanTransition("draft", "submit"),
      "draft -> submit must be valid",
    );

    // Valid: submitted -> manager_approve
    assert.doesNotThrow(
      () => assertWeeklyPlanTransition("submitted", "manager_approve"),
      "submitted -> manager_approve must be valid",
    );

    // Invalid: draft -> manager_approve
    assert.throws(
      () => assertWeeklyPlanTransition("draft", "manager_approve"),
      (err: unknown) => err instanceof WeeklyPlanWorkflowError && err.code === "INVALID_TRANSITION",
      "draft -> manager_approve must throw INVALID_TRANSITION",
    );

    // Terminal: final_approved -> anything
    assert.throws(
      () => assertWeeklyPlanTransition("final_approved", "submit"),
      (err: unknown) => err instanceof WeeklyPlanWorkflowError && err.code === "TERMINAL_STATUS",
      "final_approved -> submit must throw TERMINAL_STATUS",
    );

    // Terminal: cancelled -> anything
    assert.throws(
      () => assertWeeklyPlanTransition("cancelled", "cancel"),
      (err: unknown) => err instanceof WeeklyPlanWorkflowError && err.code === "TERMINAL_STATUS",
      "cancelled -> cancel must throw TERMINAL_STATUS",
    );

    // Reason required: manager_return without reason
    assert.throws(
      () => assertWeeklyPlanTransition("submitted", "manager_return"),
      (err: unknown) => err instanceof WeeklyPlanWorkflowError && err.code === "REASON_REQUIRED",
      "manager_return without reason must throw REASON_REQUIRED",
    );

    // Reason provided: manager_return with reason should not throw
    assert.doesNotThrow(
      () => assertWeeklyPlanTransition("submitted", "manager_return", { reason: "Needs revision" }),
      "manager_return with reason must not throw",
    );

    // Reason required: ceo_return without reason
    assert.throws(
      () => assertWeeklyPlanTransition("manager_approved", "ceo_return"),
      (err: unknown) => err instanceof WeeklyPlanWorkflowError && err.code === "REASON_REQUIRED",
      "ceo_return without reason must throw REASON_REQUIRED",
    );

    // Empty string reason counts as missing
    assert.throws(
      () => assertWeeklyPlanTransition("submitted", "manager_return", { reason: "   " }),
      (err: unknown) => err instanceof WeeklyPlanWorkflowError && err.code === "REASON_REQUIRED",
      "whitespace-only reason must throw REASON_REQUIRED",
    );
  }

  // 11. getNextStatus: returns correct next status.
  {
    assert.equal(getNextStatus("draft", "submit"), "submitted");
    assert.equal(getNextStatus("submitted", "manager_approve"), "manager_approved");
    assert.equal(getNextStatus("submitted", "manager_return"), "manager_returned");
    assert.equal(getNextStatus("manager_approved", "ceo_approve"), "ceo_approved");
    assert.equal(getNextStatus("manager_approved", "ceo_return"), "ceo_returned");
    assert.equal(getNextStatus("ceo_approved", "finalize"), "final_approved");
    assert.equal(getNextStatus("draft", "cancel"), "cancelled");
    assert.equal(getNextStatus("manager_returned", "submit"), "submitted");
    assert.equal(getNextStatus("ceo_returned", "submit"), "submitted");
  }

  // 12. ACTIVITY_TYPE_TO_CODE: all 11 activity types have codes.
  {
    assert.equal(ACTIVITY_TYPE_TO_CODE["Office"], "OF", "Office must map to OF");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Field"], "FD", "Field must map to FD");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Vacation"], "AV", "Vacation must map to AV");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Other"], "OT", "Other must map to OT");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Double Visit"], "DV");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Training"], "TR");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Meeting"], "MT");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Event"], "EV");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Travel"], "TV");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Admin"], "AD");
    assert.equal(ACTIVITY_TYPE_TO_CODE["Remote"], "RW");
    assert.equal(Object.keys(ACTIVITY_TYPE_TO_CODE).length, 11, "must have exactly 11 entries");
  }

  // 13. ACTIVITY_CODE_TO_TYPE: inverse mapping is consistent.
  {
    for (const [type, code] of Object.entries(ACTIVITY_TYPE_TO_CODE)) {
      assert.equal(
        ACTIVITY_CODE_TO_TYPE[code as keyof typeof ACTIVITY_CODE_TO_TYPE],
        type,
        `ACTIVITY_CODE_TO_TYPE["${code}"] must equal "${type}"`,
      );
    }
    assert.equal(Object.keys(ACTIVITY_CODE_TO_TYPE).length, 11, "must have exactly 11 entries");
  }

  // 14. isEligibleJobTitle: eligible vs ineligible.
  {
    assert.equal(isEligibleJobTitle("National Sales Manager"), true, "NSM must be eligible");
    assert.equal(isEligibleJobTitle("Product Manager"), true, "Product Manager must be eligible");
    assert.equal(isEligibleJobTitle("Sales Director"), true, "Sales Director must be eligible");
    assert.equal(isEligibleJobTitle("Sales Manager"), true, "Sales Manager must be eligible");
    assert.equal(isEligibleJobTitle("Medical Rep"), false, "Medical Rep must NOT be eligible");
    assert.equal(isEligibleJobTitle("Employee"), false, "Employee must NOT be eligible");
    // Case-insensitive match per implementation (trims and lowercases).
    assert.equal(isEligibleJobTitle("national sales manager"), true, "lowercase match must be eligible");
    assert.equal(isEligibleJobTitle("medical rep"), false, "lowercase Medical Rep must NOT be eligible");
  }

  // 15. isTerminalStatus: terminal and non-terminal statuses.
  {
    assert.equal(isTerminalStatus("final_approved"), true, "final_approved must be terminal");
    assert.equal(isTerminalStatus("cancelled"), true, "cancelled must be terminal");
    assert.equal(isTerminalStatus("draft"), false, "draft must not be terminal");
    assert.equal(isTerminalStatus("submitted"), false, "submitted must not be terminal");
    assert.equal(isTerminalStatus("manager_approved"), false, "manager_approved must not be terminal");
    assert.equal(isTerminalStatus("ceo_approved"), false, "ceo_approved must not be terminal");
  }

  // 16. Permissions surface: 'weekly_plans' is in permissionResources.
  {
    assert.ok(
      permissionResources.includes("weekly_plans"),
      "'weekly_plans' must be in permissionResources array",
    );
  }

  // 17. Audit entity types: source file contains 'weekly_plan' and 'weekly_plan_day'.
  {
    // AuditEntityType is a TypeScript type union, not a runtime value, so we
    // verify by reading the source file directly.
    const auditFilePath = join(__dirname, "../src/lib/admin/audit.ts");
    const auditSource = readFileSync(auditFilePath, "utf8");
    assert.ok(
      auditSource.includes('"weekly_plan"'),
      'audit.ts AuditEntityType must include "weekly_plan"',
    );
    assert.ok(
      auditSource.includes('"weekly_plan_day"'),
      'audit.ts AuditEntityType must include "weekly_plan_day"',
    );
  }

  // 18. Safety: workflow.ts exports no mutation-adjacent names; source files
  //     do not reference payroll or leave tables.
  {
    const dangerousExportPattern = /mutate|pushToPayroll|writeLeave|updateSalary|execute|deductPayroll/;
    const exportedNames = Object.keys(Wf);
    for (const name of exportedNames) {
      assert.ok(
        !dangerousExportPattern.test(name),
        `workflow.ts must not export '${name}' (matches danger pattern)`,
      );
    }

    const forbiddenTableRefs = [
      "salary_records",
      "employee_leave_balances",
      "leave_transactions",
      "v2_vacation_requests",
    ];
    const srcDir = join(__dirname, "../src/lib/weekly-planning");
    const srcFiles = ["workflow.ts", "week.ts", "types.ts"];
    for (const fname of srcFiles) {
      const content = readFileSync(join(srcDir, fname), "utf8");
      for (const tableRef of forbiddenTableRefs) {
        assert.ok(
          !content.includes(tableRef),
          `${fname} must not reference '${tableRef}'`,
        );
      }
    }
  }

  // 19. WeeklyPlanStatus exhaustiveness: weeklyPlanStatuses.length === 8.
  {
    assert.equal(weeklyPlanStatuses.length, 8, "must have exactly 8 status values");
  }

  // 20. weeklyPlanActivityTypes.length === 11 and weeklyPlanActivityCodes.length === 11.
  {
    assert.equal(weeklyPlanActivityTypes.length, 11, "must have exactly 11 activity types");
    assert.equal(weeklyPlanActivityCodes.length, 11, "must have exactly 11 activity codes");
  }

  // Bonus: WEEKLY_PLAN_ELIGIBLE_JOB_TITLES must not include 'Medical Rep'.
  {
    assert.ok(
      !WEEKLY_PLAN_ELIGIBLE_JOB_TITLES.includes("Medical Rep"),
      "Medical Rep must NOT appear in WEEKLY_PLAN_ELIGIBLE_JOB_TITLES",
    );
  }
}
