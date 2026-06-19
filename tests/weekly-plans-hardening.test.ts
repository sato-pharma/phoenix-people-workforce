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

  assert.match(workflowE2eSource, /EMPLOYEE_PLANS_PATH = "\/employee-portals\/plans"/, "submitter workflow must use employee portal route");
  assert.match(workflowE2eSource, /MANAGER_PLANS_PATH = "\/workspace\/plans"/, "Marketing Manager reviewer workflow must use workspace route");
  assert.match(workflowE2eSource, /ADMIN_PLANS_PATH = "\/admin\/weekly-plans"/, "CEO and HR workflow must use admin route");
  assert.match(workflowE2eSource, /Never point this mutating workflow at production/, "mutating workflow must be marked local/staging only");

  assert.match(readonlyE2eSource, /GET requests only/, "read-only smoke must avoid mutations");
  assert.match(readonlyE2eSource, /\/employee-portals\/plans\/calendar/, "read-only smoke must cover employee calendar");
  assert.match(readonlyE2eSource, /\/workspace\/plans\/calendar/, "read-only smoke must cover workspace calendar");
  assert.match(readonlyE2eSource, /\/admin\/weekly-plans\/calendar/, "read-only smoke must cover admin calendar");
}
