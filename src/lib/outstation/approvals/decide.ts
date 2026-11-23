/**
 * Applies the desk's decisions — one press, or the whole Ready lane — and answers with each claim
 * as it stands afterwards.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"; "Save at once, with Undo"). Four steps:
 *
 *   1. read every claim as it stands NOW, with its checks (`loadDeskClaims`) — the press was made
 *      on a screen that can be minutes old;
 *   2. plan each press (`planDeskDecision`) — what is refused is refused before anything is written;
 *   3. hand the rest to `applyOutstationRequestExpenseDecisions`, the one function that approves,
 *      rejects and trims a claim: the payroll write in one database step, the version check, the
 *      evidence gate, the in-payroll lock, the audit row and the employee's notice are all inherited;
 *   4. read the claims again. An approval is two writes (the claim, then its figure): where the
 *      claim reached the next payroll and its figure did not, the SAME press is sent once more, and
 *      only then answered. A claim that still does not stand at his figure is never called saved;
 *   5. keep the system's verdict on each claim whose decision landed whole.
 *
 * 🔴 Only a WAITING claim is decided here. A decided claim is refused in the plan, whatever the
 *    press says (owner's plan, 23 Nov: "No decided claim's money moves").
 *
 * 🔴 A request that decides more than one claim never carries "keep the full claim": a batch cannot
 *    pay an idle day in full, and that is refused here on the server, not only left out by the page.
 *
 * 🔴 Step 5 writes two columns and nothing else. It never touches `updated_at` (the claim's version
 *    token), never a status and never an amount; a claim already stamped is not stamped again; and a
 *    stamp that fails is logged and costs nothing — the decision has already landed.
 *
 * The Undo is not here: it is six seconds in the browser before the press is sent at all. Nothing
 * on the server reverses a decision.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { assertRealSessionForDecision } from "@/lib/auth/preview-session-guard";
import { afterResponse } from "@/lib/http/after-response";
import { logError } from "@/lib/observability/log";
import { verdictStamp } from "@/lib/outstation/approvals/agreement";
import { DESK_DECISION_LIMIT } from "@/lib/outstation/approvals/decision-body";
import { amountLanded, DESK_REFUSAL, deskDecisionOutcome, planDeskDecision, type PlannedDeskDecision } from "@/lib/outstation/approvals/decision-plan";
import { loadDeskClaims } from "@/lib/outstation/approvals/queue";
import type { DeskClaim, DeskDecisionOutcome, DeskDecisionRequest } from "@/lib/outstation/approvals/types";
import { OUTSTATION_CLAIM_CHANGED_CODE } from "@/lib/outstation/claim-revision";
import { expenseClaimsReadEnabled } from "@/lib/outstation/claims-read-flag";
import { refreshExpenseClaims } from "@/lib/outstation/claims-refresh";
import { applyOutstationRequestExpenseDecisions } from "@/lib/outstation/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Planned = { claim: DeskClaim | null; decision: DeskDecisionRequest; plan: PlannedDeskDecision };
type Sent = Planned & { plan: Extract<PlannedDeskDecision, { ok: true }> };

async function keepVerdict(input: { approved: number | null; at: string; before: DeskClaim; decision: DeskDecisionRequest }): Promise<DeskClaim["verdict"] | null> {
  const { lane, stamp } = verdictStamp({
    action: input.decision.action,
    approved: input.approved,
    at: input.at,
    claimed: input.before.total,
    verdict: input.before.verdict,
  });
  const { error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({ system_lane_at_decision: lane, system_verdict_at_decision: stamp })
    .eq("id", input.before.requestId)
    .is("system_lane_at_decision", null);
  if (error) {
    logError("The system's verdict was not kept with an expense decision", {
      labels: { event: "expense_desk_verdict_stamp_failed", requestId: String(input.before.requestId) },
      error: new Error(error.message),
    });
    return null;
  }
  return { checks: input.before.verdict.checks, idleDates: [], lane, reason: lane === "ready" ? null : input.before.verdict.reason };
}

export async function decideDeskClaims(
  access: AccessContext,
  decisions: ReadonlyArray<DeskDecisionRequest>,
  now: Date = new Date(),
): Promise<DeskDecisionOutcome[]> {
  assertRealSessionForDecision(access, "decide an expense claim");
  if (decisions.length > DESK_DECISION_LIMIT) {
    throw new Error(`At most ${DESK_DECISION_LIMIT} claims can be decided in one request.`);
  }

  // One press per claim: a second one for the same claim in the same request is not applied.
  const seen = new Set<number>();
  const presses: DeskDecisionRequest[] = [];
  for (const decision of decisions) {
    if (seen.has(decision.requestId)) continue;
    seen.add(decision.requestId);
    presses.push(decision);
  }

  const before = await loadDeskClaims(access, presses.map((decision) => decision.requestId), now);
  const batch = presses.length > 1;
  const keepFullInBatch: PlannedDeskDecision = { code: "refused", message: DESK_REFUSAL.keepFullAlone, ok: false };
  const planned: Planned[] = presses.map((decision) => ({
    claim: before.get(decision.requestId) ?? null,
    decision,
    plan: batch && decision.keepFull === true ? keepFullInBatch : planDeskDecision(before.get(decision.requestId), decision),
  }));

  const sent = planned.filter((entry): entry is Sent => entry.plan.ok);
  const result =
    sent.length > 0
      ? await applyOutstationRequestExpenseDecisions({
          access,
          entries: sent.map((entry) => ({ record: entry.plan.record, requestId: entry.decision.requestId })),
        })
      : { applied: 0, skipped: [] };
  const skippedByTrip = new Map(result.skipped.map((skip) => [skip.tripId, skip]));

  const after = sent.length > 0 ? await loadDeskClaims(access, sent.map((entry) => entry.decision.requestId), now) : new Map<number, DeskClaim>();

  // An approval is two writes: the claim into payroll, then its figure. Where THIS press put the claim
  // into the next payroll and the figure did not follow, the same press is sent once more, on the
  // version the claim has now. Never for a press the workflow refused as stale: that claim was put
  // where it is by somebody else's press, and it is theirs.
  const unfinished = sent.filter((entry) => {
    const stored = after.get(entry.decision.requestId);
    if (entry.decision.action === "reject" || !entry.claim || stored?.standing !== "approved_queued") return false;
    if (skippedByTrip.get(entry.claim.tripId)?.code === OUTSTATION_CLAIM_CHANGED_CODE) return false;
    return !amountLanded(entry.plan.approved, stored);
  });
  if (unfinished.length > 0) {
    logError("An expense approval's amount did not land with its claim, so the desk sent it again", {
      labels: { event: "expense_desk_amount_resent", requestIds: unfinished.map((entry) => String(entry.decision.requestId)).join(",") },
      error: new Error("approved, but the stored amount is not the one chosen"),
    });
    const again = await applyOutstationRequestExpenseDecisions({
      access,
      entries: unfinished.map((entry) => ({
        record: { ...entry.plan.record, requestRevision: after.get(entry.decision.requestId)?.revision ?? entry.plan.record.requestRevision },
        requestId: entry.decision.requestId,
      })),
    });
    for (const skip of again.skipped) skippedByTrip.set(skip.tripId, skip);
    const reread = await loadDeskClaims(access, unfinished.map((entry) => entry.decision.requestId), now);
    for (const [requestId, stored] of reread) after.set(requestId, stored);
  }

  const outcomes: DeskDecisionOutcome[] = [];
  for (const entry of planned) {
    const { claim, decision, plan } = entry;
    if (!plan.ok) {
      outcomes.push({ claim, code: plan.code, message: plan.message, requestId: decision.requestId });
      continue;
    }
    const stored = after.get(decision.requestId) ?? null;
    const outcome = deskDecisionOutcome({
      action: decision.action,
      after: stored,
      approved: plan.approved,
      requestId: decision.requestId,
      skipped: claim ? (skippedByTrip.get(claim.tripId) ?? null) : null,
    });
    // The verdict is kept once, and only with a decision that landed whole: in the state and at the
    // figure. One that did not is left out of the agreement meter rather than recorded wrongly.
    if (claim && stored && outcome.code === "saved") {
      const verdict = await keepVerdict({ approved: plan.approved, at: now.toISOString(), before: claim, decision });
      if (verdict) outcome.claim = { ...stored, verdict };
    }
    outcomes.push(outcome);
  }

  // Every other expense screen still reads the `expense_claims` mirror, which otherwise shows these
  // decisions only after its next scheduled rebuild. Idempotent, under a second, and never part of
  // the answer: the decisions are already committed and the schedule remains the backstop.
  if (result.applied > 0 && expenseClaimsReadEnabled()) {
    await afterResponse("expense_claims_refresh:desk_decision", async () => {
      const refresh = await refreshExpenseClaims();
      if (refresh.status === "blocked") {
        logError("Expense claims refresh after a desk decision was refused by an interlock", {
          labels: { event: "expense_claims_refresh_after_save_blocked" },
          error: new Error(refresh.reason),
        });
      }
    });
  }

  return outcomes;
}
