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

function oversightRolesBlock() {
  const match = coachingServiceSource.match(
    /const coachingOversightRoles = new Set<AccessContext\["role"\]>\(\[[\s\S]*?\]\);/,
  );
  assert.ok(match, "coaching oversight roles block must exist");
  return match[0];
}

export function runCoachingAccessScopeTests() {
  assert.doesNotMatch(
    lineRolesBlock(),
    /Training Manager/,
    "Training Manager must not inherit sales line-scoped coaching access",
  );

  // Training Manager now has org-wide coaching VIEW oversight (sees all reports, not just their
  // own) — it belongs to the coachingOversightRoles set, not the line-scoped path.
  assert.match(
    oversightRolesBlock(),
    /Training Manager/,
    "Training Manager must be part of the org-wide coaching oversight set",
  );

  // The oversight set must gate both the per-employee access check and the summary list filter,
  // so TM (and the company roles) bypass line/own-only scoping for read/list.
  assert.match(
    coachingServiceSource,
    /if \(access\.scope === "system" \|\| coachingOversightRoles\.has\(access\.role\)\) return true;/,
    "canAccessCoachingEmployee must grant org-wide oversight roles full coaching access",
  );

  assert.match(
    coachingServiceSource,
    /if \(access\.scope === "system" \|\| coachingOversightRoles\.has\(access\.role\)\) return rows;/,
    "coaching summaries must be returned unfiltered for org-wide oversight roles",
  );

  // Write authority must still be own-draft-scoped even for oversight roles: the lifecycle guard
  // restricts updates/submissions to the report's own coach (or Super Admin override).
  assert.match(
    coachingServiceSource,
    /A coach can only update and submit their own coaching drafts\./,
    "coaching draft updates must remain scoped to the owning coach",
  );
}
