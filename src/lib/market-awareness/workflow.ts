import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type {
  MarketAwarenessDecisionAction,
  MarketAwarenessStatus,
  MarketAwarenessStepCode,
} from "@/lib/market-awareness/types";

/**
 * The chain: draft -> manager -> CEO -> approved -> executed -> closed.
 *
 * Two approval steps and no more. There is deliberately NO SFE validation step — that exists in
 * marketing requests because the requester is field force, and product managers are trusted more
 * than field force, which is the reason this module exists at all. There is no finance APPROVAL
 * step either: Finance is informed and marks paid.
 */

export const marketAwarenessWorkflowRegistryModuleKey = "market_awareness";

export type MarketAwarenessTransition = {
  from: MarketAwarenessStatus;
  action: MarketAwarenessDecisionAction;
  to: MarketAwarenessStatus;
  step: MarketAwarenessStepCode | null;
};

export const MARKET_AWARENESS_TRANSITIONS: MarketAwarenessTransition[] = [
  { from: "pending_manager", action: "approve", to: "pending_ceo", step: "manager" },
  { from: "pending_manager", action: "return", to: "returned", step: "manager" },
  { from: "pending_manager", action: "reject", to: "rejected", step: "manager" },
  { from: "pending_ceo", action: "approve", to: "approved", step: "ceo" },
  { from: "pending_ceo", action: "return", to: "returned", step: "ceo" },
  { from: "pending_ceo", action: "reject", to: "rejected", step: "ceo" },
  { from: "draft", action: "withdraw", to: "withdrawn", step: null },
  { from: "returned", action: "withdraw", to: "withdrawn", step: null },
  { from: "pending_manager", action: "withdraw", to: "withdrawn", step: null },
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
  if (status === "pending_manager") return "manager";
  if (status === "pending_ceo") return "ceo";
  return null;
}

/**
 * A returned activity restarts from the MANAGER step, never from the step that returned it (owner
 * answer 38). The PM edits and resubmits, and the manager sees the change before the CEO does.
 */
export function statusAfterResubmit(skipManagerStep: boolean): MarketAwarenessStatus {
  return skipManagerStep ? "pending_ceo" : "pending_manager";
}

export type ManagerResolution = {
  managerHrId: string | null;
  /** True when there is no manager step below the CEO, so submission goes straight to him. */
  skipManagerStep: boolean;
  reason: string;
};

/**
 * Who the manager step belongs to, resolved from the requester's own reporting line.
 *
 * IDENTITY-BASED, NOT TITLE-BASED. The rule is "the step above you, unless that is the CEO" — not
 * "unless you are the Marketing Manager". Both produce the same answer today (Hossam A-9 reports to
 * AA, Anwar Gaweesh, the CEO) but only the identity form survives a reorganisation, and a title
 * comparison is what put a manager inside her own subordinate's scope once already.
 *
 * The two Product Managers deliberately resolve to DIFFERENT managers — Nahed A-10 to Hossam A-9,
 * Ahmed SharafEldeen B-155 to Rasha A-8 — which is why this reads the reporting line rather than
 * naming the Group Product Manager as everyone's approver.
 */
export function resolveManagerStep(input: {
  requesterHrId: string;
  requesterManagerHrId: string | null;
  managerIsCeo: boolean;
}): ManagerResolution {
  const managerHrId = input.requesterManagerHrId?.trim() || null;

  if (!managerHrId) {
    return {
      managerHrId: null,
      skipManagerStep: true,
      reason: "This requester has nobody above them, so the CEO is the only approval.",
    };
  }

  if (input.managerIsCeo) {
    return {
      managerHrId: null,
      skipManagerStep: true,
      reason: "This requester reports to the CEO, so there is no manager step underneath him.",
    };
  }

  if (canonicalHrIdKey(managerHrId) === canonicalHrIdKey(input.requesterHrId)) {
    // A row that manages itself would otherwise let the requester approve his own activity.
    return {
      managerHrId: null,
      skipManagerStep: true,
      reason: "This requester is recorded as their own manager, so the CEO is the only approval.",
    };
  }

  return {
    managerHrId,
    skipManagerStep: false,
    reason: "The requester's own manager approves first, then the CEO.",
  };
}

/**
 * May this person decide this step?
 *
 * The manager step is IDENTITY-checked — the one person the activity was routed to — rather than
 * role-checked. A role check would let any Group Product Manager approve any Product Manager's
 * activity, which is not what "his direct manager" means.
 *
 * The CEO step is role-checked, because there is exactly one CEO. Nothing here may ever approve FOR
 * him: a system actor writing a decision row under a manager's identity is what made three NSMs
 * appear to have approved as the CEO on the weekly plans.
 */
export function canDecideStep(input: {
  access: Pick<AccessContext, "role" | "hrId">;
  step: MarketAwarenessStepCode;
  managerHrId: string | null;
}): boolean {
  if (input.step === "ceo") {
    return input.access.role === "CEO" || input.access.role === "Super Admin";
  }
  if (input.access.role === "Super Admin") return true;
  if (!input.managerHrId || !input.access.hrId) return false;
  return canonicalHrIdKey(input.access.hrId) === canonicalHrIdKey(input.managerHrId);
}
