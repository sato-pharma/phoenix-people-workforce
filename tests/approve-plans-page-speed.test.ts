import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The approve-plans page (/employee-portals/approvals/plan, /admin/approvals/plan) took 6.3 s to
// 13.2 s on production on 2026-10-23 (Railway request log, five real loads that afternoon). It
// shows ONE module, yet it waited on:
//   - all ten "decisions I made" history feeds (leave, excuse, salary, sales imports, marketing,
//     expenses, direct orders …) only to keep the weekly-plan rows;
//   - all six "My Requests" sources, one of them the viewer's WHOLE plan form with every day and
//     visit embedded (getEmployeePlansWorkspace), only to keep each plan's header;
//   - one awaited login-role read per queued plan, row after row, inside the inbox loop.
// The fix reads only what the page shows. Owner, 2026-10-23: "fix the approve plans page under
// one second".
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

function functionBody(code: string, name: string): string {
  const at = code.indexOf(`export async function ${name}(`);
  assert.notEqual(at, -1, `${name} must exist`);
  const next = code.indexOf("\nexport ", at + 10);
  return code.slice(at, next === -1 ? undefined : next);
}

export async function runApprovePlansPageSpeedTests() {
  const actionCenter = read("src/lib/action-center/service.ts");
  const hub = read("src/lib/approvals-hub/service.ts");
  const planning = read("src/lib/weekly-planning/service.ts");

  // ── My Requests: one module's source, and the plan source is the header list ──
  const myRequests = functionBody(actionCenter, "getMyRequestItems");
  assert.match(myRequests, /options\?: \{ only\?: MyRequestItem\["module"\] \}/, "getMyRequestItems takes an `only` module");
  assert.doesNotMatch(
    actionCenter,
    /getEmployeePlansWorkspace/,
    "RED My Requests must not load the viewer's whole plan form (days, visits, CRM overlay) to show plan headers",
  );
  assert.match(
    myRequests,
    /source\("weekly_plan", \(\) => listMyOwnPlanSummaries\(access\)\)/,
    "the plan source is the narrow own-plan header read",
  );
  const sources = [...myRequests.matchAll(/source\("([a-z_]+)", /g)].map((m) => m[1]);
  assert.deepEqual(
    sources.sort(),
    ["direct_order", "excuse", "leave", "outstation", "resignation", "weekly_plan"],
    "every My Requests source is gated by `only`, tagged with the module it maps to",
  );

  // ── History: every feed is gated, tagged with the module its rows map to ──
  const history = functionBody(actionCenter, "getMyApprovalHistory");
  const feeds = [...history.matchAll(/feed\("([a-z_]+)", \(\) => fetchAllApprovalRows<([A-Za-z]+)>\(/g)].map((m) => [m[1], m[2]]);
  assert.equal(feeds.length, 10, "RED all ten history feeds must be gated by `only` — one left ungated is one the plan page still waits on");
  assert.deepEqual(
    Object.fromEntries(feeds.map(([module, row]) => [row, module])),
    {
      DecidedLeaveRow: "leave",
      DecidedExcuseRow: "excuse",
      DecidedPlanRow: "weekly_plan",
      DecidedResignationRow: "resignation",
      DecidedSalaryBatchRow: "salary",
      DecidedSalesImportRow: "sales_import",
      DecidedMarketingStepRow: "marketing_request",
      DecidedExpenseRow: "payroll_expense",
      DecidedVacationStepRow: "leave",
      DecidedDirectOrderEventRow: "direct_order",
    },
    "each feed's tag must be the module its rows are mapped to, or `only` would hide a module's own history",
  );

  // ── The approve pages ask for their own module only ──
  for (const [fn, module] of [
    ["getResponderPlanHistory", "weekly_plan"],
    ["getMyPlanRequestItems", "weekly_plan"],
    ["getResponderVacationHistory", "leave"],
    ["getMyVacationRequestItems", "leave"],
    ["getResponderExcuseHistory", "excuse"],
    ["getMyExcuseRequestItems", "excuse"],
  ] as const) {
    assert.match(
      functionBody(hub, fn),
      new RegExp(`\\(access, \\{ only: "${module}" \\}\\)`),
      `RED ${fn} must read only the ${module} module, never every module then filter`,
    );
  }

  // ── The inbox resolves submitter roles in one read, never one per row ──
  const inbox = functionBody(hub, "getPlanApprovalsForResponder");
  assert.doesNotMatch(
    inbox,
    /await resolveSubmitterIsDistrictManager\(/,
    "RED the plan inbox must not await a login-role read per queued plan",
  );
  assert.match(inbox, /await resolveSubmittersAreDistrictManagers\(/, "the plan inbox resolves every submitter's role in one batch");

  const batch = functionBody(planning, "resolveSubmittersAreDistrictManagers");
  assert.match(batch, /\.from\("app_auth_users"\)\.select\("hr_id,role"\)\.in\("hr_id", lookupIds\)/, "one app_auth_users read for the whole queue");
  assert.match(batch, /isDistrictManagerPlanSubmitter\(/, "the batch answers with the same rule as the per-row resolver");

  // ── The own-plan header read stays narrow and permission-checked ──
  const own = functionBody(planning, "listMyOwnPlanSummaries");
  assert.match(own, /assertPermission\(access, "employee_profile", "read"\)/, "own plans still assert employee_profile:read");
  assert.match(own, /assertPermission\(access, "weekly_plans", "read"\)/, "own plans still assert weekly_plans:read");
  assert.match(own, /const ids = hrIdLookupKeys\(access\.hrId\)/, "own plans are keyed on the viewer's own HR id");
  assert.match(own, /\.in\("employee_hr_id", ids\)/, "own plans are filtered to the viewer's own HR id");
  const select = own.match(/\.select\(\s*"([^"]+)"/);
  assert.ok(select, "own plans declare an explicit select list");
  assert.doesNotMatch(select[1], /\(/, "RED own plan headers must not embed the plan's days or items");
}
