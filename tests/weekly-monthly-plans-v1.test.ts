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
  const migrationSource = readFileSync("supabase/migrations/20260606125715_weekly_monthly_plans_v1.sql", "utf8");
  const calendarAuthRemovalMigrationSource = readFileSync("supabase/migrations/20260607120000_remove_weekly_plan_google_calendar_auth.sql", "utf8");
  const followUpMigrationSource = readFileSync("supabase/migrations/20260606133000_employee_plan_followup_enhancements.sql", "utf8");
  const pageSource = readFileSync("app/employee-portals/plans/page.tsx", "utf8");
  const navSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const accessRegistrySource = readFileSync("src/lib/security/access-registry.ts", "utf8");
  const exportRouteSource = readFileSync("app/api/weekly-plans/export/route.ts", "utf8");
  const exportSource = readFileSync("src/lib/weekly-planning/export.ts", "utf8");

  assert.match(serviceSource, /medicalRepOptionsForEmployee/, "double-visit Medical Rep options must be resolved from the employee line");
  assert.match(serviceSource, /Double Visit requires selecting a same-line Medical Rep/, "Double Visit must require a Medical Rep");
  assert.match(serviceSource, /Selected double-visit Medical Rep is not available for this employee line/, "server must validate selected Medical Rep line access");
  assert.match(serviceSource, /activityType === "Double Visit" \? selectedRepHrId : null/, "non-Double Visit rows must clear double-visit Medical Rep fields");
  assert.match(serviceSource, /recordReturnNotes/, "manager/CEO return must support row-level feedback");
  assert.doesNotMatch(serviceSource, /syncApprovedPlanToGoogleCalendar|retryEmployeePlanCalendarSync/, "Google Calendar auth/sync must be fully removed from the plans service");
  assert.match(serviceSource, /createSystemNotification/, "workflow must use unified notifications");
  assert.match(serviceSource, /channels: \["in_app", "email", "telegram"\]/, "workflow notifications must include in-app, email and Telegram");
  assert.doesNotMatch(telegramSource, /approve|reject/i, "Telegram adapter must not expose approve/reject actions");

  assert.match(migrationSource, /create table if not exists public\.employee_plan_headers/i);
  assert.match(migrationSource, /create table if not exists public\.employee_plan_hr_acknowledgements/i);
  assert.match(calendarAuthRemovalMigrationSource, /drop table if exists public\.google_calendar_connections/i);
  assert.match(calendarAuthRemovalMigrationSource, /drop column if exists google_calendar_sync_status/i);
  assert.match(calendarAuthRemovalMigrationSource, /drop column if exists calendar_sync_status/i);
  assert.doesNotMatch(accessRegistrySource, /integrations\/google-calendar/i);
  assert.match(migrationSource, /double_visit_medical_rep_hr_id/i);
  assert.match(migrationSource, /double_visit_medical_rep_name/i);
  assert.match(migrationSource, /revoke all on table public\.employee_plan_headers from anon, authenticated/i);
  assert.match(migrationSource, /enable row level security/i);
  assert.match(followUpMigrationSource, /create table if not exists public\.employee_plan_item_return_notes/i);
  assert.match(followUpMigrationSource, /on delete set null/i);
  assert.match(followUpMigrationSource, /revoke all on table public\.employee_plan_item_return_notes from anon, authenticated/i);
  assert.match(followUpMigrationSource, /enable row level security/i);

  assert.match(pageSource, /getEmployeePlansWorkspace/);
  assert.doesNotMatch(pageSource, /Google Calendar/i);
  assert.match(navSource, /Weekly \/ Monthly Plan/);
  const workspaceSource = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  assert.match(workspaceSource, /Double visit Medical Rep/);
  assert.match(workspaceSource, /workspace\.medicalRepOptions/);
  assert.match(workspaceSource, /row\.activityType === "Double Visit"/);
  assert.match(workspaceSource, /Calendar view/, "in-app Calendar view (preview) must be preserved");
  assert.doesNotMatch(workspaceSource, /Retry Calendar/, "Google Calendar sync retry UI must be removed");
  assert.match(workspaceSource, /workspace\.summary/);
  assert.match(workspaceSource, /Export visible XLSX/);
  assert.match(exportRouteSource, /application\/pdf/);
  assert.match(exportRouteSource, /format=xlsx\|pdf|format/);
  assert.match(exportSource, /buildEmployeePlansWorkbook/);
  assert.match(exportSource, /buildEmployeePlansPdf/);
}
