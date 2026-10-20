import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

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

/** Slice out a named function's body: from its declaration up to (not including) the next marker. */
function functionBody(startMarker: string, endMarker: string) {
  const start = coachingServiceSource.indexOf(startMarker);
  assert.ok(start >= 0, `could not locate ${JSON.stringify(startMarker)} in coaching service.ts`);
  const end = coachingServiceSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `could not locate the end of ${JSON.stringify(startMarker)}`);
  return coachingServiceSource.slice(start, end);
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

  // SFE Manager (owner, 2026-10-20): his seat is on the Head Office line, so the line-scoped branch
  // ("same line AND same department") matched no field rep at all — 0 of 122 reports. He reads
  // coaching company-wide, like the other oversight seats. Read through stripComments so a comment
  // naming him can never satisfy (or break) the check.
  const strippedService = stripComments(coachingServiceSource);
  const strippedOversight = strippedService.match(
    /const coachingOversightRoles = new Set<AccessContext\["role"\]>\(\[[\s\S]*?\]\);/,
  )?.[0];
  const strippedLineRoles = strippedService.match(/const lineRoles = new Set<AccessContext\["role"\]>\(\[[\s\S]*?\]\);/)?.[0];
  assert.ok(strippedOversight && strippedLineRoles, "both coaching role blocks must exist in code");
  assert.match(strippedOversight, /"SFE Manager"/, "SFE Manager must be part of the org-wide coaching oversight set");
  assert.doesNotMatch(strippedLineRoles, /"SFE Manager"/, "SFE Manager must not sit on the line-scoped coaching branch");

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

  // Item C: getCoachingReportById, getCoachingReportsByIds, and filterSummariesForAccess must
  // resolve the employee directory with includeInactive: true — a resigned/terminated Medical
  // Rep's own historical coaching report(s) must still resolve here. The real access-scope gate
  // (assertCanAccessEmployee / canAccessCoachingEmployee) operates correctly on the employee row
  // regardless of status, so this can only widen visibility of already-existing records, never
  // weaken the access check itself.
  const getCoachingReportByIdBody = functionBody(
    "export async function getCoachingReportById(",
    "\nexport async function getCoachingReportsByIds(",
  );
  const getCoachingReportsByIdsBody = functionBody(
    "export async function getCoachingReportsByIds(",
    "\nasync function filterSummariesForAccess(",
  );
  const filterSummariesForAccessBody = functionBody(
    "async function filterSummariesForAccess(",
    "\nexport async function getCoachingReports(",
  );

  const includeInactiveCall = /getEmployeeDirectoryRows\(\{\s*includeInactive:\s*true\s*\}\)/;
  const bareCall = /getEmployeeDirectoryRows\(\)/;

  for (const [name, body] of [
    ["getCoachingReportById", getCoachingReportByIdBody],
    ["getCoachingReportsByIds", getCoachingReportsByIdsBody],
    ["filterSummariesForAccess", filterSummariesForAccessBody],
  ] as const) {
    assert.match(
      body,
      includeInactiveCall,
      `${name} must call getEmployeeDirectoryRows({ includeInactive: true })`,
    );
    assert.doesNotMatch(
      body,
      bareCall,
      `${name} must no longer call the bare no-args getEmployeeDirectoryRows()`,
    );
  }
}
