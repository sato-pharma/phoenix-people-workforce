import { conflictError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { DisputeCaseKind } from "./types.ts";

// ONE DECISION AT A TIME, AND A DECISION THAT FAILS HALF-WAY IS PUT BACK (F-PAY-005, 2026-11-13).
//
// A deduction dispute's decision is several writes — the payslip line off, the decision, the smaller
// figure back on, a refund recommended or cancelled — and only then the "decided" event. Before this,
// the "already decided" gate was a plain read in front of all of them, so two decides of one case both
// passed it, and a failure after the money moved but before the event left the case reading open while
// payroll already charged the new figure.
//
// Now the decision CLAIMS the case in one statement before it writes anything
// (phx_claim_dispute_case_decision, migration 20261113162318), re-checks "already decided" under the
// claim, captures the before-state of everything it may touch, and on any failure after its first
// write puts all of it back in one transaction (phx_restore_deduction_dispute_state) before the claim
// is released. Where even that fails, the case is marked "needs attention" in its own timeline.

/** How long a claim left by a request that died holds the case. The migration carries the same figure. */
export const DISPUTE_DECISION_CLAIM_LAPSE_MINUTES = 5;

/** The before-state of a deduction dispute decision, exactly as phx_capture_deduction_dispute_state reads it. */
export type DeductionDisputeSnapshot = {
  candidateId: string;
  monthKey: string | null;
  lockedAt: string | null;
  decision: Record<string, unknown> | null;
  lines: Array<Record<string, unknown>>;
  publicationIds: string[];
  refunds: Array<Record<string, unknown>>;
};

/**
 * The claim is no longer this decision's: it lapsed and another decision took it over. Stamping,
 * renewing and releasing by token touch no row then, and that is never taken as success.
 */
export const DISPUTE_DECISION_CLAIM_LOST =
  "This dispute was taken over by another decision while this one was still running (its hold had lapsed). Nothing more was written by this one. Reload the dispute and read what was decided.";

function claimLost(): Error {
  return conflictError(DISPUTE_DECISION_CLAIM_LOST, "claim_lost");
}

export type DisputeDecisionClaim =
  | {
      held: true;
      token: string;
      /** A lapsed claim that never released and had captured a before-state: a decision that died. */
      interrupted: { claimedAt: string | null; snapshot: DeductionDisputeSnapshot | null } | null;
    }
  | { held: false; claimedAt: string | null };

export async function claimDisputeDecision(input: {
  kind: DisputeCaseKind;
  ref: string;
  claimedBy: string | null;
}): Promise<DisputeDecisionClaim> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_claim_dispute_case_decision", {
    p_case_kind: input.kind,
    p_case_ref: input.ref,
    p_claimed_by: input.claimedBy,
  });
  if (error) throw new Error(`Could not start the decision: ${error.message}`);
  const row = (data ?? {}) as {
    claimedAt?: string | null;
    interrupted?: { claimedAt?: string | null; snapshot?: DeductionDisputeSnapshot | null } | null;
    token?: string | null;
  };
  if (!row.token) return { claimedAt: row.claimedAt ?? null, held: false };
  return {
    held: true,
    interrupted: row.interrupted
      ? { claimedAt: row.interrupted.claimedAt ?? null, snapshot: row.interrupted.snapshot ?? null }
      : null,
    token: row.token,
  };
}

/** Keep the before-state on the claim, so a decision that dies after this point is known to have died. */
export async function stampDisputeDecisionSnapshot(input: {
  kind: DisputeCaseKind;
  ref: string;
  token: string;
  snapshot: DeductionDisputeSnapshot;
}): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_case_decision_claims")
    .update({ snapshot: input.snapshot })
    .eq("case_kind", input.kind)
    .eq("case_ref", input.ref)
    .eq("claim_token", input.token)
    .select("case_ref");
  if (error) throw new Error(`Could not record the deduction's state before the decision: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw claimLost();
}

/**
 * Prove the claim is still this decision's, and renew it, in one statement — immediately before the
 * decision's last write. Throws the claim-lost Conflict when another decision has taken it over.
 */
export async function renewDisputeDecision(input: { kind: DisputeCaseKind; ref: string; token: string }): Promise<void> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_renew_dispute_case_decision", {
    p_case_kind: input.kind,
    p_case_ref: input.ref,
    p_claim_token: input.token,
  });
  if (error) throw new Error(`Could not confirm the decision claim: ${error.message}`);
  if (data !== true) throw claimLost();
}

/** Release the claim — only this decision's own, by its token. Throws when it was no longer held. */
export async function releaseDisputeDecision(input: { kind: DisputeCaseKind; ref: string; token: string }): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("dispute_case_decision_claims")
    .delete()
    .eq("case_kind", input.kind)
    .eq("case_ref", input.ref)
    .eq("claim_token", input.token)
    .select("case_ref");
  if (error) throw new Error(`Could not release the decision claim: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw claimLost();
}

export async function captureDeductionDisputeState(candidateId: string): Promise<DeductionDisputeSnapshot> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_capture_deduction_dispute_state", {
    p_candidate_id: candidateId,
  });
  if (error) throw new Error(`Could not read the deduction's state before the decision: ${error.message}`);
  if (!data) throw new Error("Not found: that deduction no longer exists.");
  return data as DeductionDisputeSnapshot;
}

/** The undo refused because somebody else changed these rows after this decision wrote them. */
export class DisputeUndoConflictError extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(`changed by somebody else since this decision wrote them, so they were left as they are: ${conflicts.join(", ")}`);
    this.name = "DisputeUndoConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * Put back what THIS attempt changed, in one transaction — `snapshot` is the before-state, `left` the
 * state this attempt left after its last successful write. A row is put back only while it still equals
 * what this attempt left; if any was changed by somebody else since, nothing is written and this throws
 * DisputeUndoConflictError naming them. Throws on any other failure too.
 */
export async function restoreDeductionDisputeState(input: {
  snapshot: DeductionDisputeSnapshot;
  left: DeductionDisputeSnapshot;
  actor: string | null;
}): Promise<{ publicationsLeftEmpty: string[] }> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_restore_deduction_dispute_state", {
    p_actor: input.actor,
    p_left: input.left,
    p_snapshot: input.snapshot,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as { conflicts?: string[] | null; publicationsLeftEmpty?: string[] | null; restored?: boolean };
  if (row.restored !== true) {
    throw new DisputeUndoConflictError(Array.isArray(row.conflicts) && row.conflicts.length ? row.conflicts : ["(not named)"]);
  }
  return { publicationsLeftEmpty: Array.isArray(row.publicationsLeftEmpty) ? row.publicationsLeftEmpty : [] };
}
