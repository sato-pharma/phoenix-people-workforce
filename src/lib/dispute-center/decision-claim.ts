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
  const { error } = await getSupabaseAdmin()
    .from("dispute_case_decision_claims")
    .update({ snapshot: input.snapshot })
    .eq("case_kind", input.kind)
    .eq("case_ref", input.ref)
    .eq("claim_token", input.token);
  if (error) throw new Error(`Could not record the deduction's state before the decision: ${error.message}`);
}

/** Release the claim — only this decision's own, by its token. */
export async function releaseDisputeDecision(input: { kind: DisputeCaseKind; ref: string; token: string }): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("dispute_case_decision_claims")
    .delete()
    .eq("case_kind", input.kind)
    .eq("case_ref", input.ref)
    .eq("claim_token", input.token);
  if (error) throw new Error(`Could not release the decision claim: ${error.message}`);
}

export async function captureDeductionDisputeState(candidateId: string): Promise<DeductionDisputeSnapshot> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_capture_deduction_dispute_state", {
    p_candidate_id: candidateId,
  });
  if (error) throw new Error(`Could not read the deduction's state before the decision: ${error.message}`);
  if (!data) throw new Error("Not found: that deduction no longer exists.");
  return data as DeductionDisputeSnapshot;
}

/** Put the before-state back, in one transaction. Throws when it could not. */
export async function restoreDeductionDisputeState(input: {
  snapshot: DeductionDisputeSnapshot;
  actor: string | null;
}): Promise<{ publicationsLeftEmpty: string[] }> {
  const { data, error } = await getSupabaseAdmin().rpc("phx_restore_deduction_dispute_state", {
    p_actor: input.actor,
    p_snapshot: input.snapshot,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as { publicationsLeftEmpty?: string[] | null };
  return { publicationsLeftEmpty: Array.isArray(row.publicationsLeftEmpty) ? row.publicationsLeftEmpty : [] };
}
