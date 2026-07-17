import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

// Module completion (C1–C6): the write-side capture UIs — structured DV-Day feedback form, SFE/HR
// assessment forms, and the dev-action mark-improvement control — plus their wiring into the portal
// inbox and the case report. DB/UI-heavy, so this asserts the contracts and mount points.
export function runProbationCaptureUisTests() {
  // C1 — structured feedback form posts the full structured payload to the new endpoint.
  const form = src("src/components/probation/structured-feedback-form.tsx");
  assert.match(form, /\/api\/probation\/dv\/\$\{encodeURIComponent\(dvDayId\)\}\/feedback/, "posts to the DV-Day feedback endpoint");
  assert.match(form, /scores: numericScores/, "sends the config-driven scorecard");
  assert.match(form, /developmentActions/, "sends development actions");
  assert.match(form, /on_track|needs_improvement|serious_concern/, "recommendation options present");
  assert.match(form, /narrativeOk/, "narrative gate (strengths or development areas) enforced client-side");
  assert.match(form, /Number\.isInteger/, "score integer validation");

  // C1 page — server-loads config + gates via listFeedbackTasks + resolves the employee NAME.
  const page = src("app/employee-portals/probation/feedback/[dvDayId]/page.tsx");
  assert.match(page, /getProbationConfig\(\)/, "page loads config for dimensions + scale");
  assert.match(page, /listFeedbackTasks\(access\)/, "listFeedbackTasks is the authorization gate");
  assert.match(page, /resolveEmployeeDisplayName/, "resolves the employee name, not a code");
  assert.match(page, /config\.scorecardDimensions/, "passes dimensions to the form");

  // C2 — the manager inbox now deep-links to the structured form by dvDayId (not the legacy box).
  const inbox = src("src/components/employee-portal/probation-feedback-tasks-panel.tsx");
  assert.match(inbox, /\/employee-portals\/probation\/feedback\/\$\{encodeURIComponent\(t\.dvDayId\)\}/, "inbox links to the structured form");
  assert.doesNotMatch(inbox, /\?feedbackEmployeeHrId=/, "inbox no longer links to the legacy feedback box");

  // C3/C4 — assessment panel posts to the SFE + HR endpoints; HR disable messaging present.
  const assess = src("src/components/probation/probation-assessments-panel.tsx");
  assert.match(assess, /assessments\/\$\{kind\}/, "posts to the kind-specific assessment endpoint");
  assert.match(assess, /overrides: \{\}/, "sends empty overrides (no override reason required in v1)");
  assert.match(assess, /hrAssessmentEnabled \? null :/, "HR section disabled + explained when the flag is off");
  assert.match(assess, /canSeeConfidential/, "confidential note only for privileged viewers");

  // C5 — dev-action control PATCHes status + follow-up outcome.
  const dev = src("src/components/probation/development-actions-control.tsx");
  assert.match(dev, /\/api\/probation\/development-actions\/\$\{encodeURIComponent\(action\.id\)\}/, "PATCHes the dev-action endpoint");
  assert.match(dev, /method: "PATCH"/, "uses PATCH");
  assert.match(dev, /followUpOutcome: outcome\.trim\(\) \|\| null/, "records the follow-up outcome");
  assert.match(dev, /open|in_progress|done|cancelled/, "status options present");

  // C6 — report page widens the gate for the SFE Manager, loads config, mounts both panels.
  const report = src("app/(admin)/probation/cases/[caseId]/page.tsx");
  assert.match(report, /canSubmitSfeAssessment\(access\)/, "SFE Manager can reach the case report");
  assert.match(report, /getProbationConfig\(\)/, "report page loads config for the score scale");
  assert.match(report, /<ProbationAssessmentsPanel/, "assessments panel mounted");
  assert.match(report, /<DevelopmentActionsControl/, "dev-actions control mounted");
  assert.match(report, /canManageActions = canDecideProbation\(access\)/, "dev-action management gated to decision authority");
}
