import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { OWN_HR_STEP_COMMENT, ownPendingHrStep } from "../src/lib/vacation/approval-flow.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The HR approver's own leave (owner rule, 27 Nov 2026 — "B-10 is the system administrator account
// and the one who approves"; he chose "your own request is fully approved as soon as your manager
// approves it"). His chain is Direct manager (the CEO) -> HR, and the HR step was assigned to HIM, so a
// request the CEO had approved waited on its own sender: 8 of his requests, 28 Jul to 23 Nov 2026, stood
// at pending_hr with the CEO's approval on each, and the morning SLA job reminded him of them daily.
// ─────────────────────────────────────────────────────────────────────────────

const sameHrId = (left: string | null | undefined, right: string | null | undefined) =>
  Boolean(left && right && left.trim().toUpperCase() === right.trim().toUpperCase());

export async function runVacationOwnHrStepTests() {
  // ── The requester's own pending HR step is found ───────────────────────────
  {
    const steps = [
      { approverHrId: "AA", status: "approved", stepKey: "direct_manager", stepOrder: 1 },
      { approverHrId: "B-10", status: "pending", stepKey: "hr", stepOrder: 4 },
    ];
    const step = ownPendingHrStep({ requesterHrId: "b-10", steps, sameHrId });
    assert.equal(step?.stepOrder, 4, "the HR approver's own request: his pending HR step is completed for him");
  }

  // ── Every other employee keeps the HR step for the HR approver ─────────────
  {
    const steps = [
      { approverHrId: "AB", status: "approved", stepKey: "direct_manager", stepOrder: 1 },
      { approverHrId: "B-10", status: "pending", stepKey: "hr", stepOrder: 3 },
    ];
    assert.equal(ownPendingHrStep({ requesterHrId: "A-3", steps, sameHrId }), null, "someone else's request still waits for HR");
  }

  // ── A management step assigned to the requester is never touched ──────────
  {
    const steps = [{ approverHrId: "B-10", status: "pending", stepKey: "direct_manager", stepOrder: 1 }];
    assert.equal(ownPendingHrStep({ requesterHrId: "B-10", steps, sameHrId }), null, "only the HR step, never a management step");
  }

  // ── A decided HR step, or no requester, is left alone ──────────────────────
  {
    const steps = [{ approverHrId: "B-10", status: "approved", stepKey: "hr", stepOrder: 4 }];
    assert.equal(ownPendingHrStep({ requesterHrId: "B-10", steps, sameHrId }), null);
    assert.equal(ownPendingHrStep({ requesterHrId: "", steps: [{ ...steps[0], status: "pending" }], sameHrId }), null);
  }

  assert.match(OWN_HR_STEP_COMMENT, /you are its HR approver/);

  // ── The service completes it at the moment management finishes, before any HR notice ──
  {
    const source = stripComments(readFileSync("src/lib/vacation/service.ts", "utf8"));
    const branch = source.indexOf('} else if (nextStatus === "pending_hr") {');
    assert.ok(branch > 0, "the sequential flow still has its pending_hr branch");
    const own = source.indexOf("completeOwnHrStep(updated.id)", branch);
    const notice = source.indexOf("deferVacationNotice(", branch);
    assert.ok(own > branch && own < notice, "the own-request HR step is completed before HR is notified to acknowledge");
    assert.match(
      source,
      /export async function completeOwnHrStep[\s\S]*?ownPendingHrStep\(\{ requesterHrId: request\.employeeHrId, steps, sameHrId: hrIdsMatch \}\)[\s\S]*?applyVacationDecisionSequential\(\{[\s\S]*?decision: "approve"/,
      "completeOwnHrStep approves through the same decision path as his own click",
    );
    assert.match(
      source,
      /export async function completeOwnHrStep[\s\S]*?if \(!hasAcceptedRequiredEvidence\(request\)\) return null;/,
      "required evidence must still be accepted first",
    );
  }
}
