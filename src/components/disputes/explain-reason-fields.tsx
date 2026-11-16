"use client";

import { useEffect, useMemo, useState } from "react";

import { phxSelectClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import {
  EXPLAIN_LEAVE_REDIRECT_HREF,
  EXPLAIN_OTHER_MIN_WORDS,
  EXPLAIN_REASONS,
  validateExplanationReason,
  type ExplainConfirmerKind,
  type ExplainReasonCode,
} from "@/lib/dispute-center/explain-reasons";

// THE REASON LIST ON A DEDUCTION DISPUTE (owner, 2026-11-16: "make the rep write whatever he wants … find
// a more professional, easier, accurate way"). The monthly and the daily deduction boxes open with the
// same choice the calendar's "Explain this day" offers — Training, Meeting, Double visit, Something else —
// and the person who can confirm it. Leave is never a reason: it is requested on the leave page.

export type ExplainReasonDraft = {
  reasonCode: ExplainReasonCode | "";
  confirmerHrId: string;
  detailText: string;
};

export const EMPTY_EXPLAIN_DRAFT: ExplainReasonDraft = { confirmerHrId: "", detailText: "", reasonCode: "" };

type ConfirmerOption = { hrId: string; kind: ExplainConfirmerKind; name: string; title: string | null };

/** The draft's own check, as one sentence the employee can act on — or null when it is ready to send. */
export function explainDraftProblem(draft: ExplainReasonDraft): string | null {
  try {
    validateExplanationReason(draft);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Choose why first.";
  }
}

export function ExplainReasonFields({
  name,
  onChange,
  value,
}: {
  /** Unique per box, so two boxes on one page keep their own radio group. */
  name: string;
  onChange: (next: ExplainReasonDraft) => void;
  value: ExplainReasonDraft;
}) {
  const [confirmers, setConfirmers] = useState<ConfirmerOption[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/dispute-center/explanations/confirmers")
      .then((response) => response.json())
      .then((payload) => {
        if (live) setConfirmers(Array.isArray(payload?.data) ? payload.data : []);
      })
      .catch(() => {
        if (live) setConfirmers([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const reason = value.reasonCode ? EXPLAIN_REASONS.find((entry) => entry.code === value.reasonCode) ?? null : null;
  const options = useMemo(
    () => (confirmers ?? []).filter((option) => reason?.confirmerKinds.includes(option.kind) ?? false),
    [confirmers, reason],
  );

  return (
    <div className="mt-2">
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Reason</legend>
        {EXPLAIN_REASONS.map((entry) => (
          <label
            className={[
              "flex cursor-pointer items-start gap-2 border bg-white p-3",
              value.reasonCode === entry.code ? "border-slate-900" : "border-slate-200",
            ].join(" ")}
            key={entry.code}
          >
            <input
              checked={value.reasonCode === entry.code}
              className="mt-0.5"
              name={name}
              onChange={() => onChange({ ...value, confirmerHrId: "", reasonCode: entry.code })}
              type="radio"
            />
            <span className="min-w-0">
              <span className="block text-sm font-black text-slate-900">{entry.label}</span>
              <span className="block text-xs font-semibold leading-relaxed text-slate-600">{entry.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="mt-2 text-xs font-semibold text-slate-700">
        Was it leave?{" "}
        <a className="font-black text-slate-900 underline" href={EXPLAIN_LEAVE_REDIRECT_HREF}>
          Request the leave instead
        </a>{" "}
        — leave is approved there, never explained here.
      </p>
      {reason && reason.confirmerKinds.length > 0 ? (
        <label className="mt-3 block">
          <span className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">Who can confirm it</span>
          <select
            className={`${phxSelectClassName} mt-1`}
            onChange={(event) => onChange({ ...value, confirmerHrId: event.target.value })}
            value={value.confirmerHrId}
          >
            <option value="">{confirmers === null ? "Loading" : "Choose a person"}</option>
            {options.map((option) => (
              <option key={option.hrId} value={option.hrId}>
                {option.title ? `${option.name} — ${option.title}` : option.name}
              </option>
            ))}
          </select>
          {confirmers !== null && options.length === 0 ? (
            <span className="mt-1 block text-xs font-bold text-slate-700">
              No manager is on file for you. Choose Something else and explain it, or ask HR to set your manager.
            </span>
          ) : null}
        </label>
      ) : null}
      {reason ? (
        <textarea
          className={`${phxTextareaClassName} mt-3`}
          maxLength={1000}
          onChange={(event) => onChange({ ...value, detailText: event.target.value })}
          placeholder={
            value.reasonCode === "other"
              ? `What happened: where you were and what you did (at least ${EXPLAIN_OTHER_MIN_WORDS} words)`
              : "Anything to add (optional): the training's name, the meeting's place"
          }
          rows={3}
          value={value.detailText}
        />
      ) : null}
    </div>
  );
}
