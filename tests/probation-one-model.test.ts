import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ONE PROBATION MODEL (audit item REC-010, 14 Nov 2026).
//
// Two probation records used to live side by side: the probation CASE (`probation_cases`, decided on
// the case page through src/lib/probation/intelligence/decision.ts) and an older EVALUATION
// (`probation_evaluations`) with its own Start review / Manager feedback / Pass / Terminate door. The
// tracker read the evaluation, the case page read the case, and a best-effort mirror was all that kept
// them agreeing. REC-010 retired the evaluation door: the tracker reads the case, and nothing writes
// `probation_evaluations` any more. These assertions keep it that way.

function read(path: string) {
  return readFileSync(path, "utf8");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// The one place still allowed to READ the old table: the case backfill, which links old evaluation ids
// onto the cases it opens. Reading is history; writing would bring the second model back.
const READ_ONLY_READERS = new Set([join("src", "lib", "probation", "intelligence", "backfill.ts")]);

export function runProbationOneModelTests() {
  // 1 — nothing in the app writes the old table, and only the backfill reads it.
  const offenders: string[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("app")]) {
    const source = read(file);
    const chains = source.match(/\.from\(\s*["']probation_evaluations["']\s*\)[\s\S]{0,200}/g) ?? [];
    for (const chain of chains) {
      if (/\.(insert|update|upsert|delete)\(/.test(chain)) offenders.push(`${file}: writes probation_evaluations`);
      else if (!READ_ONLY_READERS.has(file)) offenders.push(`${file}: reads probation_evaluations`);
    }
  }
  assert.deepEqual(offenders, [], "the retired probation_evaluations model must not be written, or read outside the backfill");

  // 2 — the old doors are gone: the create route and the per-evaluation workflow route.
  assert.equal(existsSync("app/api/probation/route.ts"), false, "the legacy 'start review' route must stay deleted");
  assert.equal(existsSync("app/api/probation/[id]/workflow/route.ts"), false, "the legacy pass / terminate route must stay deleted");

  // 3 — the tracker's review state is read from the probation CASE.
  const service = read("src/lib/probation/service.ts");
  assert.match(
    service,
    /async function loadCaseWorkflowsByHrId\(\) \{\s*const \{ data, error \} = await getSupabaseAdmin\(\)\s*\.from\("probation_cases"\)/,
    "the tracker's workflow map is loaded from probation_cases",
  );
  assert.match(
    service,
    /const workflow = caseWorkflowsByHrId\.get\(normalizeHrId\(employee\.hrId\) \?\? ""\) \?\? null;/,
    "each tracker row takes its workflow from the case map",
  );
  for (const retired of [
    "createProbationEvaluation",
    "runProbationWorkflow",
    "mirrorLegacyDecisionToProbationCase",
    "ensureSystemProbationReview",
    "loadEvaluationsByHrId",
  ]) {
    assert.doesNotMatch(service, new RegExp(`\\b${retired}\\b`), `${retired} belongs to the retired evaluation model`);
  }

  // 4 — the two screens decide nothing; the admin tracker links to the case page.
  const tracker = read("src/components/probation/probation-tracker.tsx");
  const portal = read("src/components/employee-portal/employee-probation-dashboard.tsx");
  for (const [label, source] of [["admin tracker", tracker], ["portal dashboard", portal]] as const) {
    assert.doesNotMatch(source, /fetch\(\s*[`"']\/api\/probation/, `the ${label} calls no probation write route`);
    assert.doesNotMatch(source, /runWorkflow|openWorkflowAction|createEvaluation/, `the ${label} has no legacy action handler`);
  }
  assert.match(tracker, /href=\{`\/probation\/cases\/\$\{row\.workflow\.id\}`\}/, "the admin tracker opens the case");
}
