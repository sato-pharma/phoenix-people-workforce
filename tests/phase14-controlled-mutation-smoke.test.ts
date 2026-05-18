import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhase14ControlledMutationSmokeTests() {
  const employeeRoute = readFileSync("app/api/employees/route.ts", "utf8");
  const offerApproveRoute = readFileSync("app/api/offers/[offerRef]/approve/route.ts", "utf8");
  const resignationRoute = readFileSync("app/api/employees/[hrId]/resign/route.ts", "utf8");
  const outstationSubmitRoute = readFileSync("app/api/outstation/submit/route.ts", "utf8");
  const smokeScript = readFileSync("scripts/phase14-controlled-mutation-smoke.mjs", "utf8");

  assert.match(employeeRoute, /message\.includes\("required"\)/);
  assert.match(employeeRoute, /status: 400/);
  assert.match(employeeRoute, /message\.includes\("was not found"\)/);
  assert.match(employeeRoute, /status: 404/);

  assert.match(offerApproveRoute, /offer not found/);
  assert.match(offerApproveRoute, /status: 404/);
  assert.match(offerApproveRoute, /only accepted offers/);
  assert.match(offerApproveRoute, /status: 400/);

  assert.match(resignationRoute, /not found/);
  assert.match(resignationRoute, /status: 404/);
  assert.match(resignationRoute, /cannot be before/);

  assert.match(outstationSubmitRoute, /function outstationSubmitStatus/);
  assert.match(outstationSubmitRoute, /message\.includes\("required"\)/);
  assert.match(outstationSubmitRoute, /\{ status \}/);

  assert.match(smokeScript, /PHASE14_NONEXISTENT_SAFE_FIXTURE/);
  assert.match(smokeScript, /00000000-0000-0000-0000-000000000000/);
  assert.match(smokeScript, /manual employee add drawer validation/);
  assert.match(smokeScript, /employee bulk upload invalid file interaction/);
  assert.match(smokeScript, /Command Center post-smoke reachable/);
  assert.match(smokeScript, /Audit Logs post-smoke reachable/);
  assert.doesNotMatch(smokeScript, /\/delete`,/);
}
