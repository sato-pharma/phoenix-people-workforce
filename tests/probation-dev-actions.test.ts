import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationDevActionsTests() {
  const repo = src("src/lib/probation/intelligence/dev-actions.ts");
  // Repo exposes create / list / update.
  assert.match(repo, /export async function createDevelopmentActions/);
  assert.match(repo, /export async function listDevelopmentActionsByCase/);
  assert.match(repo, /export async function updateDevelopmentAction/);
  // Empty titles are skipped, not inserted.
  assert.match(repo, /\.filter\(\(a\) => a && typeof a\.title === "string" && a\.title\.trim\(\)\.length > 0\)/,
    "actions with no title are skipped");
  // New rows start open.
  assert.match(repo, /status: "open"/, "new actions start open");

  // Create seam: feedback submit opens the actions (best-effort, non-blocking).
  const wf = src("src/lib/probation/intelligence/feedback-workflow.ts");
  assert.match(wf, /createDevelopmentActions\(\{[\s\S]*?\}\)\.catch\(\(\) => undefined\)/,
    "feedback submit opens development actions, non-blocking");
  assert.match(wf, /developmentActions\?: DevelopmentActionInput\[\]/, "SubmitFeedbackInput carries development actions");

  // Read seam: consolidated report bulk-loads and exposes them.
  const report = src("src/lib/probation/intelligence/consolidated-report.ts");
  assert.match(report, /listDevelopmentActionsByCase\(caseId\)\.catch\(\(\) => \[\]\)/, "report bulk-loads dev actions");
  assert.match(report, /developmentActions: developmentActions\.map/, "report exposes developmentActions (enriched with owner name)");

  // Report view renders a development-actions section.
  const view = src("src/components/probation/consolidated-report-view.tsx");
  assert.match(view, /Development actions/, "report view renders development actions");

  // Mark-improvement route exists + is registered at probation:read.
  const route = src("app/api/probation/development-actions/[id]/route.ts");
  assert.match(route, /updateDevelopmentAction\(/, "route updates an action");
  assert.match(route, /assertSameOriginMutation/, "route CSRF-guarded");
  const registry = src("src/lib/security/access-registry.ts");
  assert.match(registry, /\/api\/probation\/development-actions\/\*\*"[\s\S]*?action: "read"/, "dev-actions route gated probation:read");
}
