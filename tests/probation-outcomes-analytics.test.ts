import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  rollupOutcomes,
  rollupPredictiveness,
  type DecidedCaseInput,
  type PredictivenessInput,
} from "../src/lib/probation/intelligence/outcomes-analytics.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationOutcomesAnalyticsTests() {
  const items: DecidedCaseInput[] = [
    { decision: "pass", score: 8, lineName: "Alpha", managerHrId: "B-155", managerName: "Ahmed Sharaf", decisionAt: "2026-06-10T09:00:00Z" },
    { decision: "terminate", score: 4, lineName: "Alpha", managerHrId: "B-155", managerName: "Ahmed Sharaf", decisionAt: "2026-06-20T09:00:00Z" },
    { decision: "pass", score: 7, lineName: "Beta", managerHrId: "D-9", managerName: "Dina", decisionAt: "2026-07-01T09:00:00Z" },
    { decision: "pass", score: null, lineName: null, managerHrId: null, managerName: null, decisionAt: null },
  ];

  const roll = rollupOutcomes(items);

  // Overall: 4 decided, 3 pass, 1 terminate, pass rate 0.75.
  assert.equal(roll.overall.total, 4);
  assert.equal(roll.overall.passCount, 3);
  assert.equal(roll.overall.terminateCount, 1);
  assert.equal(roll.overall.passRate, 0.75);
  // Avg score ignores the null → mean of 8,4,7 = 6.33.
  assert.equal(roll.overall.avgScore, 6.33);
  assert.equal(roll.totalDecided, 4);

  // By line: Alpha has 2 (1 pass, 1 terminate = 0.5), sorted by total desc.
  const alpha = roll.byLine.find((g) => g.label === "Alpha");
  assert.ok(alpha, "Alpha line present");
  assert.equal(alpha!.total, 2);
  assert.equal(alpha!.passRate, 0.5);
  assert.equal(alpha!.avgScore, 6); // mean(8,4)
  // Null line bucketed under a label, not dropped.
  assert.ok(roll.byLine.some((g) => g.label === "Unassigned line"), "null line bucketed");

  // By manager uses the NAME as label (not the code) — memory rule.
  assert.ok(roll.byManager.some((g) => g.label === "Ahmed Sharaf"), "manager shown by name");
  assert.ok(roll.byManager.some((g) => g.label === "Unassigned manager"), "null manager bucketed");

  // By month: June has 2, July has 1, unknown has 1.
  const june = roll.byMonth.find((g) => g.key === "2026-06");
  assert.equal(june?.total, 2);
  assert.ok(roll.byMonth.some((g) => g.key === "unknown"), "null decision date bucketed as unknown");

  // Empty input → zeroed overall, no divide-by-zero.
  const empty = rollupOutcomes([]);
  assert.equal(empty.overall.total, 0);
  assert.equal(empty.overall.passRate, 0);
  assert.equal(empty.overall.avgScore, null);

  // Predictiveness: on_track that ended in pass = aligned; needs_improvement that ended in terminate = aligned.
  const preds: PredictivenessInput[] = [
    { recommendation: "on_track", caseDecision: "pass" },       // aligned
    { recommendation: "on_track", caseDecision: "terminate" },  // misaligned
    { recommendation: "needs_improvement", caseDecision: "terminate" }, // aligned
    { recommendation: "serious_concern", caseDecision: "terminate" },   // aligned
    { recommendation: "serious_concern", caseDecision: "pass" },        // misaligned
  ];
  const pred = rollupPredictiveness(preds);
  const onTrack = pred.find((p) => p.recommendation === "on_track")!;
  assert.equal(onTrack.total, 2);
  assert.equal(onTrack.endedInPass, 1);
  assert.equal(onTrack.aligned, 1);
  assert.equal(onTrack.alignmentRate, 0.5);
  const concern = pred.find((p) => p.recommendation === "serious_concern")!;
  assert.equal(concern.aligned, 1); // only the terminate one aligns
  // Always returns a row per recommendation, even with zero data.
  assert.equal(rollupPredictiveness([]).length, 3);

  // Wiring: route gated company-wide, page gated, service reads frozen snapshot score.
  const route = src("app/api/probation/analytics/route.ts");
  assert.match(route, /assertPermission\(access, "probation", "read"\)/, "analytics route gated at read");
  assert.match(route, /canReadAllProbation\(access\)/, "analytics route company-wide only");

  const page = src("app/(admin)/probation/analytics/page.tsx");
  assert.match(page, /canReadAllProbation\(access\)/, "analytics page company-wide only");
  assert.match(page, /<ProbationAnalyticsView data=\{data\}/, "page renders the view");

  const svc = src("src/lib/probation/intelligence/outcomes-analytics.ts");
  assert.match(svc, /decision_snapshot/, "score read from the frozen decision snapshot");
  assert.match(svc, /\.eq\("status", "decided"\)/, "only decided cases are aggregated");

  // Regression (2026-07-14): probation_cases exposes manager_hr_id but has NO manager_name column,
  // so selecting it threw `column probation_cases.manager_name does not exist` and the analytics page
  // failed to load for everyone. The service must resolve the manager's display name from
  // employees.full_name instead of selecting a phantom column.
  assert.doesNotMatch(svc, /manager_name/, "must not select the non-existent probation_cases.manager_name column");
  assert.match(svc, /\.from\("employees"\)/, "manager display name resolved from the employees table");
  assert.match(svc, /full_name/, "manager display name resolved via employees.full_name");
}
