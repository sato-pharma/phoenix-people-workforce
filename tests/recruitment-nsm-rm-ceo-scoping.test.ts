import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hiringManagerInterviewType } from "../src/lib/recruitment/access.ts";
import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import { interviewTypes } from "../src/lib/recruitment/types.ts";
import { interviewScorecardCriteria } from "../src/lib/recruitment/scorecards.ts";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

export function runRecruitmentNsmRmCeoScopingTests() {
  // --- interviewType selection by caller role (never the request body) -------------
  assert.equal(hiringManagerInterviewType("District Manager"), "hiring_manager", "District Manager keeps the pre-existing type");
  assert.equal(hiringManagerInterviewType("Regional Manager"), "rm_interview");
  assert.equal(hiringManagerInterviewType("National Sales Manager"), "nsm_interview");
  assert.equal(hiringManagerInterviewType("CEO"), "ceo_interview");
  // Any other role falls back to the District Manager type (e.g. Product Manager, who
  // also holds hiring_interviews) rather than throwing or returning something unmapped.
  assert.equal(hiringManagerInterviewType("Product Manager"), "hiring_manager");

  // --- interviewTypes union carries all four hiring-manager-family types -----------
  for (const type of ["hiring_manager", "rm_interview", "nsm_interview", "ceo_interview"]) {
    assert.ok((interviewTypes as readonly string[]).includes(type), `interviewTypes missing ${type}`);
  }

  // --- The 3 new types deliberately get no numeric scorecard (free-text notes only) -
  for (const type of ["rm_interview", "nsm_interview", "ceo_interview"] as const) {
    assert.deepEqual(interviewScorecardCriteria[type], [], `${type} must have no scorecard criteria`);
  }

  // --- CEO permission grant ----------------------------------------------------------
  assert.deepEqual(
    permissionMatrix.CEO.hiring_interviews,
    ["read", "update"],
    "CEO must have scoped hiring_interviews access (not hard-boundary-capped, unlike recruitment/candidates)",
  );
  // CEO still has no broad recruitment/candidates PII access — the hard boundary strips
  // the raw matrix grant of those two resources for every role except Super Admin/TA.
  assert.equal(permissionMatrix.CEO.recruitment, undefined);
  assert.equal(permissionMatrix.CEO.candidates, undefined);

  // --- access.ts: RM gets HIERARCHY scope, NSM gets LINE scope, DM/others get null --
  const accessSource = read("src/lib/recruitment/access.ts");
  assert.match(accessSource, /orgScopedHiringManagerRoles[\s\S]*=[\s\S]*\[[\s\S]*"Regional Manager"[\s\S]*"National Sales Manager"[\s\S]*\]/);
  assert.match(accessSource, /isWithinManagerHierarchy\(\{/, "Regional Manager scope must reuse isWithinManagerHierarchy");
  assert.match(accessSource, /sameWorkforceLine\(viewer, employee\)/, "National Sales Manager scope must reuse sameWorkforceLine");
  assert.match(
    accessSource,
    /if \(access\.role === "Regional Manager"\)/,
    "Regional Manager must be branched to the hierarchy walk, not the line check",
  );
  // Fails closed: an unresolvable viewer line -> no NSM allow-list is built (empty set).
  assert.match(accessSource, /viewer\.lineId != null \|\| viewer\.lineName/);

  // canSeeRequisition/filterRequisitionsForAccess/canSeeApplication/assertCanSeeRequisition
  // all accept the resolved scope set and check membership only when it's present — District
  // Manager (no scope set passed) keeps working on the exact hrIdsMatch check alone.
  assert.match(accessSource, /export function canSeeRequisition\(\s*access: AccessContext,\s*requisition: Requisition,\s*scopeHrIds\?/);
  assert.match(accessSource, /if \(!scopeHrIds\) return false;/);

  // Callers resolve the scope set ONCE per request, not per row.
  const requisitionsSource = read("src/lib/recruitment/requisitions.ts");
  assert.match(requisitionsSource, /resolveHiringManagerScopeHrIds\(access\)/);
  assert.match(requisitionsSource, /filterRequisitionsForAccess\(access, requisitions, scopeHrIds\)/);
  assert.match(requisitionsSource, /assertCanSeeRequisition\(access, requisition, scopeHrIds\)/);

  // getApplication/hiring-manager-view.ts both scope through getRequisition — no separate
  // scope-threading needed there, confirmed by absence of a second resolver call.
  const applicationsSource = read("src/lib/recruitment/applications.ts");
  assert.doesNotMatch(applicationsSource, /resolveHiringManagerScopeHrIds/, "getApplication scopes via getRequisition, not a second resolver call");

  // --- Interview-creation + outcome routes derive type from the caller's role -------
  const createInterviewRoute = read("app/api/recruitment/hiring-manager/applications/[id]/interviews/route.ts");
  assert.match(createInterviewRoute, /interviewType: hiringManagerInterviewType\(access\.role\)/);
  assert.doesNotMatch(createInterviewRoute, /interviewType: "hiring_manager",/, "must not hardcode hiring_manager anymore");

  const outcomeRoute = read("app/api/recruitment/hiring-manager/interviews/[id]/route.ts");
  assert.match(outcomeRoute, /existing\.interviewType !== hiringManagerInterviewType\(access\.role\)/);

  // --- CEO entry point (thin admin-shell wrapper around the same portal component) --
  //
  // Owner decision 2026-08-24: Super Admin may open this screen too, so the gate is a named
  // predicate instead of a hardcoded role string. It stays a PERSONAL inbox either way — the page
  // scopes by access.hrId and listApplications() scopes by hiring-manager ownership, so widening
  // who may OPEN it never widens what anyone SEES.
  const ceoPage = read("app/(admin)/recruitment/candidates/page.tsx");
  assert.match(ceoPage, /RecruitmentCandidatesPortal/);
  assert.match(ceoPage, /canOpenPersonalCandidateInbox\(access\)/);
  assert.match(ceoPage, /canAccess\(access, "hiring_interviews", "read"\)/);

  // --- Migrations ---------------------------------------------------------------------
  const phase1Migration = read("supabase/migrations/20260724130000_ats_replatform_phase1.sql");
  assert.match(
    phase1Migration,
    /'app_hire'[\s\S]*?'\{from\}'/,
    "Phase 1 migration must widen app_hire's from array via jsonb_set",
  );
  assert.match(phase1Migration, /"offer_initiated"/);

  const phase2Migration = read("supabase/migrations/20260724140000_ats_nsm_rm_ceo_interview_types.sql");
  assert.match(
    phase2Migration,
    /check \(interview_type = any \(array\['phone', 'hr', 'hiring_manager', 'cv', 'rm_interview', 'nsm_interview', 'ceo_interview'\]\)\)/,
  );
  assert.match(phase2Migration, /alter table public\.ats_interviews/);
  assert.match(phase2Migration, /notify pgrst, 'reload schema'/);
}
