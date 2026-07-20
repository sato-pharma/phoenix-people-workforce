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
  // 2026-07-20: Marketing Manager and Training Manager stay unrestricted, but
  // Group Product Manager / National Sales Manager / Product Manager are now
  // scoped to their own line (plus one named counterpart role each), and B-155
  // (Ahmed Sharaf) has a hardcoded Pedia + Anti Infective + Training Manager
  // exception. See tests/weekly-plan-calendar-owner-scope.test.ts for the full
  // per-role/line matrix coverage. These guards confirm the matrix shape
  // without pinning the exact conditional wording, and confirm the old
  // hierarchy-based mechanisms (manager-seat / region fencing) were not what
  // came back — the new scoping is pure role+line+HR_ID matching, not topology.
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
  assert.doesNotMatch(
    calendarServiceSource,
    /reportsToManagerSeat\(\{[\s\S]*?\}\)/,
    "isPlanItemVisibleToViewer must not reintroduce District-Manager hierarchy viewer fencing",
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

  assert.match(readonlyE2eSource, /GET requests only/, "read-only smoke must avoid mutations");
  assert.match(readonlyE2eSource, /\/employee-portals\/plans\/calendar/, "read-only smoke must cover employee calendar");
  assert.match(readonlyE2eSource, /Marketing Manager employee portal reviewer/, "read-only smoke must cover the MM employee portal reviewer");
  assert.match(readonlyE2eSource, /\/admin\/weekly-plans\/calendar/, "read-only smoke must cover admin calendar");
}
