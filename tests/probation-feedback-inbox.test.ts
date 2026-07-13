import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

// Enhancement E2 — manager feedback inbox on the probation portal page. DB/UI-heavy, so this asserts
// the wiring: the page server-loads the caller's feedback tasks and renders the panel; the panel
// deep-links into the existing feedback form and is gated to feedback-submitting roles.
export function runProbationFeedbackInboxTests() {
  const page = src("app/employee-portals/probation/page.tsx");
  assert.match(page, /listFeedbackTasks\(access\)/, "page loads the caller's feedback tasks");
  assert.match(page, /if \(canSubmitManagerFeedback\)/, "tasks only loaded for feedback-submitting roles");
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
}
