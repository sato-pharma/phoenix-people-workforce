import assert from "node:assert/strict";

import {
  canCastOfferApproval,
  computeRequiredApprovers,
  evaluateChainState,
} from "../src/lib/offers/approval-chain.ts";
import { resolvePositionApprovalThreshold } from "../src/config/offer-approval.ts";

export function runOfferApprovalChainTests() {
  // Finance Manager is NOT a required approver (Financial Advisor executes; never gates).
  // Chain below cap: HR Manager + hiring manager only.
  const below = computeRequiredApprovers({ netSalary: 10000, hiringManagerHrId: "HR-1", threshold: 20000 });
  assert.equal(below.length, 2, "two required approvers below the cap (HR Manager + Department Head)");
  assert.deepEqual(below.map((step) => step.label), ["HR Manager", "Department Head"]);

  // CEO is added above the cap.
  const above = computeRequiredApprovers({ netSalary: 25000, hiringManagerHrId: "HR-1", threshold: 20000 });
  assert.equal(above.length, 3, "CEO added above the cap");
  assert.equal(above[2].role, "CEO");

  // At the cap excludes CEO (strict >).
  const atCap = computeRequiredApprovers({ netSalary: 20000, hiringManagerHrId: "HR-1", threshold: 20000 });
  assert.equal(atCap.length, 2, "at-cap excludes CEO");

  // No hiring manager -> HR Manager only.
  const noMgr = computeRequiredApprovers({ netSalary: 10000, hiringManagerHrId: null, threshold: 20000 });
  assert.equal(noMgr.length, 1, "no hiring manager => HR Manager only");
  assert.equal(noMgr[0].role, "Super Admin");

  // evaluateChainState truth table.
  assert.equal(evaluateChainState([{ required: true, decision: "pending" }]), "pending");
  assert.equal(
    evaluateChainState([{ required: true, decision: "approved" }, { required: true, decision: "pending" }]),
    "pending",
  );
  assert.equal(
    evaluateChainState([{ required: true, decision: "approved" }, { required: true, decision: "approved" }]),
    "approved",
  );
  assert.equal(
    evaluateChainState([{ required: true, decision: "approved" }, { required: true, decision: "rejected" }]),
    "rejected",
  );
  assert.equal(
    evaluateChainState([{ required: true, decision: "approved" }, { required: true, decision: "returned" }]),
    "returned",
  );
  assert.equal(evaluateChainState([]), "pending");

  // canCastOfferApproval — role step.
  const roleStep = { approverKind: "role" as const, approverRole: "CEO", approverHrId: null };
  assert.equal(canCastOfferApproval({ role: "CEO", scope: "company", hrId: null }, roleStep), true);
  assert.equal(canCastOfferApproval({ role: "Talent Acquisition", scope: "self", hrId: "A-16" }, roleStep), false);
  assert.equal(canCastOfferApproval({ role: "Super Admin", scope: "company", hrId: null }, roleStep), true, "Super Admin always");

  // canCastOfferApproval — person step (hiring manager).
  const personStep = { approverKind: "person" as const, approverRole: null, approverHrId: "MGR-9" };
  assert.equal(canCastOfferApproval({ role: "District Manager", scope: "team", hrId: "MGR-9" }, personStep), true);
  assert.equal(canCastOfferApproval({ role: "District Manager", scope: "team", hrId: "ZZZ-1" }, personStep), false);

  // Governance: Finance Manager must NOT appear in any step of the chain.
  const withCeo = computeRequiredApprovers({ netSalary: 30000, hiringManagerHrId: "X-1", threshold: 20000 });
  assert.ok(
    withCeo.every((step) => step.role !== "Finance Manager"),
    "Finance Manager must NOT be a required approver in any chain",
  );

  // resolvePositionApprovalThreshold — requisition band wins; otherwise a positive default.
  assert.equal(resolvePositionApprovalThreshold({ jobTitle: "Medical Rep", salaryBandMax: 45000 }), 45000);
  const fallback = resolvePositionApprovalThreshold({ jobTitle: "Medical Rep", salaryBandMax: null });
  assert.ok(Number.isFinite(fallback) && fallback > 0, "fallback threshold is positive");
}
