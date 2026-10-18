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
import {
  chooseRevisionTarget,
  dropPendingRevisionsOfPlansOfRecord,
  PERIOD_CLAIMED_MESSAGE,
  REVISION_PENDING_MESSAGE,
  translatePlanUniqueViolation,
  type RevisionSibling,
} from "../src/lib/weekly-planning/plan-revisions.ts";

export function runWeeklyMonthlyPlansV1Tests() {
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Product Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Group Product Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Training Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("National Sales Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Admin HR"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Senior Admin HR Specialist"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("HR Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Employee", "Super Admin"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("HR Specialist", "HR Advisory"), false);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Marketing Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("SFE Manager"), false);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("District Manager"), true);
  // Owner fix (2026-07-30): the RM owns and submits a plan for their region, like the DSM below
  // them and the NSM above them. Previously false, which made the portal's Plans link a dead end.
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Regional Manager"), true);
  assert.equal(isWeeklyMonthlyPlanEligibleTitle("Regional Sales Manager"), true);
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
  const migrationSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260606125715_weekly_monthly_plans_v1.sql", "utf8");
  const calendarAuthRemovalMigrationSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260607120000_remove_weekly_plan_google_calendar_auth.sql", "utf8");
  const followUpMigrationSource = readFileSync("supabase/_migrations_archive/pre-baseline-2026-07-11/20260606133000_employee_plan_followup_enhancements.sql", "utf8");
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
    /channels: emailMode !== "none" && \(normalizeHrId\(recipient\.hrId\) \|\| recipient\.userId \|\| ""\) === primaryKey \? \["in_app", "email", "telegram", "push"\] : \["in_app", "telegram", "push"\]/,
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
  // The three submit paths route through afterPlanSubmitted (2026-09-03), which calls
  // notifyPlanSubmitted unconditionally as its FIRST statement before reconciling the monthly
  // plan. Counting the funnel is what this assertion always meant and is strictly stronger than
  // counting three loose call sites: a fourth submit path can no longer forget the fan-out by
  // simply not repeating the call, and no path can reach the reconciliation without notifying.
  const submitFanoutCount = (serviceSource.match(/await afterPlanSubmitted\(/g) ?? []).length;
  assert.ok(submitFanoutCount >= 3, "all three submit paths must fan out to manager + HR");
  assert.match(
    serviceSource,
    /async function afterPlanSubmitted[^{]*\{\s*await notifyPlanSubmitted\(plan\);/,
    "the submit funnel must notify BEFORE anything else, so no later step can skip the fan-out",
  );

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
  assert.match(planningCalendarUiSource, /"Date", "Employee", "Activity", "Region \/ Location", "Area", "Medical Rep", "Time", "Plan Status", "Conflict Warning"/, "planning details table must expose the full visible activity columns");
  assert.doesNotMatch(planningCalendarUiSource, /"Conflict Warning", "Notes"/, "planning details table must not show a Notes column");
  assert.doesNotMatch(planningCalendarUiSource, /contentClassName="grid gap-2 md:grid-cols-2 2xl:grid-cols-3"/, "selected planning day details must no longer render as a responsive card grid");

  const baseItem = {
    activityTitle: "Double Visit",
    activityType: "Double Visit",
    area: "Munufia 2",
    conflictKey: planningConflictKey("2026-06-21", "Line A", "MR-1"),
    conflictWarning: null,
    employeeDisplayName: "placeholder",
    employeeJobTitle: "Product Manager",
    endDate: "2026-06-21",
    lineName: "Line A",
    medicalRepDisplayName: "Ahmed Rep",
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
    { ...baseItem, employeeDisplayName: "Russia Sabri", employeeHrId: "E-1", employeeName: "Russia Sabri", id: "plan-item-1" },
    { ...baseItem, employeeDisplayName: "Nahid Hatab", employeeHrId: "E-2", employeeName: "Nahid Hatab", id: "plan-item-2" },
    { ...baseItem, conflictKey: planningConflictKey("2026-06-21", "Line B", "MR-1"), employeeDisplayName: "Other Line", employeeHrId: "E-3", employeeName: "Other Line", id: "plan-item-3", lineName: "Line B" },
  ];
  const conflicts = buildPlanningCalendarConflicts(conflictItems);
  assert.equal(conflicts.length, 1, "same date + same Medical Rep must warn once — cross-line conflicts are now detected");
  assert.deepEqual(conflicts[0].employeeNames, ["Nahid Hatab", "Other Line", "Russia Sabri"]);
  assert.equal(attachPlanningConflictWarnings(conflictItems, conflicts)[0].conflictWarning !== null, true);
  // A Medical Rep the directory cannot name must never surface as an HR id in the warning text.
  const unnamedRepItems: PlanningCalendarPlanItem[] = conflictItems.slice(0, 2).map((item) => ({
    ...item,
    conflictKey: planningConflictKey("2026-06-21", "Line A", "MR-9"),
    medicalRepDisplayName: null,
    medicalRepHrId: "MR-9",
    medicalRepName: null,
  }));
  const unnamedRepConflicts = buildPlanningCalendarConflicts(unnamedRepItems);
  assert.equal(unnamedRepConflicts.length, 1, "two employees on one unnamed Medical Rep still warn once");
  assert.doesNotMatch(unnamedRepConflicts[0].warning, /MR-9/, "the conflict warning must never print the Medical Rep's HR id");
  assert.match(unnamedRepConflicts[0].warning, /the same Medical Rep/, "an unnamed Medical Rep reads as 'the same Medical Rep'");
  assert.equal(unnamedRepConflicts[0].medicalRepHrId, "MR-9", "the HR id stays in the data field the callers match on");
  assert.equal(planningCalendarTitle("Russia Sabri", "Delta 2", "Munufia 2", "Double Visit"), "Russia Sabri - Delta 2 - Munufia 2");
  assert.match(
    sameLineBookingWarning({
      activityDate: "2026-06-21",
      bookings: [
        {
          activityTitle: "Double Visit",
          area: "Munufia 2",
          date: "2026-06-21",
          employeeDisplayName: "Nahid Hatab",
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
    // Slice to the END of the function, not a fixed byte count. A magic window both
    // false-FAILS when the function grows past it and false-PASSES by spilling into the
    // next function's rpc call, so it measured source length rather than the invariant.
    const rest = serviceSource.slice(fnStart + 1);
    const nextFn = rest.search(/^export (?:async )?function /m);
    const fnEnd = nextFn >= 0 ? fnStart + 1 + nextFn : serviceSource.length;
    const fnBody = serviceSource.slice(fnStart, fnEnd);
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

  runWeeklyPlanRevisionTests();
}

// ── Amending an APPROVED plan ────────────────────────────────────────────────────────────────────
// Production, 2026-10-18: an employee could not amend an approved plan. The revision header was
// inserted, then promoting it to 'submitted' collided with its own approved parent in
// employee_plan_headers_active_period_uidx, and the form said "You already have an active plan for
// this period." — 24 revision headers existed, none ever submitted, 23 of them empty orphan drafts.
// The database cannot run in the unit suite, so the SQL is pinned by what the migration SAYS (with
// its comments stripped, so prose can never satisfy an assertion) and the decisions by pure functions.
function sibling(id: string, status: RevisionSibling["status"], createdAt: string, revision = 6): RevisionSibling {
  return { createdAt, id, revision, status };
}

function stripSqlComments(sql: string) {
  return sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
}

function runWeeklyPlanRevisionTests() {
  // ── 1 · What updateEmployeePlan does with a closed plan ───────────────────────────────────────
  assert.deepEqual(chooseRevisionTarget("hr_acknowledged", []), { kind: "create", linkToParent: true });
  assert.deepEqual(chooseRevisionTarget("final_approved", []), { kind: "create", linkToParent: true });

  // A retry reuses the open draft instead of leaving a second empty one behind (23 of them did).
  assert.deepEqual(
    chooseRevisionTarget("hr_acknowledged", [
      sibling("older-draft", "draft", "2026-10-05T10:00:00Z"),
      sibling("newer-draft", "draft", "2026-10-05T11:00:00Z", 7),
    ]),
    { kind: "reuse", revision: 7, revisionId: "newer-draft" },
    "the newest open draft is the one to edit",
  );
  // A returned revision is LIVE (it holds the one-live-revision slot), so it outranks any stray draft.
  assert.deepEqual(
    chooseRevisionTarget("hr_acknowledged", [
      sibling("stray-draft", "draft", "2026-10-06T10:00:00Z"),
      sibling("returned", "manager_returned", "2026-10-05T10:00:00Z"),
    ]),
    { kind: "reuse", revision: 6, revisionId: "returned" },
  );
  assert.equal(chooseRevisionTarget("hr_acknowledged", [sibling("r", "ceo_returned", "2026-10-05T10:00:00Z")]).kind, "reuse");

  // One live revision per parent: while one awaits a decision, spawning another would collide.
  for (const waiting of ["submitted", "edit_requested", "details_requested", "manager_approved", "ceo_approved"] as const) {
    assert.deepEqual(
      chooseRevisionTarget("hr_acknowledged", [
        sibling("stray-draft", "draft", "2026-10-06T10:00:00Z"),
        sibling("waiting", waiting, "2026-10-05T10:00:00Z"),
      ]),
      { kind: "blocked" },
      `a ${waiting} revision blocks another one, stray draft or not`,
    );
  }
  // A revision that died frees the slot.
  assert.deepEqual(
    chooseRevisionTarget("hr_acknowledged", [
      sibling("rej", "manager_rejected", "2026-10-05T10:00:00Z"),
      sibling("rej2", "ceo_rejected", "2026-10-05T11:00:00Z"),
      sibling("can", "cancelled", "2026-10-05T12:00:00Z"),
    ]),
    { kind: "create", linkToParent: true },
  );

  // A DEAD plan spawns an UNLINKED draft: the unique index exempts only revisions of an approved
  // plan, so a linked revision of a dead one would sit beside whatever live plan the period holds.
  for (const dead of ["cancelled", "manager_rejected", "ceo_rejected"] as const) {
    assert.deepEqual(
      chooseRevisionTarget(dead, [sibling("old", "draft", "2026-10-05T10:00:00Z")]),
      { kind: "create", linkToParent: false },
      `a revision of a ${dead} plan is a fresh claim on the period, not a linked revision`,
    );
  }

  // ── 2 · The readers: a pending revision never draws beside its approved parent ────────────────
  const approvedParent = { id: "R", parent_plan_id: null, status: "hr_acknowledged" };
  for (const waiting of ["submitted", "manager_approved", "ceo_approved"]) {
    assert.deepEqual(
      dropPendingRevisionsOfPlansOfRecord([approvedParent, { id: "V", parent_plan_id: "R", status: waiting }]),
      [approvedParent],
      `a ${waiting} revision is left out while the plan it revises is the plan of record`,
    );
  }
  assert.deepEqual(
    dropPendingRevisionsOfPlansOfRecord([
      { id: "R", parent_plan_id: null, status: "final_approved" },
      { id: "V", parent_plan_id: "R", status: "submitted" },
    ]).map((row) => row.id),
    ["R"],
    "final_approved is a plan of record too",
  );
  // Kept: an approved revision (the parent is cancelled by then), a revision whose parent the reader
  // never loaded, a revision of a dead parent, and every row with no parent at all.
  const keep = [
    { id: "V1", parent_plan_id: "R1", status: "final_approved" },
    { id: "V2", parent_plan_id: "R-not-loaded", status: "submitted" },
    { id: "R3", parent_plan_id: null, status: "cancelled" },
    { id: "V3", parent_plan_id: "R3", status: "submitted" },
    { id: "P4", parent_plan_id: null, status: "submitted" },
    { id: "P5", status: null },
  ];
  assert.deepEqual(dropPendingRevisionsOfPlansOfRecord(keep), keep, "nothing else is dropped, in the same order");
  assert.deepEqual(dropPendingRevisionsOfPlansOfRecord([]), []);

  // ── 3 · The error is true ─────────────────────────────────────────────────────────────────────
  const activePeriodRaw = 'duplicate key value violates unique constraint "employee_plan_headers_active_period_uidx"';
  const liveRevisionRaw = 'duplicate key value violates unique constraint "employee_plan_headers_one_live_revision_uidx"';
  assert.equal(translatePlanUniqueViolation(liveRevisionRaw, "23505"), REVISION_PENDING_MESSAGE);
  assert.equal(translatePlanUniqueViolation(activePeriodRaw, "23505"), PERIOD_CLAIMED_MESSAGE);
  assert.equal(translatePlanUniqueViolation(activePeriodRaw), PERIOD_CLAIMED_MESSAGE, "the text alone is enough when no code travels");
  assert.equal(translatePlanUniqueViolation("weekly_plan_revision_conflict: expected revision 3 but found 4"), null);
  assert.equal(translatePlanUniqueViolation('duplicate key value violates unique constraint "some_other_uidx"', "23505"), null);
  for (const message of [REVISION_PENDING_MESSAGE, PERIOD_CLAIMED_MESSAGE]) {
    assert.doesNotMatch(
      message,
      /duplicate key|already exists|active_period_uidx|23505|You already have an active plan/i,
      "a translated message must not be re-translated into the false sentence by the form",
    );
  }

  const service = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  assert.match(
    service,
    /const uniqueViolation = translatePlanUniqueViolation\(message, obj\.code\);[\s\S]*?new WeeklyPlanRpcError\("duplicate_period", uniqueViolation\)/,
    "rethrowWeeklyPlanRpcError must turn a unique violation on the plan indexes into a typed 409 with a true sentence",
  );

  const ui = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const friendlyStart = ui.indexOf("function friendlyError(");
  assert.ok(friendlyStart > 0, "the form's friendlyError must exist");
  const friendly = ui.slice(friendlyStart, ui.indexOf("\n}\n", friendlyStart));
  assert.doesNotMatch(friendly, /You already have an active plan for this period/, "the form must not claim an active plan it cannot know about");
  assert.doesNotMatch(friendly, /duplicate key\|already exists/, "the server's own 'already exists' sentence must reach the person");

  // ── 4 · The service: reuse, refuse, link only an approved parent, take back what failed ───────
  const reviseStart = service.indexOf("if (isClosedEmployeePlanStatus(existing.status)) {");
  assert.ok(reviseStart > 0, "updateEmployeePlan's closed-plan branch must exist");
  const revise = service.slice(reviseStart, service.indexOf("if (!canEditEmployeePlanStatus(existing.status))", reviseStart));
  assert.match(revise, /chooseRevisionTarget\(existing\.status, await loadRevisionSiblings\(existing\.id\)\)/, "the branch must ask what to do with the revisions that already exist");
  assert.match(revise, /target\.kind === "blocked"[\s\S]*?REVISION_PENDING_MESSAGE/, "a revision already awaiting a decision must be refused with the true sentence");
  assert.match(revise, /target\.kind === "reuse"[\s\S]*?loadPlanRow\(target\.revisionId\)/, "an open revision must be edited, not duplicated");
  assert.match(revise, /parent_plan_id: target\.linkToParent \? existing\.id : null/, "only a revision of an APPROVED plan is linked to it");
  assert.doesNotMatch(revise, /parent_plan_id: existing\.id,/, "the parent link must never be unconditional");
  assert.match(revise, /catch \(itemsError\) \{[\s\S]*?if \(spawnedHere\) await discardUnsubmittedRevision\(revisionRow\.id\);[\s\S]*?throw itemsError;/, "a failed item write must take back the draft THIS call made, and rethrow");
  assert.match(service, /async function discardUnsubmittedRevision[\s\S]*?\.delete\(\)[\s\S]*?\.eq\("status", "draft"\)/, "only a draft may be taken back");

  // The readers that list the pre-approval statuses must hide a pending revision.
  for (const [path, needle] of [
    ["src/lib/weekly-planning/calendar-service.ts", "dropPendingRevisionsOfPlansOfRecord(loadedHeaders.slice("],
    ["src/lib/private-calendar/plan-items.ts", "dropPendingRevisionsOfPlansOfRecord(headers)"],
    ["src/lib/weekly-planning/plan-adherence-data.ts", "dropPendingRevisionsOfPlansOfRecord((data ?? []) as PlanHeaderRow[])"],
  ] as const) {
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes(needle), `${path} must hide a pending revision beside its approved parent`);
    assert.ok(/parent_plan_id/.test(text), `${path} must select parent_plan_id to be able to`);
  }
  assert.equal(
    (service.match(/dropPendingRevisionsOfPlansOfRecord\(\s*\(headers \?\? \[\]\)/g) ?? []).length,
    2,
    "both prefill sources (weekly into monthly, monthly into weekly) must hide a pending revision",
  );
  assert.match(
    readFileSync("src/lib/calendar/service.ts", "utf8"),
    /\.neq\("status", "cancelled"\)/,
    "a plan replaced by its revision is cancelled and keeps its rows, so the personal calendar must skip cancelled plans",
  );

  // ── 5 · The migration ─────────────────────────────────────────────────────────────────────────
  const migrationFile = readdirSync("supabase/migrations").find((name) => name === "20261018233000_weekly_plan_revision_supersedes_approved_parent.sql");
  assert.ok(migrationFile, "the revision migration must exist under its minted timestamp");
  const sql = stripSqlComments(readFileSync(`supabase/migrations/${migrationFile}`, "utf8"));

  assert.ok(
    sql.includes(
      "create unique index employee_plan_headers_active_period_uidx on public.employee_plan_headers (employee_hr_id, plan_kind, period_key) " +
        "where status not in ('draft', 'cancelled', 'manager_rejected', 'ceo_rejected') " +
        "and (parent_plan_id is null or status in ('final_approved', 'hr_acknowledged'));",
    ),
    "one live plan per employee/kind/period must survive — a pending revision is the only thing it stops counting",
  );
  assert.ok(
    sql.includes(
      "create unique index employee_plan_headers_one_live_revision_uidx on public.employee_plan_headers (parent_plan_id) " +
        "where parent_plan_id is not null and status not in ('draft', 'cancelled', 'manager_rejected', 'ceo_rejected');",
    ),
    "at most one live revision per parent",
  );
  assert.match(sql, /drop index if exists public\.employee_plan_headers_active_period_uidx; create unique index employee_plan_headers_active_period_uidx/, "re-appliable: drop then create");
  assert.match(sql, /^begin;.*commit;$/, "one transaction");

  const decide = sql.slice(sql.indexOf("create or replace function public.phx_weekly_plan_decide("));
  const supersedeIdx = decide.indexOf("if next_status = 'final_approved' and header_parent_id is not null then");
  const parentCancelIdx = decide.indexOf("set status = 'cancelled'");
  const headerUpdateIdx = decide.indexOf("set status = next_status");
  assert.ok(supersedeIdx > 0, "the decision that approves a revision must supersede its parent");
  assert.ok(
    supersedeIdx < parentCancelIdx && parentCancelIdx < headerUpdateIdx,
    "the parent must leave the index BEFORE the revision enters it, or the approval collides with its own parent",
  );
  assert.match(
    decide,
    /where id = header_parent_id and employee_hr_id = header_employee_hr_id and plan_kind = header_plan_kind and period_key = header_period_key for update;/,
    "the parent is locked, and only cancelled when it is the same employee, kind and period",
  );
  assert.match(decide, /if parent_status in \('final_approved', 'hr_acknowledged'\) then/, "only a plan of record is superseded");
  assert.match(decide, /\(header_parent_id, p_actor_hr_id, p_actor_login_id, p_actor_role, 'cancel', parent_status, 'cancelled',/, "the parent gets a decision row, or the D5 drift check flags it");
  assert.match(decide, /security definer set search_path to 'public', 'pg_temp'/, "still SECURITY DEFINER with a pinned search_path");
  assert.match(
    sql,
    /revoke execute on function public\.phx_weekly_plan_decide\(uuid, integer, text, text, text, text, text, jsonb, boolean\) from public, anon, authenticated; grant execute on function public\.phx_weekly_plan_decide\(uuid, integer, text, text, text, text, text, jsonb, boolean\) to service_role;/,
    "service_role only",
  );
  // What did not change.
  assert.match(decide, /p_bypass_ceo boolean default false/, "the signature keeps its defaulted parameter, or the old overload would be left beside it");
  assert.match(decide, /final_approved_at = case when next_status = 'final_approved' then now_ts else final_approved_at end/, "final approval still stamps final_approved_at");
  assert.match(decide, /insert into public\.employee_plan_item_return_notes/, "item return notes still travel with a return");
}
