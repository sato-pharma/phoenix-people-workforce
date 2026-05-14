import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const coachingServiceSource = readFileSync(
  new URL("../src/lib/coaching/service.ts", import.meta.url),
  "utf8",
);

function lineRolesBlock() {
  const match = coachingServiceSource.match(/const lineRoles = new Set<AccessContext\["role"\]>\(\[[\s\S]*?\]\);/);
  assert.ok(match, "coaching line roles block must exist");
  return match[0];
}

export function runCoachingAccessScopeTests() {
  assert.doesNotMatch(
    lineRolesBlock(),
    /Training Manager/,
    "Training Manager must not inherit sales line-scoped coaching access",
  );

  assert.match(
    coachingServiceSource,
    /if \(access\.role === "Training Manager"\) \{\s*return Boolean\(coach && idsMatch\(currentHrId, coach\.hrId\)\);\s*\}/,
    "Training Manager should access employee coaching only when they are the report coach",
  );

  assert.match(
    coachingServiceSource,
    /if \(access\.role === "Training Manager"\) \{\s*const coachHrId = normalizeHrId\(access\.hrId\);[\s\S]*?return rows\.filter\(\(row\) => idsMatch\(coachHrId, row\.coachHrId\)\);[\s\S]*?\}/,
    "Training Manager report summaries should be filtered to reports they coached",
  );
}
