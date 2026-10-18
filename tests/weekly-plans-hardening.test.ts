import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function runWeeklyPlansHardeningTests() {
  const serviceSource = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  const workspaceSource = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const calendarServiceSource = readFileSync("src/lib/weekly-planning/calendar-service.ts", "utf8");
  const calendarUiSource = readFileSync("src/components/employee-portal/planning-calendar.tsx", "utf8");
  const workflowE2eSource = readFileSync("tests/e2e/weekly-plans-workflow.spec.ts", "utf8");
  const readonlyE2eSource = readFileSync("tests/e2e/weekly-plans-readonly-smoke.spec.ts", "utf8");

  assert.match(serviceSource, /function isStrictIsoDate/, "service must validate strict YYYY-MM-DD strings");
  assert.match(serviceSource, /valid YYYY-MM-DD date/, "malformed item activityDate must be rejected with a clear server error");
  assert.match(
    serviceSource,
    /activityDate < periodStartDate \|\| activityDate > periodEndDate/,
    "out-of-period item activityDate must be rejected server-side",
  );
  assert.match(
    serviceSource,
    /rpc\("phx_weekly_plan_replace_items"[\s\S]*?p_expected_revision: input\.expectedRevision/,
    "item replacement RPC must receive expected_revision",
  );
  assert.doesNotMatch(
    serviceSource,
    /replacePlanItems[\s\S]{0,500}rpcSubmitPlan/,
    "service must not replace items before a separate submit RPC",
  );

  assert.match(serviceSource, /hasMorePlans/, "workspace API must return hasMorePlans");
  assert.match(serviceSource, /planLimit: WORKSPACE_PLAN_LIMIT/, "workspace API must return planLimit");
  assert.match(serviceSource, /loadedPlanCount/, "workspace API must return loadedPlanCount");
  assert.match(workspaceSource, /workspace\.hasMorePlans/, "workspace UI must read hasMorePlans");
  assert.match(workspaceSource, /Older records may be hidden/, "workspace UI must warn when plans are capped");

  assert.match(calendarServiceSource, /hasMoreHeaders/, "calendar API must return hasMoreHeaders");
  assert.match(calendarServiceSource, /hasMoreItems/, "calendar API must return hasMoreItems");
  assert.match(calendarServiceSource, /headerLimit: CALENDAR_HEADER_LIMIT/, "calendar API must return headerLimit");
  assert.match(calendarServiceSource, /itemLimit: CALENDAR_ITEM_LIMIT/, "calendar API must return itemLimit");
  assert.match(calendarUiSource, /workspace\.hasMoreHeaders \|\| workspace\.hasMoreItems/, "calendar UI must warn when results are capped");

  // The unconditional cross-line/cross-hierarchy viewer visibility from owner
  // decision 2026-07-19 was superseded by a role/line-scoped matrix on
  // 2026-07-20, refined TWICE same-day: CEO/Super Admin/Training Manager stay
  // fully unrestricted; Marketing Manager was narrowed from "unrestricted" to
  // Training Manager + every Product Manager/Group Product Manager
  // company-wide (an owner correction — do not reintroduce blanket MM
  // visibility); Group Product Manager/National Sales Manager/Product Manager
  // are scoped to their own line (plus one named counterpart role each);
  // District Manager is scoped to Training Manager + their own line's Product
  // Manager only; Regional Manager adds their own line's Group Product
  // Manager plus the District Managers who report DIRECTLY to them; B-155
  // (Ahmed Sharaf) has a hardcoded Pedia + Anti Infective + Training Manager
  // exception. See tests/weekly-plan-calendar-owner-scope.test.ts for the
  // full per-role/line matrix coverage. These guards confirm the matrix shape
  // without pinning the exact conditional wording, and confirm the old
  // hierarchy-based mechanisms (manager-seat / region fencing) were not what
  // came back — the new Regional Manager scoping is a flat direct-report Set
  // built once by the caller (one level, not a multi-level hierarchy walk).
  assert.match(
    calendarServiceSource,
    /export function isPlanItemVisibleToViewer\(item: PlanningCalendarPlanItem, viewer: CalendarViewerContext\): boolean \{/,
    "shared calendar's visibility function must take a viewer context, not just the item",
  );
  assert.match(
    calendarServiceSource,
    /if \(!isAllowedCalendarOwner\(item\)\) return false;/,
    "shared calendar must still gate on owner-eligibility before any viewer-scoped matrix logic",
  );
  assert.match(
    calendarServiceSource,
    /rawPlanItems\.filter\(\(item\) => isPlanItemVisibleToViewer\(item, viewerContext\)\)/,
    "shared calendar must filter submitted plan items through isPlanItemVisibleToViewer with a resolved viewer context",
  );
  assert.match(
    calendarServiceSource,
    /const AHMED_SHARAF_HR_ID = "B-155";/,
    "the shared calendar must keep the named B-155 (Ahmed Sharaf) exception, matching the same pattern as PRODUCT_SCOPE_EXCLUSIVE_HR_IDS",
  );
  assert.match(
    calendarServiceSource,
    /directReportHrIds: ReadonlySet<string>/,
    "the viewer context must carry a precomputed direct-report Set for the Regional Manager rule",
  );
  assert.doesNotMatch(
    calendarServiceSource,
    /role === "marketing manager" \|\| role === "training manager"/,
    "Marketing Manager must not be reunconditionally merged back into Training Manager's unrestricted branch",
  );

  // Owner-confirmed 2026-07-20: the calendar shows nicknames only, not the raw
  // legal name — title (the rendered agenda-list text + tooltip) must be built
  // from the nickname-aware employeeDisplayName, and search must match on it too.
  assert.match(
    calendarServiceSource,
    /title: planningCalendarTitle\(employeeDisplayName, region, area, activityTitle\)/,
    "the calendar item's rendered title must be built from the nickname-aware employeeDisplayName, not the raw legal name",
  );
  assert.match(
    calendarUiSource,
    /function planSearchText\(item: PlanningCalendarPlanItem\) \{\s*\n\s*return \[\s*\n\s*item\.employeeDisplayName,/,
    "planning calendar search text must match on the nickname-aware employeeDisplayName, not the raw legal name",
  );
  assert.doesNotMatch(
    calendarServiceSource,
    /reportsToManagerSeat\(\{[\s\S]*?\}\)/,
    "isPlanItemVisibleToViewer must not reintroduce the old multi-level District-Manager hierarchy viewer fencing helper",
  );
  assert.doesNotMatch(
    calendarServiceSource,
    /regionsWithinManagerHierarchy/,
    "isPlanItemVisibleToViewer must not reintroduce Regional-Manager region-bounded viewer fencing",
  );

  assert.match(workflowE2eSource, /EMPLOYEE_PLANS_PATH = "\/employee-portals\/plans"/, "submitter workflow must use employee portal route");
  assert.match(workflowE2eSource, /MANAGER_PLANS_PATH = "\/employee-portals\/plans"/, "Marketing Manager reviewer workflow must use employee portal route");
  assert.match(workflowE2eSource, /ADMIN_PLANS_PATH = "\/admin\/weekly-plans"/, "CEO and HR workflow must use admin route");
  assert.match(workflowE2eSource, /Never point this mutating workflow at production/, "mutating workflow must be marked local/staging only");

  // Cancelling a plan used to call notifyManager(), whose payload is hardcoded to the
  // submission copy — so the manager was told a cancelled plan "needs manager review".
  assert.match(
    serviceSource,
    /notifyManagerPlanCancelled\(cancelledRow/,
    "cancelEmployeePlan must send the cancellation notice, not the submission notice",
  );
  assert.doesNotMatch(
    serviceSource,
    /cancelledRow = await loadPlanRow\(planId\);\s*await notifyManager\(/,
    "cancelEmployeePlan must not reuse notifyManager (its copy says 'needs manager review')",
  );
  assert.match(
    serviceSource,
    /eventType: "plan_cancelled"/,
    "cancellation must use its own eventType so it is never classified as an approval request",
  );
  assert.match(
    serviceSource,
    /\$\{planNounLabel\(plan\.plan_kind\)\} was cancelled/,
    "cancellation notice title must say the plan was cancelled",
  );

  assert.match(readonlyE2eSource, /GET requests only/, "read-only smoke must avoid mutations");
  assert.match(readonlyE2eSource, /\/employee-portals\/plans\/calendar/, "read-only smoke must cover employee calendar");
  assert.match(readonlyE2eSource, /Marketing Manager employee portal reviewer/, "read-only smoke must cover the MM employee portal reviewer");
  assert.match(readonlyE2eSource, /\/admin\/weekly-plans\/calendar/, "read-only smoke must cover admin calendar");
}
