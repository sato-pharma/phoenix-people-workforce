import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text regression guard (these functions do live DB writes, matching this repo's idiom
// for pinning fixes to DB-touching services via source inspection).
//
// Probation feedback had NEVER recorded a submission in production — 0 rows ever — because three
// independent things each blocked it on their own:
//
//   1. POST /api/probation/feedback asserted probation:update. The Feedback button renders for 8
//      roles (DM, RM, NSM, TM, PM, GPM, Manager, Talent Acquisition) and every one of them holds
//      probation:["read"]; `update` is Super Admin-only, and Super Admin is not shown the button.
//   2. employee_hr_id / submitter_hr_id / commenter_hr_id are NOT NULL FKs to employees.hr_id
//      (stored uppercase), but the code wrote normalizeHrId(...) — lowercased — so every insert
//      would have died on 23503, exactly like the resignation submitted_by_hr_id bug.
//   3. resolveSubmitterRole did not recognise Talent Acquisition, and the DB CHECK constraint
//      pinned submitter_role to dm/nsm/tm/pm_gpm.

export function runProbationFeedbackRevivalTests() {
  const service = readFileSync("src/lib/probation/feedback-service.ts", "utf8");
  const route = readFileSync("app/api/probation/feedback/route.ts", "utf8");

  // (1) Coarse gate is probation:read; the service layer remains the fine boundary.
  assert.match(
    route,
    /assertPermission\(access, "probation", "read"\)/,
    "the feedback route must gate on probation:read — no role that sees the button holds probation:update",
  );
  assert.doesNotMatch(
    route,
    /assertPermission\(access, "probation", "update"\)/,
    "the feedback route must not re-assert probation:update, which no button-holding role has",
  );

  // (2) Every FK column is written from the STORED hr_id, never the lowercased caller id.
  assert.match(
    service,
    /async function resolveStoredHrId\([\s\S]{0,600}?\.from\("employees"\)[\s\S]{0,200}?\.ilike\("hr_id", normalized\)/,
    "resolveStoredHrId must look the caller up and return the employee master's own spelling",
  );
  assert.match(
    service,
    /employee_hr_id: storedEmployeeHrId,/,
    "employee_hr_id must be written from the resolved stored hr_id",
  );
  assert.match(
    service,
    /submitter_hr_id: storedSubmitterHrId,/,
    "submitter_hr_id must be written from the resolved stored hr_id",
  );
  assert.match(
    service,
    /commenter_hr_id: storedCommenterHrId,/,
    "commenter_hr_id must be written from the resolved stored hr_id",
  );
  assert.doesNotMatch(
    service,
    /(employee_hr_id|submitter_hr_id|commenter_hr_id): (callerHrId|normalizeHrId\()/,
    "no FK column may be written from the lowercased caller id — employees.hr_id is case-sensitive",
  );

  // (3) Talent Acquisition resolves to a submitter role, and the DB accepts it.
  assert.match(
    service,
    /export type FeedbackSubmitterRole = "dm" \| "nsm" \| "tm" \| "pm_gpm" \| "ta";/,
    "FeedbackSubmitterRole must include ta",
  );
  assert.match(
    service,
    /appRole === "Talent Acquisition"\) return \{ role: "ta", isOnceOnly: true \}/,
    "resolveSubmitterRole must map Talent Acquisition to the ta submitter role",
  );
  assert.match(
    service,
    /ta: "Talent Acquisition",/,
    "SUBMITTER_ROLE_LABELS must label ta so the HR notification names her role",
  );

  const migration = readFileSync(
    "supabase/migrations/20260805060000_probation_feedback_talent_acquisition_role.sql",
    "utf8",
  );
  assert.match(
    migration,
    /check \(submitter_role = any \(array\['dm'::text, 'nsm'::text, 'tm'::text, 'pm_gpm'::text, 'ta'::text\]\)\)/,
    "the widened CHECK must allow ta while keeping the original four roles",
  );

  // (4) A TA submission must be visible in the aggregate report, or the feedback is written but
  // invisible to the HR reader it exists for.
  const report = readFileSync("src/components/probation/aggregate-feedback-report.tsx", "utf8");
  assert.match(
    report,
    /<RoleCell role="ta" submissions=\{row\.submissions\} \/>/,
    "the aggregate report must render a TA column so her submissions are visible",
  );
}
