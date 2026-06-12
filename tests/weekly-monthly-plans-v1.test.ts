import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  attachPlanningConflictWarnings,
  buildPlanningCalendarConflicts,
  planningCalendarTitle,
  planningConflictKey,
  type PlanningCalendarPlanItem,
  sameLineBookingWarning,
} from "../src/lib/weekly-planning/calendar.ts";
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
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Admin HR"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Senior Admin HR Specialist"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("HR Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Employee", "Super Admin"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("HR Specialist", "Talent Acquisition"), false);
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
  const calendarServiceSource = readFileSync("src/lib/calendar/service.ts", "utf8");

  assert.match(serviceSource, /medicalRepOptionsForEmployee/, "double-visit Medical Rep options must be resolved from the employee line");
  assert.match(serviceSource, /Double Visit.*requires an assigned same-line Medical Rep/, "Double Visit must require a Medical Rep");
  assert.match(serviceSource, /Selected double-visit Medical Rep is not available for this employee line/, "server must validate selected Medical Rep line access");
  assert.match(serviceSource, /doubleVisitMedicalRepHrId: requiresRep \? selectedRepHrId : null/, "non-rep rows must clear double-visit Medical Rep fields");
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
  // The 5-column cascade rewrite dropped the literal "Double visit Medical Rep" label; assert
  // the underlying double-visit medical-rep field binding instead (stable across label changes).
  assert.match(workspaceSource, /doubleVisitMedicalRep(HrId|Name)/, "double-visit medical-rep field must be wired");
  assert.match(workspaceSource, /workspace\.medicalRepOptions/);
  assert.match(workspaceSource, /const isDoubleVisit = value === "Double Visit"/);
  assert.match(workspaceSource, /requiresRep: isDoubleVisit \|\| isCoaching/);
  // The 5-column cascade rewrite consolidated the standalone "Calendar view" preview into the
  // main vertical day-per-row grid; assert that per-day calendar rendering is still present.
  assert.match(workspaceSource, /formatDayName\(row\.activityDate\)/, "in-app per-day calendar layout (day-per-row grid) must be preserved");
  assert.match(workspaceSource, /calendarHref/, "weekly/monthly plans must expose a calendar navigation target");
  assert.match(workspaceSource, /\/employee-portals\/plans\/calendar/, "employee planning must link to the shared planning calendar");
  assert.match(workspaceSource, /\/admin\/weekly-plans\/calendar/, "admin planning must link to the shared planning calendar");
  assert.match(workspaceSource, /sameLineBookingWarning/, "editor must show non-blocking same-line Medical Rep warnings");
  assert.match(workspaceSource, /<CalendarDays className=/, "calendar navigation must use the calendar icon action");
  assert.doesNotMatch(workspaceSource, /Retry Calendar/, "Google Calendar sync retry UI must be removed");
  assert.match(workspaceSource, /workspace\.summary/);
  assert.match(workspaceSource, /Export XLSX/);
  assert.match(exportRouteSource, /application\/pdf/);
  assert.match(exportRouteSource, /format=xlsx\|pdf|format/);
  assert.match(exportSource, /buildEmployeePlansWorkbook/);
  assert.match(exportSource, /buildEmployeePlansPdf/);
  assert.match(calendarServiceSource, /loadPlanItems/, "company calendar must automatically project saved plan rows");
  assert.match(calendarServiceSource, /employee_plan_headers/, "calendar plan source must read employee plan headers");
  assert.match(calendarServiceSource, /employee_plan_items/, "calendar plan source must read employee plan items");
  assert.match(calendarServiceSource, /source:\s*"plan"/, "calendar plan source must emit plan calendar items");

  const sharedCalendarServiceSource = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  const planningCalendarPageSource = readFileSync("app/employee-portals/plans/calendar/page.tsx", "utf8");
  const adminPlanningCalendarPageSource = readFileSync("app/(admin)/admin/weekly-plans/calendar/page.tsx", "utf8");
  const planningCalendarRouteSource = readFileSync("app/api/weekly-plans/calendar/route.ts", "utf8");
  const conflictRouteSource = readFileSync("app/api/weekly-plans/conflicts/route.ts", "utf8");
  assert.match(sharedCalendarServiceSource, /sharedPlanningCalendarStatuses/, "shared calendar must restrict visible plan statuses");
  assert.match(sharedCalendarServiceSource, /loadSubmittedPlanItems/, "shared calendar must load submitted planning rows across employees");
  assert.match(sharedCalendarServiceSource, /buildPlanningCalendarConflicts/, "shared calendar must compute same-line Medical Rep conflicts");
  assert.match(planningCalendarPageSource, /getSharedPlanningCalendarWorkspace/);
  assert.match(adminPlanningCalendarPageSource, /getSharedPlanningCalendarWorkspace/);
  assert.match(planningCalendarRouteSource, /getSharedPlanningCalendarWorkspace/);
  assert.match(conflictRouteSource, /getSameLinePlanBookings/);

  const baseItem = {
    activityTitle: "Double Visit",
    activityType: "Double Visit",
    area: "Munufia 2",
    conflictKey: planningConflictKey("2026-06-21", "Line A", "MR-1"),
    conflictWarning: null,
    employeeJobTitle: "Product Manager",
    endDate: "2026-06-21",
    lineName: "Line A",
    medicalRepHrId: "MR-1",
    medicalRepName: "Ahmed Rep",
    notes: null,
    planId: "plan-1",
    planKind: "weekly",
    region: "Delta 2",
    source: "plan",
    startDate: "2026-06-21",
    status: "submitted",
    time: "Full day",
    title: "placeholder",
  } satisfies Omit<PlanningCalendarPlanItem, "employeeHrId" | "employeeName" | "id">;
  const conflictItems: PlanningCalendarPlanItem[] = [
    { ...baseItem, employeeHrId: "E-1", employeeName: "Russia Sabri", id: "plan-item-1" },
    { ...baseItem, employeeHrId: "E-2", employeeName: "Nahid Hatab", id: "plan-item-2" },
    { ...baseItem, conflictKey: planningConflictKey("2026-06-21", "Line B", "MR-1"), employeeHrId: "E-3", employeeName: "Other Line", id: "plan-item-3", lineName: "Line B" },
  ];
  const conflicts = buildPlanningCalendarConflicts(conflictItems);
  assert.equal(conflicts.length, 1, "same date + same line + same Medical Rep must warn once");
  assert.deepEqual(conflicts[0].employeeNames, ["Nahid Hatab", "Russia Sabri"]);
  assert.equal(attachPlanningConflictWarnings(conflictItems, conflicts)[0].conflictWarning !== null, true);
  assert.equal(planningCalendarTitle("Russia Sabri", "Delta 2", "Munufia 2", "Double Visit"), "Russia Sabri - Delta 2 - Munufia 2");
  assert.match(
    sameLineBookingWarning({
      activityDate: "2026-06-21",
      bookings: [
        {
          activityTitle: "Double Visit",
          area: "Munufia 2",
          date: "2026-06-21",
          employeeHrId: "E-2",
          employeeName: "Nahid Hatab",
          lineName: "Line A",
          medicalRepHrId: "MR-1",
          medicalRepName: "Ahmed Rep",
          region: "Delta 2",
        },
      ],
      currentEmployeeHrId: "E-1",
      medicalRepHrId: "MR-1",
      medicalRepName: "Ahmed Rep",
    }) ?? "",
    /warning only/i,
  );
}
