import type { PhoenixRole } from "@/lib/auth/permissions";
import type {
  DirectOrderDecision,
  DirectOrderStatus,
  DirectOrderStepState,
} from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// Pure, database-free decision core for the Direct Order approval chain.
//
// The chain is a strictly-ordered sequence that always OPENS with SFE Manager validation
// and always ENDS at the CEO, with the requester's own management line in between. A rung is
// actionable only after every lower-order rung is approved. Any reject is final; a return sends
// the request back to the requester for edit; approving the last (CEO) rung finalizes as
// `approved`.
//
//   every request              SFE → management line → CEO
//
// An unrecognised pharmacy no longer changes that shape (owner rule, 2026-08-04, superseding the
// System Admin rung added earlier the same day). Confirming a hand-typed pharmacy's codes is now
// part of the SFE validation rung rather than a rung of its own — see `isSfeValidationStep`.
//
// Bonus is capped (25% of qty; Ivyronc 30%) and NEVER enters the sales value —
// value is always `approvedQty × pharmacyPrice`. Exceeding a cap does NOT block: the
// request is flagged and still climbs the normal chain (owner rule, 2026-08-03).
// ─────────────────────────────────────────────────────────────────────────────

const CEO_ROLE: PhoenixRole = "CEO";

/**
 * The validation rung that opens every chain (owner rule, 2026-08-03).
 *
 * SFE validates the request before it costs the sales line any time — so a malformed or
 * out-of-policy order is caught at step 1 rather than after three managers have signed it.
 * Like the CEO rung it is resolved BY ROLE, not to a person, so a change of post-holder does
 * not strand an in-flight request on someone who has left the seat.
 */
export const SFE_VALIDATION_ROLE: PhoenixRole = "SFE Manager";

/**
 * LEGACY ONLY — the Super Admin rung is no longer built into any chain (owner rule, 2026-08-04:
 * "remove the super admin from the approval workflow of the direct orders").
 *
 * It is kept solely to RECOGNISE rungs on requests chained before that rule, so approving one of
 * those still confirms the pharmacy instead of silently doing nothing. Do not add it to a new
 * chain — {@link directOrderExpectedRoleChain} deliberately never emits it.
 *
 * Why the rung existed at all, and where that job went: a hand-typed pharmacy needs somebody to
 * confirm its distributor codes are real, or a mistyped code mis-attributes retail sales forever.
 * That check now rides on the SFE validation rung, which is mandatory, always first, and already
 * the "should this pharmacy exist at all" decision — so the confirmation is still visible in the
 * chain and now happens EARLIER than it did as its own rung.
 */
export const LEGACY_SYSTEM_ADMIN_ACK_ROLE: PhoenixRole = "Super Admin";

/**
 * Expected management-rung roles for a requester (the CEO rung is always appended
 * separately). Owner-locked ladder — the requester climbs their sales line to the
 * CEO; Product/Group-Product Managers go straight to the CEO. The SERVICE resolves
 * each management rung to the requester's ACTUAL manager (walking the live org /
 * seat model); this list drives labels, previews, and the expected rung count.
 */
export function directOrderManagementLadder(requesterRole: PhoenixRole): PhoenixRole[] {
  switch (requesterRole) {
    case "District Manager":
      return ["Regional Manager", "National Sales Manager"];
    case "Regional Manager":
      return ["National Sales Manager"];
    case "National Sales Manager":
      return [];
    case "Product Manager":
    case "Group Product Manager":
      return [];
    default:
      // Unsupported requester role → CEO-only fallback (service also gates by role).
      return [];
  }
}

/**
 * Full expected role sequence: SFE validation, then the requester's management line, then the CEO.
 *
 * The shape no longer varies with the pharmacy. Whether Phoenix recognises the pharmacy or not,
 * the chain is the same length and the same rungs — confirming a hand-typed pharmacy is part of
 * the SFE rung, not a rung of its own.
 */
export function directOrderExpectedRoleChain(requesterRole: PhoenixRole): PhoenixRole[] {
  return [SFE_VALIDATION_ROLE, ...directOrderManagementLadder(requesterRole), CEO_ROLE];
}

/** True for the opening SFE validation rung. */
export function isSfeValidationStep(step: Pick<DirectOrderStepState, "kind" | "role">): boolean {
  return step.kind === "role" && step.role === SFE_VALIDATION_ROLE;
}

/**
 * True for a LEGACY System Admin acknowledgment rung on a request chained before that rung was
 * retired. New chains never contain one; this exists so approving an old one still confirms the
 * pharmacy rather than quietly leaving it unverified.
 *
 * Deliberately matched on `kind === "role"` as well as the role name: a PERSON rung whose occupant
 * happens to be a Super Admin is an ordinary management rung and must not silently verify a
 * pharmacy on approval.
 */
export function isLegacySystemAdminAckStep(
  step: Pick<DirectOrderStepState, "kind" | "role">,
): boolean {
  return step.kind === "role" && step.role === LEGACY_SYSTEM_ADMIN_ACK_ROLE;
}

/**
 * True for any rung whose approval confirms a hand-typed pharmacy: the SFE validation rung on
 * every current chain, or a legacy System Admin rung on an older one.
 */
export function isPharmacyConfirmingStep(
  step: Pick<DirectOrderStepState, "kind" | "role">,
): boolean {
  return isSfeValidationStep(step) || isLegacySystemAdminAckStep(step);
}

/** Number of approval rungs a request of this requester role will have. */
export function directOrderExpectedStepCount(requesterRole: PhoenixRole): number {
  return directOrderExpectedRoleChain(requesterRole).length;
}

// ── Bonus & discount caps (config-driven; percentages 0–100) ─────────────────
// Cap PERCENTAGES live in the DB (`direct_order_caps`, editable by Super Admin);
// these pure helpers just apply a supplied cap. The default seed is 25% bonus /
// 25% discount with an Ivyronc (IV001) bonus override of 30% — all changeable in UI.

/** Max bonus units allowed for a qty at a given cap percentage (floored to a whole unit). */
export function maxBonusUnits(input: { qty: number; capPct: number }): number {
  const qty = Math.max(0, Math.floor(Number(input.qty) || 0));
  const pct = Math.max(0, Number(input.capPct) || 0);
  return Math.floor((qty * pct) / 100);
}

export type BonusValidation = { withinCap: boolean; maxBonus: number; capPct: number };

export function validateBonus(input: { qty: number; bonus: number; capPct: number }): BonusValidation {
  const maxBonus = maxBonusUnits(input);
  const bonus = Math.max(0, Math.floor(Number(input.bonus) || 0));
  return { withinCap: bonus <= maxBonus, maxBonus, capPct: Number(input.capPct) || 0 };
}

export type DiscountValidation = { withinCap: boolean; capPct: number };

export function validateDiscount(input: { discountPct: number; capPct: number }): DiscountValidation {
  const disc = Math.max(0, Number(input.discountPct) || 0);
  return { withinCap: disc <= (Number(input.capPct) || 0), capPct: Number(input.capPct) || 0 };
}

// ── Sales value ───────────────────────────────────────────────────────────────

/**
 * Bonus-mode: value = qty × PHARMACY price, 2dp. Bonus units are NEVER counted.
 *
 * The parameter is deliberately RENAMED from `factoryPrice` rather than given a new meaning:
 * renaming breaks compilation at every call site, so `pnpm typecheck` enumerates them. On a
 * money change that is the feature — a back-compat signature accepting either key would let a
 * missed caller keep compiling while silently pricing on the wrong basis.
 *
 * Falling back to the factory price when a product has no pharmacy price yet belongs to the
 * CALLER (which also flags the fallback), not to this pure helper.
 */
export function computeDirectOrderSalesValue(input: { qty: number; pharmacyPrice: number }): number {
  const qty = Math.max(0, Number(input.qty) || 0);
  const price = Math.max(0, Number(input.pharmacyPrice) || 0);
  return Math.round(qty * price * 100) / 100;
}

/** Discount-mode: value = qty × PUBLIC price × (1 − discount%/100), 2dp. No bonus. */
export function computeDiscountSalesValue(input: { qty: number; publicPrice: number; discountPct: number }): number {
  const qty = Math.max(0, Number(input.qty) || 0);
  const price = Math.max(0, Number(input.publicPrice) || 0);
  const disc = Math.min(100, Math.max(0, Number(input.discountPct) || 0));
  return Math.round(qty * price * (1 - disc / 100) * 100) / 100;
}

// ── Sequential chain evaluation ───────────────────────────────────────────────

function sortSteps(steps: DirectOrderStepState[]): DirectOrderStepState[] {
  return [...steps].sort((a, b) => a.order - b.order);
}

/** The actionable rung: the lowest-order still-pending step, or null when none pending. */
export function resolveActiveStep(steps: DirectOrderStepState[]): DirectOrderStepState | null {
  return sortSteps(steps).find((step) => step.status === "pending") ?? null;
}

export function isCeoStep(step: Pick<DirectOrderStepState, "kind" | "role">): boolean {
  return step.kind === "role" && step.role === CEO_ROLE;
}

export type DirectOrderStepEvaluation = {
  allowed: boolean;
  reason: string | null;
  nextStatus: DirectOrderStatus;
  isFinal: boolean;
};

/**
 * Decide whether the rung at `actorOrder` may take `decision` now, and the resulting
 * request status. A rung is actionable only after every lower-order rung is approved;
 * approving the last rung finalizes as `approved`.
 */
export function evaluateStepAction(input: {
  steps: DirectOrderStepState[];
  actorOrder: number;
  decision: DirectOrderDecision;
}): DirectOrderStepEvaluation {
  const sorted = sortSteps(input.steps);
  const actor = sorted.find((step) => step.order === input.actorOrder);
  if (!actor) {
    return { allowed: false, reason: "You are not an approver on this request.", nextStatus: "pending_approval", isFinal: false };
  }
  if (actor.status !== "pending") {
    return { allowed: false, reason: "This step has already been decided.", nextStatus: "pending_approval", isFinal: false };
  }
  const blockedByPrior = sorted.some((step) => step.order < actor.order && step.status !== "approved");
  if (blockedByPrior) {
    return { allowed: false, reason: "Waiting for the previous approver to decide.", nextStatus: "pending_approval", isFinal: false };
  }

  if (input.decision === "return") {
    return { allowed: true, reason: null, nextStatus: "returned", isFinal: false };
  }
  if (input.decision === "reject") {
    return { allowed: true, reason: null, nextStatus: "rejected", isFinal: true };
  }

  // approve
  const laterPending = sorted.some((step) => step.order > actor.order && step.status === "pending");
  if (laterPending) {
    return { allowed: true, reason: null, nextStatus: "pending_approval", isFinal: false };
  }
  return { allowed: true, reason: null, nextStatus: "approved", isFinal: true };
}

export type DirectOrderActionAvailability = {
  approve: { enabled: boolean; disabledReason: string | null };
  reject: { enabled: boolean; disabledReason: string | null };
  return: { enabled: boolean; disabledReason: string | null };
};

const NOT_YOUR_STEP = "Only the current approver can act on this request.";

/**
 * Per-button availability for the Action Center / Approvals Hub. `actorOrder` is the
 * caller's own rung (null if they are not an assigned approver of a pending step).
 */
export function resolveActionAvailability(input: {
  status: DirectOrderStatus;
  steps: DirectOrderStepState[];
  actorOrder: number | null;
}): DirectOrderActionAvailability {
  const disabled = (reason: string) => ({
    approve: { enabled: false, disabledReason: reason },
    reject: { enabled: false, disabledReason: reason },
    return: { enabled: false, disabledReason: reason },
  });

  if (input.status === "returned") return disabled("Waiting for the requester to resubmit.");
  if (input.status === "approved" || input.status === "rejected" || input.status === "reversed") {
    return disabled("This request is already closed.");
  }
  if (input.actorOrder == null) return disabled(NOT_YOUR_STEP);

  const evalApprove = evaluateStepAction({ steps: input.steps, actorOrder: input.actorOrder, decision: "approve" });
  const enabled = evalApprove.allowed;
  const reason = evalApprove.reason ?? NOT_YOUR_STEP;
  return {
    approve: enabled ? { enabled: true, disabledReason: null } : { enabled: false, disabledReason: reason },
    reject: enabled ? { enabled: true, disabledReason: null } : { enabled: false, disabledReason: reason },
    return: enabled ? { enabled: true, disabledReason: null } : { enabled: false, disabledReason: reason },
  };
}
