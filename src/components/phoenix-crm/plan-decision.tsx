"use client";

/**
 * Phoenix CRM — the reviewer's decision on a sent week or a sent month.
 *
 * Owner, 2026-09-16 and 2026-09-29: the reviewing manager approves a plan, or returns it with a note on
 * what to change; the SFE Manager sees every plan and can return one, never approve it. Nothing
 * approves a plan by itself — this block only ever acts on a press of one of its buttons, and a return
 * is refused here until it carries a note the rep will read.
 *
 * Owner, 2026-10-02 — "Only that day" reopens: on a WEEK the reviewer may also return ONE day, chosen
 * from the week's working days that have not passed (`returnDays`). Only that day opens for the rep;
 * every other day stays exactly as he sent it, and his visits there still count as planned ("Still
 * planned", owner, 2026-10-02). The note is required for it too, and the day is a
 * second choice made in the block — the press that sends it names the day, so it can never go back by
 * accident with the wrong one. A month has no single-day return.
 */

import { useState } from "react";

import { dayLabel } from "@/components/phoenix-crm/format";
import { CrmBlock, CrmButton, CrmChoice, CrmField, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";
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
  returnDays,
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
  /** Sends the decision; resolves true when it went through. `day` names the one day returned, else null. */
  onDecide: (action: PlanDecisionAction, note: string, day: string | null) => Promise<boolean>;
  /**
   * The days of the week that may go back on their own (owner, 2026-10-02): its working days that have
   * not passed. Absent on a month, and on a week with none left.
   */
  returnDays?: ReadonlyArray<string>;
  subject: "week" | "month";
}) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // "Return one day" is a second choice: the block asks which day, and only its own press sends it.
  const [choosingDay, setChoosingDay] = useState(false);
  const [day, setDay] = useState<string | null>(null);
  const [sentDay, setSentDay] = useState<string | null>(null);
  const noteId = `${idPrefix}-${subject}-decision-note`;
  const what = subject === "month" ? "the month" : "the week";
  const days = subject === "week" && canReturn ? (returnDays ?? []) : [];
  const chosenDay = day !== null && days.includes(day) ? day : null;

  if (!canApprove && !canReturn) return null;

  async function decide(action: PlanDecisionAction, oneDay: string | null = null) {
    const trimmed = note.trim();
    if (action === "return" && !trimmed) {
      setProblem(oneDay ? `Write a note for the rep on what to change on ${dayLabel(oneDay)}.` : "Write a note for the rep on what to change.");
      return;
    }
    setProblem(null);
    setSentDay(oneDay);
    if (await onDecide(action, trimmed, oneDay)) {
      setNote("");
      setChoosingDay(false);
      setDay(null);
    }
  }

  return (
    <CrmBlock className="border-t border-slate-100" title={subject === "month" ? "Your decision on the month" : "Your decision on this week"}>
      <p className="break-words text-sm font-medium leading-6 text-slate-600">
        {canApprove
          ? `Approve ${what}, or return it to the rep with a note on what to change.`
          : approved
            ? `${subject === "month" ? "The month" : "This week"} is approved. You can still return it to the rep with a note on what to change.`
            : `Return ${what} to the rep with a note on what to change.`}
        {days.length > 0 ? " You can also return one day only: the rep changes that day, and every other day stays as he sent it." : ""}
      </p>
      <div className="mt-3 grid min-w-0 gap-2">
        <CrmField hint={canApprove ? `Needed to return ${what} or one of its days. The rep reads it.` : "The rep reads it."} htmlFor={noteId} label="Note for the rep">
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
            <CrmButton busy={busy === "return" && sentDay === null} disabled={locked} onClick={() => void decide("return")} variant="danger">
              {days.length > 0 ? "Return the week" : "Return with a note"}
            </CrmButton>
          ) : null}
          {days.length > 0 ? (
            <CrmButton
              aria-expanded={choosingDay}
              className={canApprove && canReturn ? "col-span-2 sm:col-span-1" : undefined}
              disabled={locked}
              onClick={() => {
                setChoosingDay((open) => !open);
                setProblem(null);
              }}
              variant="danger"
            >
              Return one day
            </CrmButton>
          ) : null}
        </div>
        {choosingDay && days.length > 0 ? (
          <div className="grid min-w-0 gap-2 border border-rose-200 bg-rose-50/40 px-3.5 py-3">
            <p className="text-sm font-black text-slate-950">Which day goes back to the rep?</p>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              Only that day opens for him to change. Every other day stays exactly as he sent it, and his visits on those days still count as
              planned. He sends the week again once the day is changed.
            </p>
            <CrmChoice
              columns={3}
              label="Day to return"
              onChange={(next) => {
                setDay(next);
                setProblem(null);
              }}
              options={days.map((date) => ({ value: date, label: dayLabel(date) }))}
              value={chosenDay}
            />
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <CrmButton
                busy={busy === "return" && sentDay !== null}
                disabled={locked || chosenDay === null}
                onClick={() => {
                  if (chosenDay) void decide("return", chosenDay);
                }}
                variant="danger"
              >
                {chosenDay ? `Return ${dayLabel(chosenDay)}` : "Choose a day"}
              </CrmButton>
              <CrmButton
                disabled={busy === "return"}
                onClick={() => {
                  setChoosingDay(false);
                  setDay(null);
                }}
              >
                Cancel
              </CrmButton>
            </div>
          </div>
        ) : null}
        {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
      </div>
    </CrmBlock>
  );
}
