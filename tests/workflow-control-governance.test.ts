import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";

import {
  buildWorkflowPublishDiffSummary,
  canonicalizeWorkflowPayload,
  getWorkflowPublishBlockers,
  hashWorkflowPayload,
  isNoopPublish,
  stripUnsafeWorkflowDraftPayload,
  validatePublishableWorkflowPayload,
  WORKFLOW_SAFE_OVERRIDE_KEYS,
  WORKFLOW_SAFE_PAYLOAD_KEYS,
} from "../src/lib/workflow-control/governance.ts";
import { getWorkflowSubflow } from "../src/lib/workflow-control/definitions.ts";

export function runWorkflowControlGovernanceTests() {
  const subflow = getWorkflowSubflow("leave", "vacation-request");
  assert.ok(subflow, "leave/vacation-request subflow is available");
  const validStepIds = subflow!.steps.map((s) => s.id);

  // Hash stability.
  const a1 = { overrides: { [validStepIds[0]]: { name: "Renamed" } }, orderIds: validStepIds };
  const a2 = { orderIds: validStepIds, overrides: { [validStepIds[0]]: { name: "Renamed" } } };
  assert.equal(hashWorkflowPayload(a1), hashWorkflowPayload(a2), "same content → same hash");
  assert.notEqual(hashWorkflowPayload(a1), hashWorkflowPayload({ overrides: { [validStepIds[0]]: { name: "Other" } }, orderIds: validStepIds }), "different safe content → different hash");

  // Allow-list strip.
  const dirty = {
    overrides: { [validStepIds[0]]: { name: "Ok", actor: "x", role: "x", statusProduced: "x", sql: "DROP", scriptHook: "x" } },
    orderIds: validStepIds,
    payroll: { salary: 1 },
    rls: "off",
  };
  const stripped = stripUnsafeWorkflowDraftPayload(dirty);
  assert.deepEqual(Object.keys(stripped).sort(), ["orderIds", "overrides"], "top-level allow-list strips payroll/rls");
  assert.deepEqual(Object.keys(stripped.overrides[validStepIds[0]]), ["name"], "per-step allow-list keeps only safe keys");

  // Forbidden per-step keys raise validation errors.
  for (const bad of ["actor", "role", "statusProduced", "routesTo", "sideEffects", "sql", "js", "scriptHook", "apiPath", "payroll", "salary", "rls", "policy", "accessMutation", "deactivateAccess", "vacancy", "employeeStatus", "employmentStatus"]) {
    const v = validatePublishableWorkflowPayload(
      { overrides: { [validStepIds[0]]: { name: "Ok", [bad]: "x" } }, orderIds: validStepIds },
      { validStepIds },
    );
    assert.equal(v.ok, false, `payload with per-step "${bad}" rejected`);
    if (v.ok === false) assert.ok(v.errors.some((e) => e.toLowerCase().includes(bad.toLowerCase())), `error mentions "${bad}"`);
  }

  // Forbidden top-level keys rejected.
  const vTop = validatePublishableWorkflowPayload({ overrides: {}, orderIds: [], payroll: { net: 1 }, rls: "off" }, { validStepIds });
  assert.equal(vTop.ok, false, "forbidden top-level keys rejected");

  // Unknown step ids blocked.
  assert.equal(validatePublishableWorkflowPayload({ overrides: { "ghost": { name: "x" } }, orderIds: validStepIds }, { validStepIds }).ok, false, "unknown step id rejected");
  assert.equal(validatePublishableWorkflowPayload({ overrides: {}, orderIds: [...validStepIds, "ghost"] }, { validStepIds }).ok, false, "orderIds unknown id rejected");

  // No-op publish detected.
  assert.equal(isNoopPublish({ overrides: { [validStepIds[0]]: { name: "x" } }, orderIds: validStepIds }, { overrides: { [validStepIds[0]]: { name: "x", actor: "stripped" } }, orderIds: validStepIds }), true, "no-op publish detected after strip");
  assert.equal(isNoopPublish({ overrides: { [validStepIds[0]]: { name: "x" } }, orderIds: validStepIds }, { overrides: { [validStepIds[0]]: { name: "y" } }, orderIds: validStepIds }), false, "different content not no-op");

  // Canonical form deterministic.
  assert.deepEqual(canonicalizeWorkflowPayload({ overrides: { a: { name: "x", notificationEnabled: true } }, orderIds: ["a"] }), canonicalizeWorkflowPayload({ orderIds: ["a"], overrides: { a: { notificationEnabled: true, name: "x" } } }), "canonical form deterministic");

  // Diff summary.
  const summary = buildWorkflowPublishDiffSummary(
    { overrides: {}, orderIds: subflow!.steps.map((s) => s.id) },
    { overrides: { [subflow!.steps[0].id]: { name: "Rename" }, [subflow!.steps[1].id]: { hidden: true } }, orderIds: [...subflow!.steps.map((s) => s.id)].reverse() },
    { steps: subflow!.steps, warningCount: 2 },
  );
  assert.ok(summary.changeCount >= 1, "diff counts field changes");
  assert.ok(summary.changedFields.some((c) => c.field === "Display name"), "diff includes Display name");
  assert.deepEqual(summary.hiddenStepIds, [subflow!.steps[1].id], "diff lists hidden step ids");
  assert.deepEqual(summary.hiddenStepNames, [subflow!.steps[1].name], "diff lists hidden step names");
  assert.equal(summary.orderChanged, true, "diff flags order change");
  assert.equal(summary.warningCount, 2, "diff surfaces external warning count");

  // Blockers.
  const blocked = getWorkflowPublishBlockers({
    validation: validatePublishableWorkflowPayload({ overrides: { x: { actor: "y" } }, orderIds: [] }, { validStepIds }),
    publishDisabled: true,
    validationWarnings: ["notif gap"],
  });
  assert.ok(blocked.some((b) => /Publish is disabled/i.test(b)), "blocker: publish disabled");
  assert.ok(blocked.some((b) => /Invalid payload/i.test(b)), "blocker: invalid payload");
  assert.ok(blocked.some((b) => /Unsafe field/i.test(b)), "blocker: unsafe field surfaced");
  assert.ok(blocked.some((b) => /Validation warning/i.test(b)), "blocker: validation warning");

  // Allow-list constants exclude unsafe fields.
  for (const k of ["actor", "role", "statusProduced", "routesTo", "sideEffects"]) {
    assert.equal((WORKFLOW_SAFE_OVERRIDE_KEYS as readonly string[]).includes(k), false, `safe override allow-list excludes "${k}"`);
  }
  assert.deepEqual([...WORKFLOW_SAFE_PAYLOAD_KEYS].sort(), ["orderIds", "overrides"]);

  // Module purity: no Supabase / fetch / DB queries / api/ refs.
  const govSrc = readFileSync(new URL("../src/lib/workflow-control/governance.ts", import.meta.url), "utf8");
  assert.equal(/@\/lib\/supabase|getSupabaseAdmin|getSupabaseUserClient/.test(govSrc), false, "governance must not import Supabase");
  assert.equal(/\bfetch\s*\(/.test(govSrc), false, "governance must not call fetch()");
  assert.equal(/\.from\s*\(\s*["'`]/.test(govSrc), false, "governance must not query a DB table");
  assert.match(govSrc, /from "node:crypto"/, "governance uses node:crypto for hashing");

  // Runtime workflow services do not import governance / persistence yet.
  for (const rel of [
    "src/lib/vacation/service.ts",
    "src/lib/outstation/service.ts",
    "src/lib/probation/service.ts",
    "src/lib/contracts/service.ts",
    "src/lib/offers/service.ts",
    "src/lib/resignations/service.ts",
    "src/lib/marketing-requests/service.ts",
    "src/lib/coaching/service.ts",
    "src/lib/payroll/service.ts",
  ]) {
    let src = "";
    try { src = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"); } catch { continue; }
    assert.equal(/@\/lib\/workflow-control\/governance/.test(src), false, `${rel} must not import workflow-control/governance`);
    assert.equal(/@\/lib\/workflow-control\/(drafts|versions|publish|services)\b/.test(src), false, `${rel} must not import workflow-control persistence`);
  }

  // At most one Phase 3 workflow_control migration draft on disk.
  const migrations = readdirSync(new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/", import.meta.url));
  const wc = migrations.filter((n) => /workflow_control_phase3/.test(n));
  assert.ok(wc.length <= 1, "at most one workflow_control_phase3 migration draft");
  for (const file of wc) {
    assert.match(file, /^\d{14}_workflow_control_phase3\.sql$/, `migration "${file}" follows naming convention`);
  }
}
