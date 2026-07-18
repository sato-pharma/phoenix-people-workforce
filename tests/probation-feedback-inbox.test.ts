import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

// Enhancement E2 — manager feedback inbox on the probation portal page. DB/UI-heavy, so this asserts
// the wiring: the page server-loads the caller's feedback tasks and renders the panel; the panel
// deep-links into the existing feedback form and is gated to feedback-submitting roles.
export function runProbationFeedbackInboxTests() {
  const page = src("app/employee-portals/probation/page.tsx");
  assert.match(page, /listFeedbackTasks\(access\)/, "page loads the caller's feedback tasks");
  assert.match(page, /if \(hasTracker && canSubmitManagerFeedback\)/, "tasks only loaded for feedback-submitting roles with a scoped team");
  assert.match(page, /<ProbationFeedbackTasksPanel tasks=\{feedbackTasks\}/, "panel is rendered");
  // Employee NAME (not code) is resolved for display (memory rule).
  assert.match(page, /nameByHrId\.get\(t\.employeeHrId\.toLowerCase\(\)\)/, "task shows the employee name");
  // Best-effort: a missing intelligence schema must not break the legacy tracker.
  assert.match(page, /catch \{[\s\S]*feedbackTasks = \[\];[\s\S]*\}/, "task load is best-effort");

  const panel = src("src/components/employee-portal/probation-feedback-tasks-panel.tsx");
  assert.match(panel, /My feedback tasks/, "panel titled");
  assert.match(panel, /\/employee-portals\/probation\/feedback\/\$\{encodeURIComponent\(t\.dvDayId\)\}/, "deep-links into the structured feedback form by dvDayId");
  assert.match(panel, /overdue/, "SLA state surfaced");
  assert.match(panel, /return null/, "panel hides when there are no tasks");

  // Owner UX rule (2026-07-17): group the inbox BY PROBATIONER — one card per rep, with the numbered
  // list of that rep's still-missing DV-Day feedbacks underneath — NOT one flat row per DV-Day repeating
  // the same 2 names 20+ times.
  assert.match(panel, /function groupByProbationer/, "tasks are grouped by probationer");
  // TRAINING-MANAGER OPTIONAL (owner rule 2026-07-18): a TM-evaluated feedback task shows as "Optional"
  // and is excluded from the overdue count / worst-SLA — no SLA pressure on optional TM feedback.
  assert.match(panel, /OPTIONAL_EVALUATOR_ROLES = new Set\(\["tm"\]\)/, "TM is the optional evaluator role");
  assert.match(panel, /Feedback \{index \+ 1\} — \{optional \? "optional" : "missing"\}/, "optional TM tasks are labelled optional, not missing");
  assert.match(panel, /required\.filter\(\(t\) => t\.slaState === "overdue"\)/, "overdue count excludes optional TM tasks");
  assert.match(panel, /Feedback \{index \+ 1\} — \{optional \? "optional" : "missing"\}/, "each rep's pending feedbacks are numbered; required labelled missing, optional labelled optional");
  assert.doesNotMatch(panel, /sorted\.map/, "no flat per-DV-Day row list");

  // Probation Analytics audience (owner rule 2026-07-17): NSM + PM/GPM (portal) + SFE/admin/CEO (admin).
  const service = src("src/lib/probation/service.ts");
  assert.match(service, /export function canViewProbationAnalytics/, "dedicated analytics-audience helper exists");
  for (const role of ["National Sales Manager", "Product Manager", "Group Product Manager", "SFE Manager", "CEO", "Super Admin"]) {
    assert.ok(service.includes(`"${role}"`), `${role} is an analytics viewer`);
  }
  // Admin route + page gate on the analytics helper (not the narrower canReadAllProbation).
  assert.match(src("app/(admin)/probation/analytics/page.tsx"), /canViewProbationAnalytics\(access\)/, "admin analytics page gates on the analytics helper");
  assert.match(src("app/api/probation/analytics/route.ts"), /canViewProbationAnalytics\(access\)/, "admin analytics route gates on the analytics helper");
  // Portal surfaces the analytics for the portal-mode manager tiers (NSM/PM/GPM).
  assert.match(page, /const showAnalytics = canViewProbationAnalytics\(access\)/, "portal computes analytics visibility");
  assert.match(page, /showAnalytics && analyticsData && \(/, "portal renders the analytics section for eligible roles");
  assert.match(page, /<ProbationAnalyticsView data=\{analyticsData\}/, "portal renders the shared analytics view");
}
