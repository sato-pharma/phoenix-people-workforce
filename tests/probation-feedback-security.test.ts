import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// checkFeedbackEligibility/getFeedbackForEmployee live in feedback-service.ts, which
// pulls in Supabase/notification dependencies that can't load under the test
// alias-loader without a mocking layer. Following the same source-assertion
// convention as probation-stabilization.test.ts, this test verifies the fix for two
// confirmed findings directly against the raw source: (1) assertPermission must be
// awaited in every probation feedback route, and (2) checkFeedbackEligibility must
// gate unauthorized viewers before it discloses probation existence/cycle data.
export function runProbationFeedbackSecurityTests() {
  const serviceSource = readFileSync("src/lib/probation/feedback-service.ts", "utf8");

  const gateIdx = serviceSource.indexOf("if (!canSeeAll && !roleResult.role)");
  const earlyReturnIdx = serviceSource.indexOf("if (!probationRecord || !roleResult.role)");
  assert.ok(gateIdx > -1, "checkFeedbackEligibility must gate unauthorized viewers");
  assert.ok(earlyReturnIdx > -1, "existing early-return branch must still exist");
  assert.ok(
    gateIdx < earlyReturnIdx,
    "authorization gate must run before the info-disclosing early-return branch",
  );
  assert.match(
    serviceSource,
    /Forbidden: you are not authorized to view probation feedback for this employee\./,
  );

  const routeFiles: Array<[string, string]> = [
    ["app/api/probation/feedback/route.ts", "update"],
    ["app/api/probation/feedback/dv-checkbox/route.ts", "update"],
    ["app/api/probation/feedback/[submissionId]/comment/route.ts", "read"],
    ["app/api/probation/feedback/employee/[hrId]/route.ts", "read"],
    ["app/api/probation/feedback/aggregate/route.ts", "read"],
  ];

  for (const [path, action] of routeFiles) {
    const src = readFileSync(path, "utf8");
    const re = new RegExp(`await assertPermission\\(access, "probation", "${action}"\\)`);
    assert.match(src, re, `${path} must await assertPermission`);
  }
}
