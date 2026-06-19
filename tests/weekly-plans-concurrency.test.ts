import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function runWeeklyPlansConcurrencyTests() {
  const serviceSource = readFileSync(
    new URL("../src/lib/weekly-planning/service.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    serviceSource,
    /await rpcDecidePlan\(\{[\s\S]*?expectedRevision: plan\.revision[\s\S]*?\}\)/,
    "decideEmployeePlan must pass plan.revision as expectedRevision to rpcDecidePlan",
  );
  assert.match(
    serviceSource,
    /rpc\("phx_weekly_plan_decide"[\s\S]*?p_expected_revision: input\.expectedRevision/,
    "rpcDecidePlan must thread input.expectedRevision into p_expected_revision",
  );
  assert.match(
    serviceSource,
    /if \(message\.startsWith\("weekly_plan_revision_conflict"\)\)[\s\S]*?WeeklyPlanRpcError\(\s*"revision_conflict"/,
    "rethrowWeeklyPlanRpcError must map weekly_plan_revision_conflict to revision_conflict",
  );
  assert.match(
    serviceSource,
    /this\.status = code === "not_found" \? 404 : 409/,
    "WeeklyPlanRpcError must map revision_conflict and invalid_transition to HTTP 409",
  );
  assert.match(
    serviceSource,
    /await rpcAcknowledgePlan\(\{[\s\S]*?expectedRevision: plan\.revision[\s\S]*?\}\)/,
    "acknowledgeEmployeePlan must pass plan.revision into rpcAcknowledgePlan",
  );

  const replaceCallSites = (serviceSource.match(/await rpcReplacePlanItems\(\{/g) ?? []).length;
  assert.ok(
    replaceCallSites >= 3,
    `expected at least 3 rpcReplacePlanItems call sites (create-new, revise, editable-update); found ${replaceCallSites}`,
  );
  assert.match(
    serviceSource,
    /await rpcReplacePlanItems\(\{[\s\S]*?expectedRevision: plan\.revision[\s\S]*?submit: Boolean\(input\.submit\)[\s\S]*?\}\)/,
    "createEmployeePlan must pass plan.revision into rpcReplacePlanItems",
  );
  assert.match(
    serviceSource,
    /await rpcReplacePlanItems\(\{[\s\S]*?expectedRevision: revisionRow\.revision[\s\S]*?submit: Boolean\(input\.submit\)[\s\S]*?\}\)/,
    "closed-plan revisions must pass revisionRow.revision into rpcReplacePlanItems",
  );
  assert.match(
    serviceSource,
    /await rpcReplacePlanItems\(\{[\s\S]*?expectedRevision: existing\.revision[\s\S]*?submit: Boolean\(input\.submit\)[\s\S]*?\}\)/,
    "editable updates must pass existing.revision into rpcReplacePlanItems",
  );
  assert.doesNotMatch(
    serviceSource,
    /replacePlanItems[\s\S]{0,500}rpcSubmitPlan/,
    "service must not replace items before a separate submit RPC",
  );
}
