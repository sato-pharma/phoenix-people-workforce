import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";

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
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Marketing Manager"), true);
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
  assert.match(
    serviceSource,
    /channels: emailMode !== "none" && \(normalizeHrId\(recipient\.hrId\) \|\| recipient\.userId \|\| ""\) === primaryKey \? \["in_app", "email", "telegram"\] : \["in_app", "telegram"\]/,
    "workflow notifications should route email to only the primary notification recipient",
  );
  assert.match(serviceSource, /emailMode: "none"/, "HR submit notifications should avoid duplicate submit emails");
  assert.match(serviceSource, /emailCcRecipients: ccRecipients/, "manager submit email should include CC recipients");
  assert.match(serviceSource, /cc: ccEmails/, "weekly planning submission emails must include CC visibility recipients");
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
  assert.match(workspaceSource, /workspace\.hasMorePlans/, "plans workspace must expose capped-results metadata in the UI");
  assert.match(workspaceSource, /Showing the latest \{workspace\.loadedPlanCount\}/, "plans workspace must warn when plan results are capped");
  assert.match(workspaceSource, /nextWeeklyPlanStart/, "new weekly plans must default to the next selectable planning week");
  assert.match(workspaceSource, /Plan week/, "weekly editor must expose a clear Plan week selector");
  assert.match(workspaceSource, /weeklyPlanWeekOptions/, "weekly editor must provide explicit week choices instead of only an anchor date");
  assert.match(workspaceSource, /periodLocked/, "saved plans must keep their stored period while editing rows");
  assert.match(workspaceSource, /New plan/, "saved-plan editing must expose a separate new-plan action for another week");
  assert.match(workspaceSource, /draftRowsFromPlan/, "deep-linked saved plans must initialize from their saved rows");
  assert.match(workspaceSource, /This account is not eligible to submit weekly\/monthly plans/, "submit errors must expose the actual eligibility reason");
  assert.doesNotMatch(workspaceSource, /Retry Calendar/, "Google Calendar sync retry UI must be removed");
  assert.match(workspaceSource, /workspace\.summary/);
  assert.match(workspaceSource, /Export XLSX/);
  assert.match(exportRouteSource, /application\/pdf/);
  assert.match(exportRouteSource, /format=xlsx\|pdf|format/);
  assert.match(exportSource, /buildEmployeePlansWorkbook/);
  assert.match(exportSource, /buildEmployeePlansPdf/);

  // HR must be alerted on EVERY submission (in-app + email + Telegram), alongside the
  // direct manager — and a fresh submit must fan out to both via notifyPlanSubmitted.
  assert.match(serviceSource, /async function notifyHrOnSubmit/, "HR submit alert helper must exist");
  assert.match(serviceSource, /async function notifyPlanSubmitted/, "combined submit fan-out must exist");
  assert.match(
    serviceSource,
    /notifyHrOnSubmit[\s\S]*?hrAcknowledgementRecipients\(\)/,
    "HR submit alert must resolve the HR recipient audience",
  );
  assert.match(
    serviceSource,
    /notifyHrOnSubmit[\s\S]*?!hrIdsMatch\(recipient\.hrId, plan\.manager_hr_id\)/,
    "HR submit alert must exclude the direct manager to avoid double-notifying",
  );
  assert.match(
    serviceSource,
    /notifyPlanSubmitted[\s\S]*?Promise\.allSettled\(\[notifyManager\(plan,\s*hrRecipients\), notifyHrOnSubmit\(plan,\s*hrRecipients\)\]\)/,
    "submit fan-out must reach manager + HR and isolate failures",
  );
  // Every submit site must use the combined fan-out, never the bare manager-only alert.
  assert.doesNotMatch(
    serviceSource,
    /input\.submit[\s\S]{0,80}?await notifyManager\(/,
    "submit paths must call notifyPlanSubmitted, not notifyManager directly",
  );
  const submitFanoutCount = (serviceSource.match(/await notifyPlanSubmitted\(/g) ?? []).length;
  assert.ok(submitFanoutCount >= 3, "all three submit paths must fan out to manager + HR");

  assert.match(calendarServiceSource, /loadPlanItems/, "company calendar must automatically project saved plan rows");
  assert.match(calendarServiceSource, /employee_plan_headers/, "calendar plan source must read employee plan headers");
  assert.match(calendarServiceSource, /employee_plan_items/, "calendar plan source must read employee plan items");
  assert.match(calendarServiceSource, /source:\s*"plan"/, "calendar plan source must emit plan calendar items");

  const sharedCalendarServiceSource = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  const planningCalendarUiSource = readFileSync("src/components/employee-portal/planning-calendar.tsx", "utf8");
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
  assert.match(sharedCalendarServiceSource, /CALENDAR_HEADER_LIMIT \+ 1/, "shared calendar must fetch one extra header row for hasMoreHeaders");
  assert.match(sharedCalendarServiceSource, /CALENDAR_ITEM_LIMIT \+ 1/, "shared calendar must fetch one extra item row for hasMoreItems");
  assert.match(planningCalendarUiSource, /workspace\.hasMoreHeaders \|\| workspace\.hasMoreItems/, "planning calendar must warn when results are capped");
  assert.doesNotMatch(planningCalendarUiSource, /xl:grid-cols-\[minmax\(0,1fr\)_360px\]/, "planning calendar must not narrow the month grid with a right-side detail rail");
  assert.match(planningCalendarUiSource, /PlanningCalendarDetailsTable/, "selected planning day details must render in the polished details table");
  assert.match(planningCalendarUiSource, /"Date", "Employee", "Activity", "Region \/ Location", "Area", "Medical Rep", "Time", "Plan Status", "Conflict Warning", "Notes"/, "planning details table must expose the full visible activity columns");
  assert.doesNotMatch(planningCalendarUiSource, /contentClassName="grid gap-2 md:grid-cols-2 2xl:grid-cols-3"/, "selected planning day details must no longer render as a responsive card grid");

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
  assert.equal(conflicts.length, 1, "same date + same Medical Rep must warn once — cross-line conflicts are now detected");
  assert.deepEqual(conflicts[0].employeeNames, ["Nahid Hatab", "Other Line", "Russia Sabri"]);
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
  // ── cancel state-machine transitions (PR 3 of the 10/10 plan) ────────────
  assert.equal(getNextEmployeePlanStatus("draft", "cancel"), "cancelled", "cancel from draft must reach cancelled");
  assert.equal(getNextEmployeePlanStatus("submitted", "cancel"), "cancelled", "cancel from submitted must reach cancelled");
  assert.equal(getNextEmployeePlanStatus("manager_returned", "cancel"), "cancelled", "cancel from manager_returned must reach cancelled");
  assert.equal(getNextEmployeePlanStatus("ceo_returned", "cancel"), "cancelled", "cancel from ceo_returned must reach cancelled");
  assert.throws(() => getNextEmployeePlanStatus("final_approved", "cancel"), "cancel from final_approved must throw");
  assert.throws(() => getNextEmployeePlanStatus("hr_acknowledged", "cancel"), "cancel from hr_acknowledged must throw");
  assert.throws(() => getNextEmployeePlanStatus("cancelled", "cancel"), "cancel from already-cancelled must throw");

  // ── cancel route exists ───────────────────────────────────────────────────
  const routeDir = "app/api/weekly-plans/[id]/cancel";
  const cancelRouteExists = readdirSync(routeDir).some((f) => f === "route.ts");
  assert.ok(cancelRouteExists, "cancel route.ts must exist at app/api/weekly-plans/[id]/cancel/route.ts");

  const cancelRouteSource = readFileSync("app/api/weekly-plans/[id]/cancel/route.ts", "utf8");
  assert.match(cancelRouteSource, /cancelEmployeePlan/, "cancel route must delegate to cancelEmployeePlan");
  assert.match(cancelRouteSource, /assertSameOriginMutation/, "cancel route must enforce CSRF");
  assert.match(cancelRouteSource, /isWeeklyPlanRpcError/, "cancel route must map RPC errors to HTTP status");

  // ── RPC wiring invariant: every write function uses supabase.rpc() ────────
  // Guards against a future regression back to bare multi-step writes.
  // Every service-level write function must directly call a phx_weekly_plan_* RPC
  // OR call one of the internal rpc*Plan wrapper functions (rpcSubmitPlan,
  // rpcDecidePlan, rpcAcknowledgePlan, rpcCancelPlan) that themselves call the RPC.
  for (const fn of ["createEmployeePlan", "updateEmployeePlan", "decideEmployeePlan", "acknowledgeEmployeePlan", "cancelEmployeePlan"]) {
    const fnStart = serviceSource.indexOf(`export async function ${fn}`);
    assert.ok(fnStart >= 0, `${fn} must be exported from service.ts`);
    const fnBody = serviceSource.slice(fnStart, fnStart + 3000);
    const callsRpcDirectly = fnBody.includes('rpc("phx_weekly_plan_');
    const callsRpcWrapper = /rpc(?:Replace|Decide|Acknowledge|Cancel)Plan(?:Items)?\(/.test(fnBody);
    assert.ok(
      callsRpcDirectly || callsRpcWrapper,
      `${fn} must call supabase.rpc("phx_weekly_plan_…") or a rpc*Plan wrapper — bare multi-step writes regressed`,
    );
  }

  // ── import-route-does-not-exist invariant ─────────────────────────────────
  // The audit raised XLSX import as a gap; we deliberately have no import route.
  // Pin the absence so future audits don't re-raise it as an accidental omission.
  const routeFiles = readdirSync("app/api/weekly-plans").flatMap((entry) => {
    try { return readdirSync(`app/api/weekly-plans/${entry}`).map((f) => `${entry}/${f}`); } catch { return [entry]; }
  });
  assert.ok(
    !routeFiles.some((f) => /import/.test(f)),
    "weekly-plans must NOT have an import route — XLSX import is deliberately out of scope",
  );

}
