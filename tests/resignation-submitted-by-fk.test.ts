import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text regression guard, matching this file's own idiom (resolveSubmittedByHrId is
// module-private and its callers do live DB writes, so it cannot be exercised directly here).
//
// employee_resignations.submitted_by_hr_id is a FOREIGN KEY to employees.hr_id, which is
// exact and case-sensitive. `actor` reaches the service already lowercased
// (resolveEmployeeIdentityId -> normalizeHrId -> canonicalHrIdKey), while hrIdsMatch is
// deliberately fuzzy (case, punctuation, and the aaa->aa alias). resolveSubmittedByHrId used
// `.some(...) ? actor : null`, so a fuzzy hit returned the RAW lowercased actor: submitting
// as A-16 wrote "a-16" against a stored "A-16" and Postgres rejected the insert with
// employee_resignations_submitted_by_hr_id_fkey. Every resignation confirm failed in
// production on 2026-08-05.

export function runResignationSubmittedByFkTests() {
  const service = readFileSync("src/lib/resignations/service.ts", "utf8");

  // (a) The matched employee's STORED hrId is what gets returned — never the raw actor.
  assert.match(
    service,
    /function resolveSubmittedByHrId\([\s\S]{0,400}?directory\.employees\.find\(\(employee\) => hrIdsMatch\(employee\.hrId, actor\)\)\?\.hrId \?\? null/,
    "resolveSubmittedByHrId must return the matched employee's stored hrId (FK-safe), not the raw actor",
  );
  assert.doesNotMatch(
    service,
    /directory\.employees\.some\(\(employee\) => hrIdsMatch\(employee\.hrId, actor\)\)\s*\?\s*actor\s*:\s*null/,
    "resolveSubmittedByHrId must not return the raw actor string on a fuzzy match — that breaks the submitted_by_hr_id FK",
  );

  // (b) A constraint/FK violation must no longer be misreported as a missing schema. The old
  // classifier returned true for ANY message merely naming one of these tables, so the real
  // FK error surfaced to the user as "Resignations schema is not ready" and pointed at a
  // migration that was never missing.
  for (const objectName of [
    "employee_resignations",
    "payroll_resignation_candidates",
    "position_vacancies",
    "phx_resign_employee_and_open_vacancy",
  ]) {
    assert.doesNotMatch(
      service,
      new RegExp(`isResignationsSchemaMissing[\\s\\S]{0,400}?message\\.includes\\("${objectName}"\\)`),
      `isResignationsSchemaMissing must not treat a bare mention of ${objectName} as a missing schema`,
    );
  }

  // (c) A genuinely absent table/column/function must still be detected, so the pages that
  // render "Resignations schema is not ready" keep working for the case they exist for.
  assert.match(
    service,
    /export function isResignationsSchemaMissing\(error: unknown\) \{\s*return isMissingSchemaMessage\(error\);\s*\}/,
    "isResignationsSchemaMissing must still delegate to isMissingSchemaMessage for real missing-object errors",
  );
  assert.match(
    service,
    /function isMissingSchemaMessage[\s\S]{0,400}?could not find the table/,
    "isMissingSchemaMessage must still match PostgREST's missing-table wording",
  );
}
