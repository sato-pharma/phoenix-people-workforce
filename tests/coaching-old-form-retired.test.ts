import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import { commitCoachingImport } from "../src/lib/coaching/import.ts";
import { CoachingOldFormRetiredError, refuseOldCoachingFormCreate } from "../src/lib/coaching/old-form-retired.ts";
import { createDraftCoachingReport } from "../src/lib/coaching/service.ts";
import { skillsSurveyOldFormRetiredMessage } from "../src/lib/coaching/skills-survey/vocabulary.ts";
import { stripComments } from "./support/comment-strip.ts";

// THE OLD COACHING FORM TAKES NO NEW REPORTS (owner, 2026-10-31): "this should replace the old coaching
// form". The Team Coaching Skills Survey replaced it. Both paths that created an old-form report — the
// form's own create and the workbook import — refuse first, before any read or write; the coaching
// routes answer 410 with the sentence. Everything that reads the 122 old reports, and a rep
// acknowledging one he already has, keeps working.

function read(path: string) {
  return stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));
}

/** The body of an exported async function, up to the next top-level export. */
function functionBody(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

/** The first statement inside a function body: what runs before anything else. */
function firstStatement(body: string) {
  const lines = body.split("\n");
  const signatureEnd = lines.findIndex((line) => /^(export |\))/.test(line) && line.trimEnd().endsWith("{"));
  assert.ok(signatureEnd >= 0, "could not find the end of the function's signature");
  const statement = lines.slice(signatureEnd + 1).find((line) => line.trim() !== "");
  return (statement ?? "").trim().replace(/;$/, "");
}

const trainingManager = {
  hrId: "T-1",
  loginId: "training.manager",
  role: "Training Manager",
} as unknown as AccessContext;

export async function runCoachingOldFormRetiredTests() {
  assert.throws(() => refuseOldCoachingFormCreate(), CoachingOldFormRetiredError);
  assert.throws(() => refuseOldCoachingFormCreate(), { message: skillsSurveyOldFormRetiredMessage });
  assert.equal(skillsSurveyOldFormRetiredMessage, "The coaching report form was replaced by the Team Coaching Skills Survey.");

  // Source first: the refusal is the first statement of each create path. Checked before the calls
  // below, so a removed guard fails here and never lets a test reach the database.
  const service = read("../src/lib/coaching/service.ts");
  const importer = read("../src/lib/coaching/import.ts");
  assert.equal(
    firstStatement(functionBody(service, "createDraftCoachingReport")),
    "refuseOldCoachingFormCreate()",
    "the old form's create must refuse before anything else",
  );
  assert.equal(
    firstStatement(functionBody(importer, "commitCoachingImport")),
    "refuseOldCoachingFormCreate()",
    "the coaching workbook import must refuse before it reads the file",
  );

  await assert.rejects(
    createDraftCoachingReport({} as never, trainingManager),
    CoachingOldFormRetiredError,
    "even the Training Manager, who wrote all 122 old reports, cannot start a new one",
  );
  await assert.rejects(commitCoachingImport(new ArrayBuffer(0), trainingManager), CoachingOldFormRetiredError);

  // The history keeps working: acknowledging an old report is not a create.
  assert.doesNotMatch(
    functionBody(service, "acknowledgeCoachingReport"),
    /refuseOldCoachingFormCreate/,
    "a rep still acknowledges the old report he already has",
  );
  assert.match(read("../app/api/coaching/reports/[id]/acknowledge/route.ts"), /acknowledgeCoachingReport\(/);
  const refusals = (service.match(/refuseOldCoachingFormCreate\(\)/g) ?? []).length;
  assert.equal(refusals, 1, "only the create refuses in the coaching service — reads, edits of old drafts and acknowledging do not");

  const routeUtils = read("../app/api/coaching/_lib/route-utils.ts");
  assert.match(
    routeUtils,
    /error instanceof CoachingOldFormRetiredError\)\s*\{\s*return NextResponse\.json\(\{ error: "retired", message: error\.message \}, \{ status: 410 \}\)/,
    "a stale screen reads the sentence with 410 Gone, never a server error",
  );

  // The old entry pages send people to the survey.
  for (const path of ["../app/(admin)/coaching/new/page.tsx", "../app/(admin)/coaching/import/page.tsx"]) {
    const page = read(path);
    assert.match(page, /redirect\(/, `${path} must redirect`);
    assert.match(page, /coaching-skills-survey|\/coaching\/skills-survey/, `${path} must lead to the survey`);
  }
  assert.match(
    read("../app/employee-portals/training-manager/create-coaching-report/page.tsx"),
    /redirect\([^)]*coaching-skills-survey/,
    "the Training Manager's Create Coaching Report page leads to the survey",
  );
}
