import assert from "node:assert/strict";

import {
  canCastOfferApproval,
  computeRequiredApprovers,
  evaluateChainState,
} from "../src/lib/offers/approval-chain.ts";
import { resolvePositionApprovalThreshold } from "../src/config/offer-approval.ts";

export function runOfferApprovalChainTests() {
  // Always HR + Finance + hiring manager below the cap.
  const below = computeRequiredApprovers({ netSalary: 10000, hiringManagerHrId: "HR-1", threshold: 20000 });
  assert.equal(below.length, 3, "three required approvers below the cap");
  assert.deepEqual(below.map((step) => step.label), ["HR Manager", "Finance", "Department Head"]);

  // CEO is added above the cap.
  const above = computeRequiredApprovers({ netSalary: 25000, hiringManagerHrId: "HR-1", threshold: 20000 });
  assert.equal(above.length, 4, "CEO added above the cap");
  assert.equal(above[3].role, "CEO");

  // At the cap excludes CEO (strict >).
  const atCap = computeRequiredApprovers({ netSalary: 20000, hiringManagerHrId: "HR-1", threshold: 20000 });
  assert.equal(atCap.length, 3, "at-cap excludes CEO");

  // No hiring manager -> only the role steps.
  const noMgr = computeRequiredApprovers({ netSalary: 10000, hiringManagerHrId: null, threshold: 20000 });
  assert.equal(noMgr.length, 2, "no hiring manager => HR + Finance only");

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
  assert.equal(evaluateChainState([]), "pending");

  // canCastOfferApproval — role step.
  const roleStep = { approverKind: "role" as const, approverRole: "Finance Manager", approverHrId: null };
  assert.equal(canCastOfferApproval({ role: "Finance Manager", scope: "company", hrId: null }, roleStep), true);
  assert.equal(canCastOfferApproval({ role: "HR Specialist", scope: "company", hrId: null }, roleStep), false);
  assert.equal(canCastOfferApproval({ role: "Super Admin", scope: "company", hrId: null }, roleStep), true, "Super Admin always");

  // canCastOfferApproval — person step (hiring manager).
  const personStep = { approverKind: "person" as const, approverRole: null, approverHrId: "MGR-9" };
  assert.equal(canCastOfferApproval({ role: "District Manager", scope: "team", hrId: "MGR-9" }, personStep), true);
  assert.equal(canCastOfferApproval({ role: "District Manager", scope: "team", hrId: "ZZZ-1" }, personStep), false);

  // resolvePositionApprovalThreshold — requisition band wins; otherwise a positive default.
  assert.equal(resolvePositionApprovalThreshold({ jobTitle: "Medical Rep", salaryBandMax: 45000 }), 45000);
  const fallback = resolvePositionApprovalThreshold({ jobTitle: "Medical Rep", salaryBandMax: null });
  assert.ok(Number.isFinite(fallback) && fallback > 0, "fallback threshold is positive");
}
