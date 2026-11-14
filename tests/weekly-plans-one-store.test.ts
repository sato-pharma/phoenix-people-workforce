import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

import {
  mondayInsideWeek,
  onTimePhoenixCrmPlans,
  type WeeklyPlanWeek,
} from "../src/lib/daily-deductions/no-weekly-plan-select.ts";
import { compactDeductionsHrId } from "../src/lib/deductions/candidate-key.ts";
import { LEGACY_PLANS_CLOSED, LEGACY_PLANS_CLOSED_MESSAGE } from "../src/lib/weekly-planning/legacy-closed.ts";
import { buildWeekKey, planDeductionGraceDeadlineForMonday } from "../src/lib/weekly-planning/week.ts";

/**
 * ONE PLAN STORE — Phoenix CRM (owner, 14 Nov 2026, decision DR-02: "Phoenix CRM").
 *
 * 1. The legacy Weekly Plans form refuses every write: each function that writes the legacy plan tables
 *    opens with `assertLegacyPlansOpen()`, and every mutating /api/weekly-plans route reaches the tables
 *    through one of those functions only.
 * 2. Its history stays readable: the workspace treats everyone as planning in Phoenix CRM, so each person
 *    sees every plan he filed, and nobody is offered a new one.
 * 3. The no-weekly-plan deduction finds a product manager's week in Phoenix CRM too — the legacy form is
 *    closed, so reading it alone would charge a day for a week that was planned.
 */

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist`);
  const rest = text.slice(start + declaration.length);
  const next = rest.search(/\n(export |async function |function )/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** The body of a function, from its opening brace — the signature's own braces skipped. */
function bodyAfterSignature(text: string, name: string): string {
  const body = functionBody(text, `export async function ${name}(`);
  const open = body.search(/\)(?::[^\n{]*(?:\{[^\n]*\}[^\n{]*)?)?\s*\{\n/);
  assert.ok(open >= 0, `${name} must have a body`);
  return body.slice(body.indexOf("{\n", open) + 2);
}

/** Every function in weekly-planning/service.ts that writes a legacy plan table. */
const LEGACY_WRITERS = [
  "addPlanComment",
  "createEmployeePlan",
  "updateEmployeePlan",
  "decideEmployeePlan",
  "reassignWeeklyPlanManager",
  "moveWeeklyPlanToPeriod",
  "acknowledgeEmployeePlan",
  "requestVisitDetails",
  "submitVisitDetails",
  "cancelEmployeePlan",
  "bulkDecideEmployeePlans",
  "requestEditEmployeePlan",
  "decideEditRequest",
] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name === "route.ts") out.push(next);
    }
  };
  walk(dir);
  return out.sort();
}

function testTheFormIsClosed(): void {
  assert.equal(LEGACY_PLANS_CLOSED, true, "DR-02: the legacy Weekly Plans form is closed");
  assert.match(LEGACY_PLANS_CLOSED_MESSAGE, /Phoenix CRM/, "a refused write says where plans are made now");

  const service = source("src/lib/weekly-planning/service.ts");
  for (const writer of LEGACY_WRITERS) {
    const body = bodyAfterSignature(service, writer);
    assert.match(body, /^\s*assertLegacyPlansOpen\(\);\n/, `${writer} refuses before it reads or writes anything`);
  }
  assert.match(
    functionBody(service, "function assertLegacyPlansOpen("),
    /if \(LEGACY_PLANS_CLOSED\) throw new WeeklyPlanRpcError\("plans_moved", LEGACY_PLANS_CLOSED_MESSAGE\)/,
    "the refusal is a typed plan error, so every route answers it with its own status and words",
  );

  // Every write into the legacy tables lives in service.ts — no other module may write them.
  const writeOutside = /from\("employee_plan_[a-z_]+"\)\s*\.(insert|update|upsert|delete)\(|rpc\("phx_weekly_plan_(?!s_drift_check)/;
  for (const dir of ["src", "app"]) {
    const walk = (relative: string) => {
      for (const entry of readdirSync(new URL(`../${relative}`, import.meta.url), { withFileTypes: true })) {
        const next = `${relative}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else if (/\.tsx?$/.test(entry.name) && next !== "src/lib/weekly-planning/service.ts") {
          assert.equal(writeOutside.test(source(next)), false, `${next} must not write a legacy plan table — only service.ts does, behind the closed form`);
        }
      }
    };
    walk(dir);
  }
}

function testEveryMutatingRouteGoesThroughAGuardedWriter(): void {
  const guarded = new Set<string>(LEGACY_WRITERS);
  const reads = new Set(["isWeeklyPlanRpcError"]);
  let mutating = 0;
  for (const file of routeFiles("app/api/weekly-plans")) {
    const text = source(file);
    const handler = text.search(/export (async function|const) (POST|PATCH|PUT|DELETE)\b/);
    if (handler < 0) continue;
    mutating += 1;
    const imported = [...text.matchAll(/import \{([^}]+)\} from "@\/lib\/weekly-planning\/service";/g)]
      .flatMap((match) => match[1].split(","))
      .map((name) => name.replace(/\btype\b/, "").trim())
      .filter(Boolean);
    const handlers = text.slice(handler);
    const called = imported.filter((name) => new RegExp(`\\b${name}\\(`).test(handlers));
    for (const name of called) {
      assert.ok(guarded.has(name) || reads.has(name), `${file} calls ${name}, which is not a guarded legacy writer`);
    }
    assert.ok(called.some((name) => guarded.has(name)), `${file} writes through a guarded legacy writer`);
    assert.match(text, /isWeeklyPlanRpcError\(error\)/, `${file} answers the closed form with its own status, never a bare 400`);
  }
  assert.ok(mutating >= 12, `every mutating /api/weekly-plans route is checked (found ${mutating})`);
}

function testHistoryStaysReadable(): void {
  const service = source("src/lib/weekly-planning/service.ts");
  assert.match(functionBody(service, "function plansInPhoenixCrm("), /return LEGACY_PLANS_CLOSED;/, "everyone plans in Phoenix CRM now");
  const workspace = functionBody(service, "export async function getEmployeePlansWorkspace(");
  assert.match(workspace, /movedToPhoenixCrm = employee \? plansInPhoenixCrm\(\) : false;[\s\S]*employee &&\s*!movedToPhoenixCrm &&/, "nobody is offered a new plan");
  assert.match(workspace, /loadOwnPlanRows\(employee\.hrId\)/, "each person sees every plan he filed here");

  const plansPage = source("app/employee-portals/plans/page.tsx");
  assert.match(plansPage, /if \(workspace\.plansInPhoenixCrm && !reviewsSomeoneElse\) \{[\s\S]*<PlansHistory/, "the portal page opens the read-only history");
}

function testTheDeductionReadsPhoenixCrm(): void {
  // Saturday 17 Oct 2026 starts a Phoenix CRM week; its Monday is 19 Oct.
  assert.equal(mondayInsideWeek("2026-10-17"), "2026-10-19");
  assert.equal(mondayInsideWeek("2026-10-19"), "2026-10-19", "a week that starts on a Monday is its own Monday");
  assert.equal(mondayInsideWeek("2026-10-20"), "2026-10-26");
  assert.equal(mondayInsideWeek("17/10/2026"), null);

  const weeks: WeeklyPlanWeek[] = ["2026-10-19", "2026-10-26"].map((mondayIso) => ({ mondayIso, weekKey: buildWeekKey(mondayIso) }));
  const deadline = (mondayIso: string) => planDeductionGraceDeadlineForMonday(mondayIso).getTime();
  const lastInstant = new Date(deadline("2026-10-19")).toISOString();
  const justLate = new Date(deadline("2026-10-19") + 1).toISOString();

  const onTime = onTimePhoenixCrmPlans({
    weeks,
    deadlineForMonday: deadline,
    rows: [
      { hrId: "B-0101", weekStart: "2026-10-17", submittedAt: "2026-10-18T12:10:55Z" }, // sent Sunday
      { hrId: "B-0102", weekStart: "2026-10-17", submittedAt: lastInstant }, // the last instant of Monday, Cairo
      { hrId: "B-0103", weekStart: "2026-10-17", submittedAt: justLate }, // one millisecond late
      { hrId: "B-0104", weekStart: "2026-10-17", submittedAt: null }, // never sent
      { hrId: "B-0105", weekStart: "2026-10-24", submittedAt: "2026-10-28T12:49:29Z" }, // sent Wednesday: late
      { hrId: "B-0106", weekStart: "2026-11-07", submittedAt: "2026-11-05T12:51:33Z" }, // outside these weeks
    ],
  });
  assert.deepEqual(
    onTime,
    [
      { weekKey: buildWeekKey("2026-10-19"), employeeCompactKey: compactDeductionsHrId("B-0101") },
      { weekKey: buildWeekKey("2026-10-19"), employeeCompactKey: compactDeductionsHrId("B-0102") },
    ],
    "only a week sent by its Monday's deadline counts, filed under that Monday's week",
  );

  const loader = source("src/lib/daily-deductions/no-weekly-plan.ts");
  const load = functionBody(loader, "async function loadOnTimePlans(");
  assert.match(load, /\.from\("employee_plan_headers"\)/, "the legacy history still counts");
  assert.match(load, /await loadPhoenixCrmWeekSubmissions\(weeks\)/, "and so does the week sent in Phoenix CRM");
  assert.match(load, /onTimePhoenixCrmPlans\(/);
  const crm = functionBody(loader, "async function loadPhoenixCrmWeekSubmissions(");
  // Through Phoenix CRM's one door for outside screens, never the table itself.
  assert.match(crm, /loadManagerPlansInRange\(\{ from: mondays\[0\], to: mondays\[mondays\.length - 1\], isTest: false \}\)/, "a test persona's week never excuses anyone");
  assert.equal(/\.from\("phoenix_crm_manager_plans"\)/.test(loader), false, "the deduction never reads the manager-plan table directly");
  const door = functionBody(source("src/lib/phoenix-crm/server/manager-plan-readers.ts"), "export async function loadManagerPlansInRange(");
  assert.match(door, /fetchAllRowsKeyset/, "every page is read — a plan cut off by a page limit would become a charge");
  assert.match(door, /\.gte\("week_start", addDaysIso\(input\.from, -6\)\)/, "a week that started up to six days before the first Monday still holds it");
  assert.match(crm, /catch \(error\) \{\s*throw new Error/, "an unreadable Phoenix CRM fails closed: the connector warns, nobody is charged");
}

export async function runWeeklyPlansOneStoreTests(): Promise<void> {
  testTheFormIsClosed();
  testEveryMutatingRouteGoesThroughAGuardedWriter();
  testHistoryStaysReadable();
  testTheDeductionReadsPhoenixCrm();
}
