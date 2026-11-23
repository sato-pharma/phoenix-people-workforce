"use client";

import { Check, Eye, Scale, X } from "lucide-react";
import { useId, useState } from "react";

import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { CrmField, crmInputClassName, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { DESK_WORDS, approvePress, reasonChips, reduceBlocked, typedAmount } from "@/lib/outstation/approvals/desk-view";
import type { DeskClaim, DeskDecisionRequest } from "@/lib/outstation/approvals/types";
import { cn } from "@/lib/utils";

import { egp } from "./desk-parts";
import { RewriteFormally, noteFacts } from "./desk-rewrite";

/**
 * The decision, on the row — one vocabulary, drawn once and used by the list, the phone card and the
 * reviewer, so there is never a second way to decide.
 *
 *   Approve   one press. On a trip with idle days the button NAMES what it pays ("Approve EGP 300")
 *             and "Keep full claim" sits beside it — the idle-day cut is one press, not a form.
 *   Reject    two presses: Reject, then the reason. The reasons offered are sentences built from a
 *             check that failed on THIS claim; where none failed, the reason is typed.
 *   Reduce    the amount and its reason, then one press. Not offered on a trip the payroll gate
 *             would hold, and the button says why.
 *
 * 🔴 Only a WAITING claim is decided. A claim already approved or rejected draws no decision button
 * anywhere on the desk — History and its opened trip read it and nothing more — and the server
 * refuses a press on one (decision-plan.ts).
 *
 * A press is handed to `onPress` and nothing else happens here: the six seconds of Undo and the
 * request live in use-desk.ts. The reason box always opens EMPTY — the system's own sentence is a
 * one-press insert, never a pre-filled reason the employee is then sent.
 */

export type DecisionMode = "idle" | "reduce" | "reject";
export type OnPress = (decisions: DeskDecisionRequest[], claims: DeskClaim[]) => void;

export function DecisionButtons({
  canDecide,
  claim,
  everyAction = false,
  mode,
  onMode,
  onOpen,
  onPress,
  size = "dense",
}: {
  canDecide: boolean;
  claim: DeskClaim;
  /** The reviewer offers Reduce beside the idle-day cut too; a list row keeps to what fits. */
  everyAction?: boolean;
  mode: DecisionMode;
  onMode: (mode: DecisionMode) => void;
  /** Omitted inside the reviewer, where the trip is already open. */
  onOpen?: () => void;
  onPress: OnPress;
  size?: "dense" | "regular";
}) {
  const acts = canDecide && !claim.locked && claim.standing === "waiting";
  const cut = claim.preCut && !claim.holdReason ? claim.preCut : null;
  const blocked = reduceBlocked(claim);
  const toggle = (next: DecisionMode) => onMode(mode === next ? "idle" : next);

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5" data-decision-buttons>
      {acts ? (
        <button
          className={approvalActionClassName("approve", size)}
          data-press="approve"
          onClick={() => onPress([approvePress(claim)], [claim])}
          title={cut ? cut.reason : undefined}
          type="button"
        >
          <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {cut ? `${DESK_WORDS.approve} ${egp(cut.payable)}` : DESK_WORDS.approve}
        </button>
      ) : null}
      {acts && cut ? (
        <button className={approvalActionClassName("neutral", size)} data-press="keep-full" onClick={() => onPress([approvePress(claim, { full: true })], [claim])} type="button">
          {DESK_WORDS.keepFull}
        </button>
      ) : null}
      {acts && (!cut || everyAction) ? (
        <button
          aria-expanded={mode === "reduce"}
          className={approvalActionClassName("neutral", size)}
          data-press="reduce"
          disabled={blocked !== null}
          onClick={() => toggle("reduce")}
          title={blocked ?? undefined}
          type="button"
        >
          <Scale aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {DESK_WORDS.reduce}
        </button>
      ) : null}
      {acts ? (
        <button aria-expanded={mode === "reject"} className={approvalActionClassName("reject", size)} data-press="reject" onClick={() => toggle("reject")} type="button">
          <X aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {DESK_WORDS.reject}
        </button>
      ) : null}
      {onOpen ? (
        <button className={approvalActionClassName("neutral", size)} data-open-trip onClick={onOpen} type="button">
          <Eye aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {DESK_WORDS.open}
        </button>
      ) : null}
    </div>
  );
}

/** The second press of a rejection or a reduced amount. Mounted only while one is open. */
export function DecisionPanel({
  claim,
  mode,
  onClose,
  onPress,
  size = "regular",
}: {
  claim: DeskClaim;
  mode: Exclude<DecisionMode, "idle">;
  onClose: () => void;
  onPress: OnPress;
  /** `dense` inside a table row (flat, no lift); `regular` on a phone card and in the opened trip. */
  size?: "dense" | "regular";
}) {
  const id = useId();
  const chips = reasonChips(claim);
  const cut = claim.standing === "waiting" ? claim.preCut : null;
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(() => (mode === "reduce" && cut ? String(cut.payable) : ""));
  const figure = typedAmount(amount);
  const tooHigh = figure !== null && figure >= claim.total;
  const text = reason.trim();

  const send = (comment: string) => {
    const base = { comment, requestId: claim.requestId, revision: claim.revision };
    onPress([mode === "reject" ? { ...base, action: "reject" } : { ...base, action: "reduce", approvedAmount: figure }], [claim]);
    onClose();
  };

  return (
    <div className="grid min-w-0 gap-3 border border-slate-200 bg-slate-50 px-3 py-3" data-decision-panel={mode}>
      {mode === "reduce" ? (
        <CrmField
          error={tooHigh ? `Lower than the claim (${egp(claim.total)}). To pay it in full, approve it.` : undefined}
          hint={`The claim is ${egp(claim.total)}.`}
          htmlFor={`${id}-amount`}
          label="Amount to pay (EGP)"
        >
          <input
            autoComplete="off"
            className={cn(crmInputClassName, "max-w-48")}
            id={`${id}-amount`}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            value={amount}
          />
        </CrmField>
      ) : null}

      {chips.length > 0 ? (
        <div className="min-w-0">
          <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
            {mode === "reject" ? "Reject because" : "Reason"}
          </p>
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
            {chips.map((chip) => (
              <button
                className={approvalActionClassName(mode === "reject" ? "reject" : "neutral", "regular")}
                data-reason-chip={chip.key}
                key={chip.key}
                // A rejection is sent by the chip itself: the second press. A reduced amount takes
                // the sentence into the box, because the figure beside it is still his to check.
                onClick={() => (mode === "reject" ? send(chip.text) : setReason(chip.text))}
                title={chip.text}
                type="button"
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <CrmField
        hint={mode === "reject" ? "The employee is told this reason." : "Kept on the claim. The employee is not told about a reduced amount."}
        htmlFor={`${id}-reason`}
        label={chips.length > 0 ? "Or write the reason" : "Reason"}
      >
        <textarea
          className={cn(crmTextareaClassName, "min-h-16")}
          dir="auto"
          id={`${id}-reason`}
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
      </CrmField>
      <RewriteFormally facts={noteFacts(claim, mode === "reduce" && !tooHigh ? figure : null)} onChange={setReason} outcome={mode === "reject" ? "rejected" : "adjusted"} value={reason} />
      {claim.systemNote && !reason.includes(claim.systemNote) ? (
        <button className="justify-self-start text-left text-xs font-bold text-orange-700 underline hover:text-orange-800" data-insert-system-note onClick={() => setReason(reason ? `${reason} ${claim.systemNote}` : String(claim.systemNote))} type="button">
          Use the system&apos;s sentence: “{claim.systemNote}”
        </button>
      ) : null}

      <div className="flex min-w-0 flex-wrap gap-2">
        <button
          className={approvalActionClassName(mode === "reject" ? "reject" : "confirm", size)}
          data-press-confirm={mode}
          disabled={!text || (mode === "reduce" && (figure === null || tooHigh))}
          onClick={() => send(text)}
          type="button"
        >
          {mode === "reject" ? DESK_WORDS.reject : figure !== null && !tooHigh ? `${DESK_WORDS.reduce} to ${egp(figure)}` : DESK_WORDS.reduce}
        </button>
        <button className={approvalActionClassName("neutral", size)} onClick={onClose} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
