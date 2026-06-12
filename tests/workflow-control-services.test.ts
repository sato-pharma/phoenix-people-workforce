import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  WORKFLOW_CONTROL_DISABLED_MESSAGE,
  WORKFLOW_CONTROL_PERSISTENCE_ENABLED,
  WORKFLOW_CONTROL_PUBLISH_ENABLED,
  WORKFLOW_CONTROL_ROLLBACK_ENABLED,
} from "../src/lib/workflow-control/feature-flags.ts";
import {
  discardWorkflowDraft,
  loadWorkflowDraft,
  saveWorkflowDraft,
} from "../src/lib/workflow-control/services/drafts.ts";
import {
  compareWorkflowVersions,
  getWorkflowVersion,
  listWorkflowVersions,
} from "../src/lib/workflow-control/services/versions.ts";
import {
  publishWorkflowDraft,
  rollbackWorkflowVersion,
} from "../src/lib/workflow-control/services/publish.ts";
import {
  buildWorkflowControlAuditPayload,
  writeWorkflowControlAudit,
} from "../src/lib/workflow-control/services/audit.ts";
import { getWorkflowSubflow } from "../src/lib/workflow-control/definitions.ts";

export function runWorkflowControlServicesTests() {
  const superAdmin = { hrId: "B-10", role: "Super Admin" } as const;
  const talentAcquisition = { hrId: "A-16", role: "Talent Acquisition" } as const;
  const employee = { hrId: "C-1", role: "Employee" } as const;
  const subflow = getWorkflowSubflow("leave", "vacation-request");
  assert.ok(subflow);
  const validStepIds = subflow!.steps.map((s) => s.id);
  const cleanPayload = { overrides: { [validStepIds[0]]: { name: "Renamed" } }, orderIds: validStepIds };

  assert.equal(WORKFLOW_CONTROL_PERSISTENCE_ENABLED, false, "persistence flag defaults false");
  assert.equal(WORKFLOW_CONTROL_PUBLISH_ENABLED, false, "publish flag defaults false");
  assert.equal(WORKFLOW_CONTROL_ROLLBACK_ENABLED, false, "rollback flag defaults false");

  return (async () => {
    const saved = await saveWorkflowDraft(superAdmin, { domainKey: "leave", subflowKey: "vacation-request", payload: cleanPayload, validStepIds });
    assert.equal(saved.ok, false, "save disabled");
    if (saved.ok === false) {
      assert.equal(saved.code, "persistence_disabled");
      assert.equal(saved.error, WORKFLOW_CONTROL_DISABLED_MESSAGE);
    }

    const loaded = await loadWorkflowDraft(superAdmin, "leave", "vacation-request");
    assert.equal(loaded.ok, true, "load returns null when disabled (truthful)");
    if (loaded.ok) assert.equal(loaded.data, null);

    const discarded = await discardWorkflowDraft(superAdmin, "any");
    assert.equal(discarded.ok, false);
    if (discarded.ok === false) assert.equal(discarded.code, "persistence_disabled");

    const published = await publishWorkflowDraft(superAdmin, {
      draftId: "d1", domainKey: "leave", subflowKey: "vacation-request",
      draftPayload: cleanPayload, currentPayload: { overrides: {}, orderIds: validStepIds },
      validStepIds, steps: subflow!.steps,
    });
    assert.equal(published.ok, false);
    if (published.ok === false) {
      assert.equal(published.code, "publish_disabled");
      assert.match(published.error, /Phase 3/i);
    }

    const unsafe = await publishWorkflowDraft(superAdmin, {
      draftId: "d2", domainKey: "leave", subflowKey: "vacation-request",
      draftPayload: { overrides: { [validStepIds[0]]: { actor: "Attacker" } as Record<string, string> }, orderIds: validStepIds } as never,
      currentPayload: { overrides: {}, orderIds: validStepIds }, validStepIds,
    });
    assert.equal(unsafe.ok, false);
    if (unsafe.ok === false) {
      assert.equal(unsafe.code, "invalid_payload");
      assert.match(unsafe.error, /actor/i);
    }

    const noop = await publishWorkflowDraft(superAdmin, {
      draftId: "d3", domainKey: "leave", subflowKey: "vacation-request",
      draftPayload: { overrides: {}, orderIds: validStepIds },
      currentPayload: { overrides: {}, orderIds: validStepIds }, validStepIds,
    });
    assert.equal(noop.ok, false);
    if (noop.ok === false) assert.equal(noop.code, "noop");

    const rb = await rollbackWorkflowVersion(superAdmin, { definitionId: "def-1", versionId: "ver-1", reason: "probe" });
    assert.equal(rb.ok, false);
    if (rb.ok === false) assert.equal(rb.code, "rollback_disabled");

    for (const actor of [talentAcquisition, employee]) {
      const s = await saveWorkflowDraft(actor, { domainKey: "leave", subflowKey: "vacation-request", payload: cleanPayload, validStepIds });
      assert.equal(s.ok, false);
      if (s.ok === false) assert.equal(s.code, "forbidden", `${actor.role} -> forbidden on save`);
      const l = await loadWorkflowDraft(actor, "leave", "vacation-request");
      assert.equal(l.ok, false);
      if (l.ok === false) assert.equal(l.code, "forbidden");
      const d = await discardWorkflowDraft(actor, "x");
      assert.equal(d.ok, false);
      if (d.ok === false) assert.equal(d.code, "forbidden");
      const lv = await listWorkflowVersions(actor, "leave", "vacation-request");
      assert.equal(lv.ok, false);
      if (lv.ok === false) assert.equal(lv.code, "forbidden");
      const gv = await getWorkflowVersion(actor, "v1");
      assert.equal(gv.ok, false);
      if (gv.ok === false) assert.equal(gv.code, "forbidden");
      const p = await publishWorkflowDraft(actor, {
        draftId: "d", domainKey: "leave", subflowKey: "vacation-request",
        draftPayload: cleanPayload, currentPayload: { overrides: {}, orderIds: validStepIds }, validStepIds,
      });
      assert.equal(p.ok, false);
      if (p.ok === false) assert.equal(p.code, "forbidden");
      const r = await rollbackWorkflowVersion(actor, { definitionId: "d", versionId: "v" });
      assert.equal(r.ok, false);
      if (r.ok === false) assert.equal(r.code, "forbidden");
      const c = compareWorkflowVersions(actor, null, cleanPayload);
      assert.equal(c.ok, false);
      if (c.ok === false) assert.equal(c.code, "forbidden");
    }

    const versions = await listWorkflowVersions(superAdmin, "leave", "vacation-request");
    assert.equal(versions.ok, true);
    if (versions.ok) assert.deepEqual(versions.data, []);

    const cmp = compareWorkflowVersions(superAdmin, null, cleanPayload, { steps: subflow!.steps });
    assert.equal(cmp.ok, true);
    if (cmp.ok) {
      assert.ok(cmp.data.changeCount >= 1);
      assert.ok(cmp.data.changedFields.some((c) => c.field === "Display name"));
    }

    const audit = await writeWorkflowControlAudit(superAdmin, { action: "save_draft", draftId: "d1", payloadHash: "abc", metadata: { source: "test" } });
    assert.equal(audit.ok, true);
    if (audit.ok) {
      assert.equal(audit.data.written, false);
      assert.equal(audit.data.payload.action, "save_draft");
      assert.equal(audit.data.payload.actorHrId, "B-10");
    }
    const built = buildWorkflowControlAuditPayload(superAdmin, { action: "publish_version" });
    assert.equal(built.actorRole, "Super Admin");
  })().then(() => {
    // Service module purity: real imports / call sites only (not text in comments).
    const serviceFiles = [
      "src/lib/workflow-control/services/drafts.ts",
      "src/lib/workflow-control/services/versions.ts",
      "src/lib/workflow-control/services/publish.ts",
      "src/lib/workflow-control/services/audit.ts",
      "src/lib/workflow-control/feature-flags.ts",
      "src/lib/workflow-control/types.ts",
    ];
    for (const rel of serviceFiles) {
      const raw = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      assert.equal(/from\s+["']@\/lib\/supabase\b/.test(src), false, `${rel} must not import @/lib/supabase`);
      assert.equal(/from\s+["']@supabase\/supabase-js["']/.test(src), false, `${rel} must not import @supabase/supabase-js`);
      assert.equal(/\bgetSupabaseAdmin\s*\(/.test(src), false, `${rel} must not call getSupabaseAdmin()`);
      assert.equal(/\bgetSupabaseUserClient\s*\(/.test(src), false, `${rel} must not call getSupabaseUserClient()`);
      assert.equal(/\bfetch\s*\(/.test(src), false, `${rel} must not call fetch()`);
      assert.equal(/\.from\s*\(\s*["'`]/.test(src), false, `${rel} must not query a DB table`);
    }

    // Runtime workflow services do not import workflow-control services in Phase 3D.
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
      assert.equal(/@\/lib\/workflow-control\/services\b/.test(src), false, `${rel} must not import workflow-control services`);
      assert.equal(/@\/lib\/workflow-control\/governance\b/.test(src), false, `${rel} must not import workflow-control governance`);
    }
  });
}
