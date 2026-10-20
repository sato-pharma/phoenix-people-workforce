import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isManagerOptionalHrId, isMissingRequiredManager, normalizeGovernanceHrId } from "../src/lib/employees/hierarchy-governance.ts";
import { normalizeWorkforceHrId, workforceSeatsMatch } from "../src/lib/workforce/seat-lifecycle.ts";

// Regression suite for the "raw HR_ID comparison bypasses the canonical alias table" bug class
// (audit finding M13). src/lib/hr-id.ts documents a real legacy alias: uploads sometimes used
// "AAA" for the CEO's HR_ID, but the live employee master uses "AA". Several files normalized
// HR_IDs with a hand-rolled `.trim().toUpperCase()` instead of routing through
// canonicalHrIdKey/hrIdsMatch, so a record carrying the legacy "AAA" spelling would silently fail
// to match against the canonical "AA" — e.g. the CEO getting wrongly flagged as "missing manager".
// This file behaviorally verifies the two pure, directly-testable fixes; the four DB-backed
// service files (contracts, offers, probation, hiring-documents) are covered by source-text
// assertions further down, matching those files' existing test convention.

export function runHrIdAliasNormalizationTests() {
  // ── hierarchy-governance.ts ──
  assert.equal(normalizeGovernanceHrId("aaa"), "AA", "the legacy AAA alias resolves to the canonical AA");
  assert.equal(normalizeGovernanceHrId(" AAA "), "AA", "alias resolution is whitespace-insensitive");
  assert.equal(isManagerOptionalHrId("AAA"), true, "a record carrying the legacy AAA spelling is still recognized as manager-optional (was previously missed)");
  assert.equal(isManagerOptionalHrId("AA"), true, "the canonical form still matches directly");
  assert.equal(isManagerOptionalHrId("A-9"), false, "an unrelated HR_ID is never treated as manager-optional");
  assert.equal(
    isMissingRequiredManager({ hrId: "AAA", managerHrId: null }),
    false,
    "the CEO (stored/entered as AAA) is not wrongly flagged as missing a required manager",
  );
  assert.equal(
    isMissingRequiredManager({ hrId: "A-9", managerHrId: null }),
    true,
    "an ordinary employee with no manager is still correctly flagged",
  );

  // ── workforce/seat-lifecycle.ts ──
  assert.equal(normalizeWorkforceHrId("aaa"), "AA", "seat-lifecycle HR_ID normalization also resolves the legacy alias");
  assert.equal(normalizeWorkforceHrId(""), null, "an empty value still normalizes to null");
  assert.equal(
    workforceSeatsMatch(
      { areaName: "Nasr City", lineName: "Pedia", managerHrId: "AAA", positionTitle: "Medical Representative" },
      { areaName: "Nasr City", lineName: "Pedia", managerHrId: "AA", positionTitle: "Medical Representative" },
    ),
    true,
    "two seats whose managerHrId differs only by the legacy alias are still recognized as the same seat",
  );

  // ── contracts/service.ts, probation/service.ts, hiring-documents/service.ts ──
  // These are DB-backed and not directly unit-testable without a live/mocked Supabase client
  // (matching the existing test convention for these files — see contract-renewal-hardening.test.ts).
  // Source-text assertions confirm each now routes through the canonical helper instead of a
  // raw .toUpperCase()/.toLowerCase() comparison.
  const contractsSource = readFileSync("src/lib/contracts/service.ts", "utf8");
  assert.match(contractsSource, /function cleanHrId\(value: string \| null \| undefined\) \{\s*return canonicalHrIdForDisplay\(value\);/, "cleanHrId delegates to the canonical alias-aware helper");
  assert.doesNotMatch(contractsSource, /employee\.hrId\.toUpperCase\(\)/, "no remaining raw .toUpperCase() HR_ID comparison against the contract/request maps");

  const probationSource = readFileSync("src/lib/probation/service.ts", "utf8");
  assert.match(probationSource, /const employee = employees\.find\(\(row\) => normalizeHrId\(row\.hrId\) === employeeHrId\)/, "probation evaluation employee lookup uses the alias-aware normalizeHrId helper");

  const hiringDocumentsSource = readFileSync("src/lib/hiring-documents/service.ts", "utf8");
  assert.match(hiringDocumentsSource, /function normalizeHrId\(value: string \| null \| undefined\) \{\s*return canonicalHrIdForDisplay\(value\);/, "hiring-documents normalizeHrId delegates to the canonical alias-aware helper");
  assert.doesNotMatch(hiringDocumentsSource, /\.hr_id\.toUpperCase\(\)|\.employee_hr_id\.toUpperCase\(\)|manager_hr_id\.toUpperCase\(\)/, "no remaining raw .toUpperCase() HR_ID comparisons in the hiring-documents dashboard build");

  // ── M13 completion sweep: additional files an Opus re-audit found with the same alias-unaware
  //    pattern that the original 6-file fix missed. All only bite the single aliased id today
  //    (aaa→aa, the CEO), but the fix (route through hrIdsMatch / canonicalHrIdForDisplay) is
  //    identical to .toUpperCase() for every non-aliased id, so zero regression risk. Source-text
  //    guards, matching the DB-backed convention above. ──
  const approvalsHubSource = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  assert.match(approvalsHubSource, /employees\.find\(\(e\) => hrIdsMatch\(e\.hrId, hrId\)\)/, "approvals-hub decider lookup uses hrIdsMatch");
  assert.doesNotMatch(approvalsHubSource, /\(e\.hrId \?\? ""\)\.toUpperCase\(\) === hrId\.toUpperCase\(\)/, "no remaining raw decider comparison");

  const ceoCommandCenterSource = readFileSync("src/lib/ceo/command-center.ts", "utf8");
  // The candidates come from the whole active directory since 2026-10-20 (managerOnLeaveCandidates),
  // and the match against the leave map is still hrIdsMatch.
  assert.match(ceoCommandCenterSource, /hrIdsMatch\(hrId, candidate\.hrId\)/, "CEO command-center managers-on-leave match uses hrIdsMatch");

  const employeePhotoSource = readFileSync("src/lib/employees/employee-photo.ts", "utf8");
  assert.doesNotMatch(employeePhotoSource, /\.eq\("hr_id", hrId\.toUpperCase\(\)\)/, "employee-photo queries canonicalize the HR_ID filter");

  const homeSnapshotSource = readFileSync("src/lib/employee-portal/home-snapshot.ts", "utf8");
  assert.match(homeSnapshotSource, /import \{ canonicalHrIdForDisplay \} from "@\/lib\/hr-id"/, "home-snapshot imports the canonical helper");
  assert.doesNotMatch(homeSnapshotSource, /\.eq\("[a-z_]*hr_id", hrId\.toUpperCase\(\)\)/, "no bare .eq(...hr_id, hrId.toUpperCase()) own-data filter remains in home-snapshot");
  assert.doesNotMatch(homeSnapshotSource, /\$\{hrId\.toUpperCase\(\)\}/, "no bare ${hrId.toUpperCase()} interpolation remains in home-snapshot .or() filters");

  const portalServiceSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  assert.match(portalServiceSource, /const canonicalHrId = canonicalHrIdForDisplay\(hrId\) \?\? hrId\.toUpperCase\(\);/, "portal notifications compute a canonical HR_ID once");
  assert.match(portalServiceSource, /hrIdsMatch\(String\(recipient \?\? ""\)\.trim\(\), hrId\)/, "portal probation-recipient membership check uses hrIdsMatch");

  const scopeVisibilitySource = readFileSync("src/lib/auth/scope-visibility.ts", "utf8");
  assert.match(scopeVisibilitySource, /canonicalHrIdForDisplay\(row\.hr_id\)/, "scope-visibility name map canonicalizes both the key and the lookup");
}
