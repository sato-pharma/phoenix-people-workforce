import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePlanCeoDecision } from "../src/lib/weekly-planning/plan-v1.ts";
import { resolveApproverPlanStage } from "../src/lib/weekly-planning/service.ts";
import {
  isSecondApproverForManager,
  managerHrIdsForSecondApprover,
  planHasSecondApprover,
  secondApproverHrIdForManager,
} from "../src/lib/weekly-planning/second-approver.ts";

/**
 * Owner instruction 2026-09-20: the District Managers who report to Hany Saad take a longer road —
 * submit -> Hany -> Ali Mohamed Ali -> HR acknowledge (automatic). Every other DM plan keeps
 * submit -> NSM/RSM -> HR acknowledge with NO stage in between (dm-plan-has-no-ceo-stage.test.ts).
 * The stage reuses manager_approved -> final_approved, so no migration: the application decides WHO.
 */

const HANY = "PD-0001";
const ALI = "A-12";
const OTHER_MANAGER = "A-9";
const STAMPED_AT = "2026-09-20T10:00:00+00:00";

const ali = { hrId: ALI, role: "National Sales Manager", scope: "line" } as const;
const hany = { hrId: HANY, role: "Marketing Manager", scope: "company" } as const;
const ceo = { hrId: "AA", role: "CEO", scope: "company" } as const;
const superAdmin = { hrId: "B-10", role: "Super Admin", scope: "system" } as const;

export function runDmPlanSecondApproverTests() {
  // 1. The policy: Hany's plans have Ali as second approver; nobody else's do.
  assert.equal(secondApproverHrIdForManager(HANY), ALI);
  assert.equal(secondApproverHrIdForManager("pd-0001"), ALI, "the manager id matches case-insensitively");
  assert.equal(secondApproverHrIdForManager(OTHER_MANAGER), null);
  assert.equal(secondApproverHrIdForManager(null), null);
  assert.equal(isSecondApproverForManager(ALI, HANY), true);
  assert.equal(isSecondApproverForManager("a-12", HANY), true);
  assert.equal(isSecondApproverForManager(ALI, OTHER_MANAGER), false, "Ali holds the stage only under Hany");
  assert.equal(isSecondApproverForManager("B-10", HANY), false);
  assert.deepEqual(managerHrIdsForSecondApprover(ALI), [HANY]);
  assert.deepEqual(managerHrIdsForSecondApprover("B-10"), []);

  // 2. Only a DISTRICT MANAGER's plan takes the stage — Hany's own report who is not a DM does not.
  assert.equal(planHasSecondApprover(HANY, true), true);
  assert.equal(planHasSecondApprover(HANY, false), false, "the stage is for the DMs reporting to Hany only");
  assert.equal(planHasSecondApprover(OTHER_MANAGER, true), false);

  // 3. The headline: at manager_approved Ali — not the CEO — holds the turn on a Hany DM's plan.
  assert.equal(
    resolveApproverPlanStage("manager_approved", HANY, ali, "District Sales Manager"),
    "ceo",
    "Ali decides the stage after Hany",
  );
  for (const who of [ceo, superAdmin, hany]) {
    assert.equal(
      resolveApproverPlanStage("manager_approved", HANY, who, "District Sales Manager"),
      null,
      `${who.role} has no turn on a Hany DM plan at the second stage`,
    );
  }
  // An acting DM (medical-rep title, DM app role) resolved by the caller takes the stage too.
  assert.equal(resolveApproverPlanStage("manager_approved", HANY, ali, "Medical Representative", true), "ceo");
  // Ali has no turn at the FIRST stage — Hany's approval comes first.
  assert.equal(resolveApproverPlanStage("submitted", HANY, ali, "District Sales Manager"), null);
  assert.equal(resolveApproverPlanStage("submitted", HANY, hany, "District Sales Manager"), "manager");

  // 4. Every other DM plan is unchanged: no stage for the CEO, none for Ali.
  assert.equal(resolveApproverPlanStage("manager_approved", OTHER_MANAGER, ceo, "District Sales Manager"), null);
  assert.equal(resolveApproverPlanStage("manager_approved", OTHER_MANAGER, ali, "District Sales Manager"), null);
  // And a non-DM plan (a product manager under Hany, say) keeps the CEO stage and gives Ali nothing.
  assert.equal(resolveApproverPlanStage("manager_approved", HANY, ceo, "Product Manager"), "ceo");
  assert.equal(resolveApproverPlanStage("manager_approved", HANY, ali, "Product Manager"), null);

  // 5. The stamp: Ali's real decision shows on a Hany DM plan; a stale CEO-column stamp still does not.
  assert.deepEqual(resolvePlanCeoDecision("District Sales Manager", STAMPED_AT, ALI, HANY), {
    decidedAt: STAMPED_AT,
    byHrId: ALI,
  });
  assert.equal(
    resolvePlanCeoDecision("District Sales Manager", STAMPED_AT, "B-10", HANY),
    null,
    "a stamp that is not the second approver's is residue, exactly as before",
  );
  assert.equal(resolvePlanCeoDecision("District Sales Manager", STAMPED_AT, ALI, OTHER_MANAGER), null);
  assert.equal(resolvePlanCeoDecision("District Sales Manager", STAMPED_AT, ALI), null);

  // 6. The wiring — a correct policy nobody enforces is how a stage becomes decoration.
  const service = readFileSync(new URL("../src/lib/weekly-planning/service.ts", import.meta.url), "utf8");
  assert.ok(service.includes("assertSecondApprover("), "decideEmployeePlan must gate the second stage on Ali's identity");
  assert.ok(
    /bypassCeo\s*=[^;]*!hasSecondApprover/.test(service),
    "a Hany DM plan must NOT bypass the CEO slot at manager approval, or it would skip Ali and go straight to HR",
  );
  const hub = readFileSync(new URL("../src/lib/approvals-hub/service.ts", import.meta.url), "utf8");
  assert.ok(hub.includes("planHasSecondApprover("), "the approvals hub must let Ali open and see these plans");
  const command = readFileSync(new URL("../src/lib/ceo/command-center.ts", import.meta.url), "utf8");
  assert.ok(command.includes("planHasSecondApprover("), "the CEO pending count must not include plans waiting on Ali");
}
