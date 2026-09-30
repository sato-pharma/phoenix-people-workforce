"use client";

/**
 * Phoenix CRM — the reviewer's decision on a sent week or a sent month.
 *
 * Owner, 2026-09-16 and 2026-09-29: the reviewing manager approves a plan, or returns it with a note on
 * what to change; the SFE Manager sees every plan and can return one, never approve it. Nothing
 * approves a plan by itself — this block only ever acts on a press of one of its two buttons, and a
 * return is refused here until it carries a note the rep will read.
 */

import { useState } from "react";

import { CrmBlock, CrmButton, CrmField, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { PLAN_DECISION_NOTE_MAX } from "@/lib/phoenix-crm/plan-rules";
import { cn } from "@/lib/utils";

export type PlanDecisionAction = "approve" | "return";

/** Which decision is being sent, out of whatever a screen is busy with. */
export function decisionBusy(value: string | null | undefined): PlanDecisionAction | null {
  return value === "approve" || value === "return" ? value : null;
}

export function PlanDecision({
  approved,
  busy,
  canApprove,
  canReturn,
  idPrefix,
  locked,
  onDecide,
  subject,
}: {
  /** The plan is approved already, so returning it is all that is left. */
  approved: boolean;
  /** The decision being sent now, so only its own button shows it is working. */
  busy: PlanDecisionAction | null;
  canApprove: boolean;
  canReturn: boolean;
  idPrefix: string;
  locked: boolean;
  /** Sends the decision; resolves true when it went through. */
  onDecide: (action: PlanDecisionAction, note: string) => Promise<boolean>;
  subject: "week" | "month";
}) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = `${idPrefix}-${subject}-decision-note`;
  const what = subject === "month" ? "the month" : "the week";

  if (!canApprove && !canReturn) return null;

  async function decide(action: PlanDecisionAction) {
    const trimmed = note.trim();
    if (action === "return" && !trimmed) {
      setProblem("Write a note for the rep on what to change.");
      return;
    }
    setProblem(null);
    if (await onDecide(action, trimmed)) setNote("");
  }

  return (
    <CrmBlock className="border-t border-slate-100" title={subject === "month" ? "Your decision on the month" : "Your decision on this week"}>
      <p className="break-words text-sm font-medium leading-6 text-slate-600">
        {canApprove
          ? `Approve ${what}, or return it to the rep with a note on what to change.`
          : approved
            ? `${subject === "month" ? "The month" : "This week"} is approved. You can still return it to the rep with a note on what to change.`
            : `Return ${what} to the rep with a note on what to change.`}
      </p>
      <div className="mt-3 grid min-w-0 gap-2">
        <CrmField hint={canApprove ? `Needed to return ${what}. The rep reads it.` : "The rep reads it."} htmlFor={noteId} label="Note for the rep">
          <textarea
            className={crmTextareaClassName}
            disabled={locked}
            id={noteId}
            maxLength={PLAN_DECISION_NOTE_MAX}
            onChange={(event) => {
              setNote(event.target.value);
              setProblem(null);
            }}
            rows={3}
            value={note}
          />
        </CrmField>
        <div className={cn("grid gap-2 sm:flex sm:flex-wrap", canApprove && canReturn ? "grid-cols-2" : undefined)}>
          {canApprove ? (
            <CrmButton busy={busy === "approve"} disabled={locked} onClick={() => void decide("approve")} variant="success">
              {subject === "month" ? "Approve the month" : "Approve this week"}
            </CrmButton>
          ) : null}
          {canReturn ? (
            <CrmButton busy={busy === "return"} disabled={locked} onClick={() => void decide("return")} variant="danger">
              Return with a note
            </CrmButton>
          ) : null}
        </div>
        {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
      </div>
    </CrmBlock>
  );
}
