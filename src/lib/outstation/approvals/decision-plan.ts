/**
 * One press on the desk, turned into the decision the outstation workflow is asked to apply — and
 * the answer the page gets back.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"; a press "saves at once, with Undo"). Pure: no
 * database, no session. `decide.ts` reads the claim as it stands NOW, hands it here, and sends the
 * record this returns to `applyOutstationRequestExpenseDecisions` — the one function that already
 * approves, rejects and trims a claim. Nothing about moving the money is decided in this file.
 *
 * What this file DOES decide is what is refused before anything is written:
 *
 *   - a claim a payroll already took;
 *   - 🔴 a claim that is ALREADY DECIDED. The desk decides what waits and nothing else: an approved
 *     or rejected claim is read here, never pressed again (owner's plan, 23 Nov: "No decided claim's
 *     money moves"). The screen draws no button for one; this is the refusal behind the screen;
 *   - a press made on an older version of the claim (the row comes back with its new figures);
 *   - a rejection or a reduced amount with no reason;
 *   - "Approve EGP 300" whose idle-day cut no longer holds, because a visit was recorded since;
 *   - 🔴 a plain Approve on a trip where the server NOW finds an idle-day cut the press did not
 *     name. Paying an idle day in full is "Keep full claim", said out loud (`keepFull`), never
 *     the silence of a page that was read before the field work was;
 *   - 🔴 a reduced amount on a trip the payroll gate would HOLD. A held trip has no payroll row,
 *     and the payable figure lives on that row — the old screen approved the trip, lost the figure
 *     and said so afterwards, and the trip later paid in full. Refused here, in words, instead.
 */

import { isAdjustedAmount } from "@/lib/outstation/approval-state";
import { OUTSTATION_CLAIM_CHANGED_CODE, OUTSTATION_CLAIM_CHANGED_MESSAGE } from "@/lib/outstation/claim-revision";
import type { DecisionAction, DeskClaim, DeskDecisionOutcome, DeskDecisionRequest } from "@/lib/outstation/approvals/types";

/** The shape `applyOutstationRequestExpenseDecisions` reads for one claim. */
export type DeskDecisionRecord = {
  approvedAmount: number;
  hrApproved: boolean;
  hrComment: string;
  requestRevision: string;
  status: "Approved" | "Rejected";
  total: number;
  tripId: string;
};

export type PlannedDeskDecision =
  | {
      /** What he approved: the claim, the reduced amount, or null on a rejection. */
      approved: number | null;
      ok: true;
      record: DeskDecisionRecord;
    }
  | { code: "changed" | "refused"; message: string; ok: false };

export const DESK_REFUSAL = {
  cutMoved: "The field work on this trip changed since you opened it, so the amount on the button no longer holds. Look at it again.",
  decided: "This claim was already decided, so it cannot be changed here.",
  gone: "This claim is not on your list any more.",
  idleDayFound: "This trip now shows a day with no field work, which was not on your screen when you approved it. Look at it again.",
  keepFullAlone: "A trip that pays an idle day in full is approved by itself, never in a batch. Open it and decide it there.",
  heldCannotReduce:
    "This trip would be held out of payroll for now, and a held trip cannot carry a reduced amount — it would pay in full when it is released. Approve it in full, or reduce it once it reaches payroll.",
  locked: "A payroll has already taken this trip, so it cannot be changed here.",
  noAmount: "Type the amount to pay. To pay nothing, reject the claim.",
  noReduceReason: "A reduced amount needs a reason.",
  noRejectReason: "A rejection needs a reason.",
  notSaved: "The decision was not saved. Nothing changed.",
} as const;

const egp = (value: number) => `EGP ${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const money = (value: number) => Math.round(value * 100) / 100;
const refused = (message: string): PlannedDeskDecision => ({ code: "refused", message, ok: false });

/** True when a reduced amount could not be kept: the trip would have no payroll row to carry it. */
function wouldLoseAmount(claim: DeskClaim): boolean {
  return claim.holdReason !== null;
}

export function planDeskDecision(claim: DeskClaim | null | undefined, decision: DeskDecisionRequest): PlannedDeskDecision {
  if (!claim) return refused(DESK_REFUSAL.gone);
  if (claim.locked) return refused(DESK_REFUSAL.locked);
  // Before the version check on purpose: no version of a decided claim can be pressed.
  if (claim.standing !== "waiting") return refused(DESK_REFUSAL.decided);
  if (!decision.revision || decision.revision !== claim.revision) {
    return { code: "changed", message: OUTSTATION_CLAIM_CHANGED_MESSAGE, ok: false };
  }

  const comment = String(decision.comment ?? "").trim();
  const base = { requestRevision: claim.revision, total: claim.total, tripId: claim.tripId };

  if (decision.action === "reject") {
    if (!comment) return refused(DESK_REFUSAL.noRejectReason);
    return {
      approved: null,
      ok: true,
      record: { ...base, approvedAmount: claim.total, hrApproved: false, hrComment: comment, status: "Rejected" },
    };
  }

  if (decision.action === "reduce") {
    const amount = money(Number(decision.approvedAmount));
    if (decision.approvedAmount === null || decision.approvedAmount === undefined || !Number.isFinite(amount) || amount <= 0) {
      return refused(DESK_REFUSAL.noAmount);
    }
    // The workflow reads a figure within half a pound of the claim as the claim itself.
    if (amount > claim.total || !isAdjustedAmount(amount, claim.total)) {
      return refused(`A reduced amount must be lower than the claim (${egp(claim.total)}). To pay it in full, approve it.`);
    }
    if (!comment) return refused(DESK_REFUSAL.noReduceReason);
    if (wouldLoseAmount(claim)) return refused(DESK_REFUSAL.heldCannotReduce);
    return {
      approved: amount,
      ok: true,
      record: { ...base, approvedAmount: amount, hrApproved: true, hrComment: comment, status: "Approved" },
    };
  }

  // Approve. With an amount, it is the idle-day cut the button named — paid only while the server's
  // own reading of the trip still gives that figure.
  const cut = claim.preCut;
  const cutPays = cut && isAdjustedAmount(cut.payable, claim.total) ? cut : null;
  if (decision.approvedAmount !== null && decision.approvedAmount !== undefined) {
    if (!cut || Math.abs(cut.payable - Number(decision.approvedAmount)) > 0.005) {
      return { code: "changed", message: DESK_REFUSAL.cutMoved, ok: false };
    }
    if (cutPays) {
      if (wouldLoseAmount(claim)) return refused(DESK_REFUSAL.heldCannotReduce);
      return {
        approved: cutPays.payable,
        ok: true,
        record: { ...base, approvedAmount: cutPays.payable, hrApproved: true, hrComment: comment || cutPays.reason, status: "Approved" },
      };
    }
  } else if (cutPays && decision.keepFull !== true) {
    // No amount and no "keep full": the page that sent this saw no idle day, and the server does.
    // The claim goes back to the list with its cut on the button; nothing is paid on a stale reading.
    return { code: "changed", message: DESK_REFUSAL.idleDayFound, ok: false };
  }
  return {
    approved: claim.total,
    ok: true,
    record: { ...base, approvedAmount: claim.total, hrApproved: true, hrComment: comment, status: "Approved" },
  };
}

function sentence(value: string): string {
  const clean = value.trim();
  if (!clean) return clean;
  const first = clean.charAt(0).toUpperCase() + clean.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** Did the claim end in the STATE the press meant? Read from the claim as stored AFTER the write. */
export function decisionLanded(action: DecisionAction, after: DeskClaim | null | undefined): boolean {
  if (!after) return false;
  if (action === "reject") return after.standing === "rejected";
  return after.standing === "approved_held" || after.standing === "approved_queued" || after.standing === "in_payroll";
}

/**
 * Does an approved claim stand at the FIGURE the press chose? `approved` is what the plan sent: the
 * claim in full, or a lower amount. In full means no typed amount is stored; a lower amount means
 * exactly that amount is. An approval is two writes (the claim, then its figure), so the state can
 * land while the figure does not — and a claim that pays more than he chose is not "saved".
 */
export function amountLanded(approved: number | null, after: DeskClaim | null | undefined): boolean {
  if (!after || approved === null) return false;
  if (!isAdjustedAmount(approved, after.total)) return after.approvedAmount === null;
  return after.approvedAmount !== null && Math.abs(after.approvedAmount - approved) <= 0.005;
}

/**
 * The answer for one press. The claim as stored afterwards is the proof, never the write's own
 * count: a decision is "saved" only when the claim now stands where the press put it — in the state
 * AND at the figure. `skipped` is what the workflow said about this claim, when it said anything — on
 * a claim that did land it is a caution worth showing (an approval that is held), on one that did
 * not it is the reason.
 *
 * 🔴 "The claim changed" is read FIRST. A press the workflow refused as stale did nothing, even when
 * the claim now reads approved — somebody else's press put it there (two tabs), and answering
 * "saved" would tell him his own figure landed when it did not.
 */
export function deskDecisionOutcome(input: {
  action: DecisionAction;
  after: DeskClaim | null;
  /** What the plan sent: the claim in full, a lower amount, or null on a rejection. */
  approved: number | null;
  requestId: number;
  skipped?: { code?: string; reason: string } | null;
}): DeskDecisionOutcome {
  const { action, after, approved, requestId, skipped } = input;
  if (skipped?.code === OUTSTATION_CLAIM_CHANGED_CODE) {
    return { claim: after, code: "changed", message: sentence(skipped.reason), requestId };
  }
  if (decisionLanded(action, after)) {
    const held = after?.standing === "approved_held";
    if (action !== "reject" && after && !amountLanded(approved, after)) {
      return {
        claim: after,
        code: "amount_not_saved",
        message: `Approved, but NOT at ${egp(approved ?? after.total)}: that amount was not saved. As it stands this trip pays ${egp(after.payable)}${held ? " when it is released from its hold" : ""}.`,
        requestId,
      };
    }
    return {
      claim: after,
      code: "saved",
      message: skipped ? sentence(skipped.reason) : held ? "Approved. Held out of payroll until its photos and workload land." : null,
      requestId,
    };
  }
  return { claim: after, code: "refused", message: skipped ? sentence(skipped.reason) : DESK_REFUSAL.notSaved, requestId };
}
