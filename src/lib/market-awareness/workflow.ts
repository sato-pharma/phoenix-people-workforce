import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type { MarketAwarenessApproverSlot } from "@/lib/market-awareness/approvers";
import { canDecideSlot, groupHasApproved } from "@/lib/market-awareness/approvers";
import type {
  MarketAwarenessDecisionAction,
  MarketAwarenessStatus,
  MarketAwarenessStepCode,
} from "@/lib/market-awareness/types";

/**
 * The chain: draft -> the group -> CEO -> approved -> executed -> closed.
 *
 * THE GROUP IS PARALLEL, AND THAT IS THE WHOLE CHANGE (owner, 2026-09-09). A Product Manager or the
 * Group Product Manager submits, and the Marketing Manager and the National Sales Manager of the
 * primary line are asked AT THE SAME TIME — plus the NSM of every further line the activity targets,
 * so the group is two people for a one-line activity and three or four for a multi-line one. Each of
 * them may approve, reject, return, or HOLD. When the last of them has approved, and only then, it
 * moves to the CEO, who still decides and is still the only person who may approve at a different
 * amount.
 *
 * There is still deliberately NO SFE validation step — that exists in marketing requests because the
 * requester is field force, and product managers are trusted more than field force, which is the
 * reason this module exists at all. There is no finance APPROVAL step either: Finance is informed
 * and marks paid.
 *
 * WHY `approve` IS NOT IN THE TRANSITION TABLE FOR THE GROUP. Every other action has exactly one
 * destination. A group approval has two — stay where you are, or move to the CEO — and which one it
 * is depends on what the OTHER approvers have already said. A table row would have to name a
 * destination before the gate has been consulted, and the gate is the point.
 */

export const marketAwarenessWorkflowRegistryModuleKey = "market_awareness";

export type MarketAwarenessTransition = {
  from: MarketAwarenessStatus;
  action: MarketAwarenessDecisionAction;
  to: MarketAwarenessStatus;
  step: MarketAwarenessStepCode | null;
};

export const MARKET_AWARENESS_TRANSITIONS: MarketAwarenessTransition[] = [
  // The group. `approve` is absent on purpose — see `resolveGroupApproval` below.
  { from: "pending_group", action: "return", to: "returned", step: "group" },
  { from: "pending_group", action: "reject", to: "rejected", step: "group" },
  { from: "pending_group", action: "hold", to: "on_hold", step: "group" },
  // Release puts it back exactly where it was frozen. Hold is only ever offered at the group step,
  // so there is one destination and nothing to remember about where it came from.
  { from: "on_hold", action: "release", to: "pending_group", step: "group" },

  { from: "pending_ceo", action: "approve", to: "approved", step: "ceo" },
  { from: "pending_ceo", action: "return", to: "returned", step: "ceo" },
  { from: "pending_ceo", action: "reject", to: "rejected", step: "ceo" },

  { from: "draft", action: "withdraw", to: "withdrawn", step: null },
  { from: "returned", action: "withdraw", to: "withdrawn", step: null },
  { from: "pending_group", action: "withdraw", to: "withdrawn", step: null },
  // A held request is frozen for the APPROVERS, never for its owner. It is still his to pull back,
  // and refusing that would leave him holding a request he can neither progress nor cancel.
  { from: "on_hold", action: "withdraw", to: "withdrawn", step: null },
  // The PM may withdraw "before the CEO decides" (owner answer 39) — so a request sitting in the
  // CEO's queue is still withdrawable, and one he has already approved is not.
  { from: "pending_ceo", action: "withdraw", to: "withdrawn", step: null },

  { from: "approved", action: "execute", to: "executed", step: null },
  { from: "executed", action: "close", to: "closed", step: null },
];

export function findTransition(
  from: MarketAwarenessStatus,
  action: MarketAwarenessDecisionAction,
): MarketAwarenessTransition | null {
  return (
    MARKET_AWARENESS_TRANSITIONS.find(
      (transition) => transition.from === from && transition.action === action,
    ) ?? null
  );
}

/** Which step is waiting on a decision, if any. */
export function currentStep(status: MarketAwarenessStatus): MarketAwarenessStepCode | null {
  if (status === "pending_group") return "group";
  if (status === "pending_ceo") return "ceo";
  // `on_hold` answers null deliberately: a frozen request is waiting on nobody, so it counts towards
  // no badge and offers no decision buttons until somebody releases it.
  return null;
}

/**
 * What one approval at the group step does.
 *
 * The slots passed in must ALREADY carry the answer being recorded — this is asked after the slot is
 * filled, never before, because "has everybody approved" cannot be answered without counting the
 * approval currently being made. The database function does exactly that: it writes the slot, then
 * asks this same question of the rows it can now see.
 */
export function resolveGroupApproval(slotsAfterThisDecision: MarketAwarenessApproverSlot[]): {
  complete: boolean;
  nextStatus: MarketAwarenessStatus;
} {
  const complete = groupHasApproved(slotsAfterThisDecision);
  return { complete, nextStatus: complete ? "pending_ceo" : "pending_group" };
}

/**
 * Where a resubmission lands.
 *
 * A returned activity restarts from the GROUP, never from the step that returned it (owner answer
 * 38, unchanged by the parallel rewrite). The PM edits and resubmits, and every approver sees the
 * change before the CEO does — including the ones who had already approved the previous version,
 * because what they approved is not what is now in front of them. That is the owner's answer of
 * 2026-09-09: a return RESETS the group.
 *
 * `hasApprovers` false is the routing-failure case — nobody could be resolved at all — and it goes
 * straight to the CEO rather than sitting in a queue with no members.
 */
export function statusAfterResubmit(hasApprovers: boolean): MarketAwarenessStatus {
  return hasApprovers ? "pending_group" : "pending_ceo";
}

/**
 * May this person decide this step?
 *
 * The GROUP step is answered per slot: role-and-line for a National Sales Manager, role for the
 * Marketing Manager, plus the person the slot was routed to. `canDecideSlot` holds that rule and
 * this defers to it rather than restating it — a second copy of a routing rule is how a queue comes
 * to offer a button the server then refuses.
 *
 * The CEO step is role-checked, because there is exactly one CEO. Nothing here may ever approve FOR
 * him: a system actor writing a decision row under a manager's identity is what made three NSMs
 * appear to have approved as the CEO on the weekly plans.
 */
export function canDecideStep(input: {
  access: Pick<AccessContext, "role" | "hrId">;
  step: MarketAwarenessStepCode;
  /** The actor's own `employees.line_id`, needed only for a National Sales Manager slot. */
  actorLineId?: number | null;
  approvers?: MarketAwarenessApproverSlot[];
  /** Only read for a historical `manager`-step row. */
  managerHrId?: string | null;
}): boolean {
  if (input.step === "ceo") {
    return input.access.role === "CEO" || input.access.role === "Super Admin";
  }

  if (input.step === "group") {
    const slots = input.approvers ?? [];
    return slots.some(
      (slot) =>
        slot.decision === null &&
        canDecideSlot({ access: input.access, actorLineId: input.actorLineId ?? null, slot }),
    );
  }

  // The retired single-manager step. No row can enter it any more; this survives so that a historical
  // one still resolves instead of throwing.
  if (input.access.role === "Super Admin") return true;
  if (!input.managerHrId || !input.access.hrId) return false;
  return canonicalHrIdKey(input.access.hrId) === canonicalHrIdKey(input.managerHrId);
}

/**
 * May this person release a held request?
 *
 * Whoever held it, the CEO, and Super Admin. Deliberately NOT every approver — a hold any peer can
 * undo is not a hold, and the person who froze it is the one who knows what he was waiting for. The
 * CEO is included because a hold with nobody left to lift it is a request that has quietly died, and
 * somebody above the group has to be able to move it.
 */
export function canReleaseHold(input: {
  access: Pick<AccessContext, "role" | "hrId">;
  heldByHrId: string | null;
}): boolean {
  if (input.access.role === "Super Admin" || input.access.role === "CEO") return true;
  const actorKey = canonicalHrIdKey(input.access.hrId ?? "");
  const holderKey = canonicalHrIdKey(input.heldByHrId ?? "");
  if (!actorKey || !holderKey) return false;
  return actorKey === holderKey;
}
