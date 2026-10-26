import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isOutstationEvidenceWaivedRole } from "../src/lib/outstation/evidence-waiver.ts";
import {
  outstationRequestMayReachPayroll,
  resolveOutstationGateState,
} from "../src/lib/outstation/expense-gate.ts";
import {
  OUTSTATION_NO_HOLD_GATE_MESSAGE,
  OUTSTATION_NO_HOLD_ROLES,
  isOutstationNoHoldRole,
} from "../src/lib/outstation/nsm-no-hold.ts";
import type {
  OutstationEvidenceGateStatus,
  OutstationWorkloadGateStatus,
} from "../src/lib/outstation/types.ts";

/**
 * Owner rule (2026-08-28): "Don't hold the expenses of the national sales manager for any reason.
 * Once submitted, once accepted."
 *
 * He said it after finding Magdy El Senosey's 26 August claim held on `pending_workload` — a gate
 * that reads AM/PM visits out of the CRM, which a National Sales Manager never generates, so it
 * could not have cleared on its own at any point in the future.
 *
 * The rule has four ways of going wrong, and each gets its own block:
 *
 *   - applied too widely — some other role losing its gate with it, which is how a payroll control
 *     stops existing;
 *   - applied too narrowly — one gate cleared while another still blocks, which parks the claim at
 *     a checkpoint it can never pass and stops the money exactly as before;
 *   - accepted but never released — the row reads `accepted_by_system` and no payroll push ever
 *     happens, which is a hold wearing a different word;
 *   - released as the SUBMITTER — the payroll write asserts a manual-approval permission an NSM
 *     does not hold, so his own context is refused and the claim silently stays unpaid.
 */

const EVIDENCE_STATUSES: readonly OutstationEvidenceGateStatus[] = [
  "pending_arrival_photo",
  "pending_departure_photo",
  "complete",
  "grandfathered",
];
const WORKLOAD_STATUSES: readonly OutstationWorkloadGateStatus[] = [
  "pending_workload",
  "complete",
  "manual",
  "grandfathered",
];

const STILL_HELD_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
  "Employee",
] as const;

export function runOutstationNsmNoHoldTests() {
  // ── Exactly one role, and no more ───────────────────────────────────────────────
  assert.equal(
    OUTSTATION_NO_HOLD_ROLES.size,
    1,
    "the owner named ONE role. A second arriving silently would remove the payroll gate from someone he never exempted",
  );
  assert.equal(isOutstationNoHoldRole("National Sales Manager"), true, "the role the owner named");
  assert.equal(
    isOutstationNoHoldRole("  national sales manager  "),
    true,
    "the role arrives from a database column, so casing and stray spacing must not re-arm a hold the owner removed",
  );
  assert.equal(isOutstationNoHoldRole(null), false, "an unknown role is never exempt");
  assert.equal(isOutstationNoHoldRole(""), false, "an empty role is never exempt");
  for (const role of STILL_HELD_ROLES) {
    assert.equal(
      isOutstationNoHoldRole(role),
      false,
      `${role} is still held by the gate — this is an allowlist of one, never a seniority test`,
    );
  }

  // This rule is NOT the photo waiver. Product Manager, Group Product Manager and Training
  // Manager are waived from the photographs (evidence-waiver.ts) and are still held by the
  // workload gate; if the two ever merge, a widening of one silently widens the other.
  assert.equal(isOutstationEvidenceWaivedRole("Product Manager"), true, "the photo waiver is wider");
  assert.equal(
    isOutstationNoHoldRole("Product Manager"),
    false,
    "the photo waiver covers four roles; the no-hold rule covers one, and the two must not be conflated",
  );
  assert.equal(
    isOutstationEvidenceWaivedRole("Training Manager"),
    true,
    "the Training Manager joined the photo waiver on 2026-10-26",
  );
  assert.equal(
    isOutstationNoHoldRole("Training Manager"),
    false,
    "…and that did not put her in this one — she is still held by the workload gate",
  );

  // ── An NSM is never blocked, in any state the row can physically be in ──────────
  for (const evidenceGateStatus of EVIDENCE_STATUSES) {
    for (const workloadGateStatus of WORKLOAD_STATUSES) {
      for (const hasArrivalPhoto of [true, false]) {
        for (const hasDeparturePhoto of [true, false]) {
          const gate = resolveOutstationGateState({
            employeeRole: "National Sales Manager",
            evidenceGateStatus,
            hasArrivalPhoto,
            hasDeparturePhoto,
            workloadGateStatus,
          });
          const shape = `${evidenceGateStatus}/${workloadGateStatus}/arrival:${hasArrivalPhoto}/departure:${hasDeparturePhoto}`;
          assert.equal(gate.blocker, null, `an NSM is never blocked (${shape})`);
          assert.equal(
            gate.isPayrollEligible,
            true,
            `an NSM always reaches payroll (${shape}) — this is the assertion that pays him`,
          );
          assert.equal(gate.message, OUTSTATION_NO_HOLD_GATE_MESSAGE, `one message, always (${shape})`);
          assert.equal(
            outstationRequestMayReachPayroll({
              employeeRole: "National Sales Manager",
              evidenceGateStatus,
              hasArrivalPhoto,
              hasDeparturePhoto,
              workloadGateStatus,
            }),
            true,
            `the convenience wrapper agrees with the resolver (${shape})`,
          );
        }
      }
    }
  }

  // The exact shape that was held in production: request 101, Magdy El Senosey, 2026-08-26,
  // EGP 935.87 — photo-waived so no photo was ever taken, and a workload the CRM cannot supply.
  const productionShape = resolveOutstationGateState({
    employeeRole: "National Sales Manager",
    evidenceGateStatus: "pending_arrival_photo",
    hasArrivalPhoto: false,
    hasDeparturePhoto: false,
    workloadGateStatus: "pending_workload",
  });
  assert.equal(
    productionShape.isPayrollEligible,
    true,
    "the live held claim (evidence pending_arrival_photo + workload pending_workload) now reaches payroll",
  );

  // ── The rule did NOT widen: everyone else is still held by the same shape ───────
  for (const role of STILL_HELD_ROLES) {
    const gate = resolveOutstationGateState({
      employeeRole: role,
      evidenceGateStatus: "complete",
      hasArrivalPhoto: true,
      hasDeparturePhoto: true,
      workloadGateStatus: "pending_workload",
    });
    assert.equal(
      gate.blocker,
      "workload",
      `${role} is still held for the trip workload — removing the gate for one role must not remove it for anyone else`,
    );
    assert.equal(
      gate.isPayrollEligible,
      false,
      `${role} still does not reach payroll without a workload`,
    );
  }

  // ── "Once submitted, once accepted" — pinned in the submit path itself ──────────
  //
  // Whole-file matching on purpose. A byte window around a declaration has false-failed here
  // before when the file shifted, and every string below is specific enough that no neighbouring
  // code could satisfy it.
  const service = readFileSync(new URL("../src/lib/outstation/service.ts", import.meta.url), "utf8");

  assert.match(
    service,
    /const noHoldRole = isOutstationNoHoldRole\(calculation\.employeeRole\);/,
    "the submit path resolves the rule from the CALCULATION role — the same value written to employee_role, so every later read agrees with the submitter's screen",
  );
  assert.match(
    service,
    /const reviewHoldReasons = noHoldRole \? \[\] : detectedHoldReasons;/,
    "every automated check still RUNS and still records what it saw; only the hold is removed",
  );
  assert.match(
    service,
    /const workflowStatus = noHoldRole \? "accepted_by_system" : "submitted";/,
    "once submitted, once accepted — and every other role still waits for a human (owner decision 2026-08-08)",
  );
  assert.match(
    service,
    /releaseOutstationRequestToPayrollIfReady\(submitted\.id, systemAccessContext\)/,
    "the claim is pushed into payroll as the SYSTEM: an accepted claim nobody releases is a hold under another name, and the submitter's own context is refused by the payroll write",
  );
  assert.match(
    service,
    /event: "outstation_no_hold_release_failed"/,
    "a failed release is logged, never swallowed — an unpaid claim nobody can see is the exact outcome this rule exists to prevent",
  );
  assert.doesNotMatch(
    service,
    /const workflowStatus = "submitted";/,
    "the unconditional status is gone; leaving it behind would mean the branch above was never reached",
  );

  // ── The SECOND filing route (owner instruction, 2026-08-28, same day) ────────────────────
  // An admin can enter a trip on someone's behalf. That path was deliberately left waiting when
  // the rule first shipped — the queue is where an amount somebody else typed gets confirmed —
  // and the owner overruled it: a National Sales Manager is never held on either route. The
  // asymmetry it replaced was the real defect: the same claim was instant or queued depending on
  // who happened to type it in.
  assert.match(
    service,
    /const noHoldRole = isOutstationNoHoldRole\(employeeRole\);/,
    "the admin path resolves the rule from the role it is about to STORE, so the claim is judged against the role it is filed under",
  );
  assert.match(
    service,
    /const adminWorkflowStatus = noHoldRole \? "accepted_by_system" : "submitted";/,
    "an admin-created claim is accepted on the spot for the exempt role and still queued for everyone else",
  );
  assert.match(
    service,
    /releaseOutstationRequestToPayrollIfReady\(created\.id, systemAccessContext\)/,
    "and it is pushed into payroll as the SYSTEM, not as the admin who typed it — the rule accepted this claim, not a person",
  );
  assert.doesNotMatch(
    service,
    /approval_reason: "Manual outstation expense created by admin\. Requires manual review\.",/,
    "the unconditional 'requires manual review' reason is gone — a row that is never reviewed must not claim it is waiting to be",
  );

  // Both routes must resolve the rule through the module. Two call sites, one allowlist: an
  // inline role comparison on either side is how the two routes drift back apart.
  const ruleCallSites = service.match(/isOutstationNoHoldRole\(/g) ?? [];
  assert.equal(
    ruleCallSites.length,
    2,
    "exactly two call sites — the employee's own submission and the admin's manual entry; a third means a path was added without being reviewed against this rule",
  );
}
