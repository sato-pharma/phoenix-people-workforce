import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyRisk,
  exceptionFlags,
  RISK_LABEL,
  type CaseSignals,
} from "../src/lib/probation/intelligence/dashboard-classify.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

function signals(over: Partial<CaseSignals> = {}): CaseSignals {
  return {
    daysRemaining: 40, dvRequired: 6, dvFeedbackCompleted: 6, feedbackOverdue: 0,
    provisionalScore: 8, decisionReady: true, hasHighContradiction: false,
    hrSubmitted: true, sfeSubmitted: true, day30: true, day60: false, day75: false,
    contradictionsCount: 0, ...over,
  };
}

export function runProbationDashboardTests() {
  // Labels exist for every risk level (colour is never the only signal).
  assert.equal(RISK_LABEL.green, "On Track");
  assert.equal(RISK_LABEL.red, "Deadline Risk / Serious Concern");
  assert.equal(RISK_LABEL.grey, "Insufficient Data");

  // ── P8-T02 classification ──
  // Green: complete, strong score, no gaps, no contradictions.
  assert.equal(classifyRisk(signals()), "green");
  // Grey: no data at all.
  assert.equal(classifyRisk(signals({ provisionalScore: null, dvFeedbackCompleted: 0 })), "grey");
  // Red: overdue feedback.
  assert.equal(classifyRisk(signals({ feedbackOverdue: 2 })), "red");
  // Red: serious-concern score.
  assert.equal(classifyRisk(signals({ provisionalScore: 3 })), "red");
  // Red: high-severity contradiction.
  assert.equal(classifyRisk(signals({ hasHighContradiction: true })), "red");
  // Red: deadline crunch (few days left, DV gap).
  assert.equal(classifyRisk(signals({ daysRemaining: 10, dvFeedbackCompleted: 3 })), "red");
  // Amber: an open gap but not a red trigger (missing HR, mid score).
  assert.equal(classifyRisk(signals({ hrSubmitted: false, decisionReady: false, provisionalScore: 6 })), "amber");
  // Amber: on-pace score but a (non-high) contradiction present.
  assert.equal(classifyRisk(signals({ contradictionsCount: 1 })), "amber");

  // ── P8-T03 flags ──
  const f = exceptionFlags(signals({ hrSubmitted: false, sfeSubmitted: false, dvFeedbackCompleted: 4, decisionReady: false, provisionalScore: 6 }));
  assert.equal(f.hrPending, true);
  assert.equal(f.sfePending, true);
  assert.equal(f.missingDvDays, true, "4 < 6 required");
  assert.equal(f.pendingFeedback, true);
  assert.equal(f.readyForDecision, false);
  assert.equal(f.day30Reached, true);
  assert.equal(f.day60Reached, false);

  const green = exceptionFlags(signals());
  assert.equal(green.onTrack, true);
  assert.equal(green.readyForDecision, true);
  assert.equal(green.hrPending, false);

  const overdue = exceptionFlags(signals({ feedbackOverdue: 1 }));
  assert.equal(overdue.overdueFeedback, true);
  assert.equal(overdue.atRisk, true);

  // ── Dashboard service guarantees (source assertions) ──
  const svc = src("src/lib/probation/intelligence/dashboard.ts");
  // Performance: bulk load, not per-case round trips.
  assert.match(svc, /PERFORMANCE: loads ALL active cases/i, "documented bulk-load approach");
  assert.match(svc, /\.in\("case_id", caseIds\)/, "children fetched in bulk by case_id IN (...)");
  assert.match(svc, /Promise\.all\(\[/, "bulk queries run together");
  // Reuses the pure engines (no re-implementation).
  assert.match(svc, /computeProbationScore\(/, "reuses the scoring engine");
  assert.match(svc, /detectContradictions\(/, "reuses the contradiction engine");
  // Exception-first ordering.
  assert.match(svc, /red: 0, amber: 1, grey: 2, green: 3/, "exception-first sort order");
  // Only active cases.
  assert.match(svc, /\.eq\("status", "active"\)/, "dashboard is active cases only");

  // ── Legacy-decision desync guard (defense-in-depth) ──
  // Still active-cases-only above, but now the dashboard ALSO drops any case whose employee was
  // resolved via the LEGACY workflow yet never mirrored into probation_cases, and fails open.
  assert.match(svc, /filterResolvedProbationCases\(/, "dashboard cross-checks + drops legacy-resolved cases");
  assert.match(svc, /legacy-decision desync/i, "dashboard documents the legacy-decision desync root cause");
  assert.match(svc, /Fails OPEN/i, "dashboard cross-check fails open (never hides data on a monitoring error)");

  // The shared cross-check (cases.ts) verifies BOTH the legacy probation status AND the employee
  // employment status, and fails open on a lookup error.
  const casesSrc = src("src/lib/probation/intelligence/cases.ts");
  assert.match(casesSrc, /export async function filterResolvedProbationCases/, "shared resolved-case filter is exported");
  assert.match(casesSrc, /\.from\("employee_probation"\)/, "cross-check reads employee_probation.status");
  assert.match(casesSrc, /status === "passed" \|\| status === "terminated"/, "legacy pass/terminate detected via employee_probation");
  assert.match(casesSrc, /isTerminalEmploymentStatus\(/, "terminal employment_status also excludes a case");
  assert.match(casesSrc, /if \(empRes\.error \|\| probRes\.error\) return rows;/, "cross-check fails open on a lookup error");

  // Route restricted to company-wide readers.
  const route = src("app/api/probation/dashboard/route.ts");
  assert.match(route, /canReadAllProbation\(access\)/, "dashboard route restricted to company-wide probation readers");

  // UI shows text labels + links to the report, filters by flags.
  const view = src("src/components/probation/probation-dashboard-view.tsx");
  assert.match(view, /row\.riskLabel/, "risk shown as text label (accessibility), not colour-only");
  assert.match(view, /\/probation\/cases\/\$\{row\.caseId\}/, "each row links to the live report");
  assert.match(view, /row\.flags\[f as keyof typeof row\.flags\]/, "filters operate on exception flags");
}
