import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildEmployeePlanPeriod,
  canEditEmployeePlanStatus,
  getNextEmployeePlanStatus,
  isWeeklyMonthlyPlanEligibleTitle,
} from "../src/lib/weekly-planning/plan-v1.ts";

export function runWeeklyMonthlyPlansV1Tests() {
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Product Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Group Product Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Training Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("National Sales Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Marketing Manager"), false);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("SFE Manager"), false);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Regional Manager"), false);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Medical Rep"), false);

  assert.equal(getNextEmployeePlanStatus("draft", "submit"), "submitted");
  assert.equal(getNextEmployeePlanStatus("submitted", "manager_approve"), "manager_approved");
  assert.equal(getNextEmployeePlanStatus("submitted", "manager_reject", { comment: "Wrong week" }), "manager_rejected");
  assert.equal(getNextEmployeePlanStatus("submitted", "manager_return", { comment: "Edit Monday" }), "manager_returned");
  assert.equal(getNextEmployeePlanStatus("manager_approved", "ceo_approve"), "final_approved");
  assert.equal(getNextEmployeePlanStatus("manager_approved", "ceo_reject", { comment: "Not aligned" }), "ceo_rejected");
  assert.equal(getNextEmployeePlanStatus("manager_approved", "ceo_return", { comment: "Update visits" }), "ceo_returned");
  assert.equal(getNextEmployeePlanStatus("final_approved", "hr_acknowledge"), "hr_acknowledged");
  assert.equal(getNextEmployeePlanStatus("hr_acknowledged", "revise"), "draft");

  assert.throws(() => getNextEmployeePlanStatus("submitted", "manager_reject"));
  assert.throws(() => getNextEmployeePlanStatus("final_approved", "submit"));
  assert.equal(canEditEmployeePlanStatus("draft"), true);
  assert.equal(canEditEmployeePlanStatus("manager_returned"), true);
  assert.equal(canEditEmployeePlanStatus("final_approved"), false);

  assert.deepEqual(buildEmployeePlanPeriod("weekly", "2026-06-09"), {
    periodEndDate: "2026-06-11",
    periodKey: "2026-W23",
    periodStartDate: "2026-06-07",
  });
  assert.deepEqual(buildEmployeePlanPeriod("monthly", "2026-05-10"), {
    periodEndDate: "2026-05-31",
    periodKey: "2026-05",
    periodStartDate: "2026-05-01",
  });

  const serviceSource = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  const telegramSource = readFileSync("src/lib/notifications/telegram.ts", "utf8");
  const migrationSource = readFileSync("supabase/migrations/20260606105733_weekly_monthly_plans_v1.sql", "utf8");
  const pageSource = readFileSync("app/employee-portals/plans/page.tsx", "utf8");
  const navSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");

  assert.match(serviceSource, /syncApprovedPlanToGoogleCalendar/, "CEO approval must trigger Google Calendar sync service");
  assert.match(serviceSource, /status !== "final_approved" && plan\.status !== "hr_acknowledged"/, "calendar sync must not run before final approval");
  assert.match(serviceSource, /Employee has not connected Google Calendar/, "missing Google connection must be marked as blocked");
  assert.match(serviceSource, /createSystemNotification/, "workflow must use unified notifications");
  assert.match(serviceSource, /channels: \["in_app", "email", "telegram"\]/, "workflow notifications must include in-app, email and Telegram");
  assert.doesNotMatch(telegramSource, /approve|reject/i, "Telegram adapter must not expose approve/reject actions");

  assert.match(migrationSource, /create table if not exists public\.employee_plan_headers/i);
  assert.match(migrationSource, /create table if not exists public\.employee_plan_hr_acknowledgements/i);
  assert.match(migrationSource, /create table if not exists public\.google_calendar_connections/i);
  assert.match(migrationSource, /calendar_sync_status/i);
  assert.match(migrationSource, /revoke all on table public\.employee_plan_headers from anon, authenticated/i);
  assert.match(migrationSource, /enable row level security/i);

  assert.match(pageSource, /getEmployeePlansWorkspace/);
  assert.match(navSource, /Weekly \/ Monthly Plan/);
}
