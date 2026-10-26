import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  classifyProbationRowZone,
  summarizeProbationRiskRows,
} from "../src/lib/lifecycle-risk/metrics.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 A PROBATION THAT ENDED WITH NO DECISION STAYS ON THE TRACKER, IN ITS OWN "OVERDUE DECISION" ZONE.
 *
 * `getProbationRows` ended with `.filter((row) => row.days_remaining > 0)`, so the day a probation
 * passed its end date the person fell off the tracker (and out of "Total in probation") while the
 * "Score a probationer" list, which reads `probation_cases`, kept listing them. The tracker now reads
 * `getProbationTrackerRows`: the same rows, plus every lapsed probation that is still employed, has
 * no pass/terminate decision and has an open case, each flagged `overdue_decision`.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. The zone helper classifying a flagged row by its day count again — an overdue row would read
 *     as "critical" and vanish into that chart segment.
 *  2. The summary counting an overdue row inside safe/warning/critical, or leaving it out of `total`.
 *  3. The tracker list losing its lapsed rows (the filter creeping back into the shared build), or
 *     the lapsed rows losing any of their gates (still employed, no final decision, open case).
 *  4. `getProbationRows` losing its "inside 90 days" rule — the reminder sweep, CEO/HR tiles and
 *     Needs You count must not move.
 *  5. The portal page, the workflow route or the dashboard no longer using the tracker list, or the
 *     dashboard dropping the zone, the sort-first rule or printing the HR id under a name again.
 *  6. The feedback inbox printing hours past a day, a raw ISO date or a raw role code again.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => stripComments(readFileSync(path.join(repoRoot, relative), "utf8"));

export function runProbationOverdueDecisionTrackerTests() {
  // 1 — the zone helper
  assert.equal(classifyProbationRowZone({ days_remaining: -6, overdue_decision: true }), "overdue");
  assert.equal(classifyProbationRowZone({ days_remaining: 0, overdue_decision: true }), "overdue");
  assert.equal(classifyProbationRowZone({ days_remaining: 0 }), "critical", "no flag, no overdue zone");
  assert.equal(classifyProbationRowZone({ days_remaining: 45 }), "warning");
  assert.equal(classifyProbationRowZone({ days_remaining: 70 }), "safe");

  // 2 — the summary: overdue is its own zone, still counted in the total
  const summary = summarizeProbationRiskRows([
    { daysRemaining: -6, employeeHrId: "A", overdueDecision: true },
    { daysRemaining: -20, employeeHrId: "B", overdueDecision: true },
    { daysRemaining: 10, employeeHrId: "C" },
    { daysRemaining: 45, employeeHrId: "D" },
    { daysRemaining: 70, employeeHrId: "E" },
    { daysRemaining: 5, employeeHrId: "F", workflowDecision: "pass" },
  ]);
  assert.equal(summary.overdue, 2, "both lapsed rows are in the overdue zone");
  assert.equal(summary.critical, 1, "an overdue row is never also critical");
  assert.equal(summary.warning, 1);
  assert.equal(summary.safe, 1);
  assert.equal(summary.total, 5, "overdue rows count in the total; a passed row does not");
  assert.equal(summary.overdue + summary.critical + summary.warning + summary.safe, summary.total);

  // 3 — the tracker list
  const service = read("src/lib/probation/service.ts");
  assert.match(
    service,
    /export\s+const\s+getProbationTrackerRows\s*=\s*cache\(\s*loadProbationTrackerRows\s*\)/,
    "getProbationTrackerRows must exist and be per-request cached",
  );
  const build = service.slice(service.indexOf("async function buildProbationRows"));
  assert.doesNotMatch(
    build.slice(0, build.indexOf("async function insertHistory")),
    /days_remaining\s*>\s*0/,
    "buildProbationRows is the shared unfiltered build; the 90-day filter lives in loadProbationRows only",
  );
  const tracker = service.slice(
    service.indexOf("async function loadProbationTrackerRows"),
    service.indexOf("async function buildProbationRows"),
  );
  assert.match(tracker, /overdue_decision:\s*true/, "lapsed rows are flagged overdue_decision");
  assert.match(tracker, /isProbationDecisionOutstanding\(row\)/, "a decided probation is not overdue");
  assert.match(tracker, /isActiveLifecycleStatus\(row\.employment_status\)/, "a resigned or terminated person is not overdue");
  assert.match(tracker, /openCaseHrIds\.has\(/, "only a lapsed probation with an OPEN case is overdue");
  const caseRead = service.slice(
    service.indexOf("async function loadOpenProbationCaseHrIds"),
    service.indexOf("async function loadProbationTrackerRows"),
  );
  assert.match(caseRead, /\.from\("probation_cases"\)/);
  assert.match(caseRead, /\.eq\("status",\s*"active"\)/);
  assert.match(caseRead, /\.is\("decision",\s*null\)/);

  // 4 — the shared list keeps its rule
  const shared = service.slice(
    service.indexOf("async function loadProbationRows"),
    service.indexOf("async function loadOpenProbationCaseHrIds"),
  );
  assert.match(shared, /row\.days_remaining\s*>\s*0/, "getProbationRows still hides a lapsed probation");
  for (const consumer of ["src/lib/platform/metrics.ts", "src/lib/lifecycle-risk/metrics.ts"]) {
    try {
      assert.doesNotMatch(read(consumer), /getProbationTrackerRows/, `${consumer} must keep the 90-day list`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // 5 — the surfaces
  assert.match(read("app/employee-portals/probation/page.tsx"), /getProbationTrackerRows\(access\)/);
  const route = read("app/api/probation/[id]/workflow/route.ts");
  assert.match(route, /trackerRows/, "the workflow route returns the tracker list for the portal dashboard");
  const dashboard = read("src/components/employee-portal/employee-probation-dashboard.tsx");
  assert.match(dashboard, /payload\.trackerRows \?\? payload\.rows/, "a workflow action refreshes the tracker list");
  assert.match(dashboard, /classifyProbationRowZone\(row\)/);
  assert.match(dashboard, /overdueDecision:\s*row\.overdue_decision/, "the tiles and chart count the overdue zone");
  assert.match(dashboard, /Boolean\(a\.overdue_decision\) !== Boolean\(b\.overdue_decision\)/, "overdue rows sort first");
  assert.match(dashboard, /<option value="overdue">Overdue decision<\/option>/);
  assert.doesNotMatch(dashboard, /[^=]\{(?:selectedAction\.)?row\.hr_id\}/, "names, never codes: no HR id printed in the tracker");

  // 6 — the feedback inbox
  const panel = read("src/components/employee-portal/probation-feedback-tasks-panel.tsx");
  assert.match(panel, /days? overdue|day\$\{days === 1 \? "" : "s"\} overdue/, "overdue past a day is said in days");
  assert.doesNotMatch(panel, /\$\{t\.dvDate\}/, "a Double-Visit date is formatted, never the raw ISO string");
  assert.doesNotMatch(panel, /as \$\{t\.evaluatorRole\}/, "the evaluator role is a title, never the code");
  assert.match(panel, /evaluatorRoleLabel\(t\.evaluatorRole\)/);
}
