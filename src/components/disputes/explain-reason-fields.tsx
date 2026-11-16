"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check } from "lucide-react";

import {
  phxCheckInputClassName,
  phxCheckTileClassName,
  phxHintClassName,
  phxLabelClassName,
  phxRequiredMarkClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import {
  EXPLAIN_LEAVE_REDIRECT_HREF,
  EXPLAIN_MAX_DAYS,
  EXPLAIN_OTHER_MIN_CHARS,
  EXPLAIN_OTHER_MIN_WORDS,
  EXPLAIN_REASONS,
  explainDayLabel,
  explainDetailProgress,
  validateExplanationReason,
  type ExplainConfirmerKind,
  type ExplainReasonCode,
} from "@/lib/dispute-center/explain-reasons";
import { cn } from "@/lib/utils";

// THE ONE REASON PICKER (owner, 2026-11-16: "make the rep write whatever he wants … find a more
// professional, easier, accurate way"). The calendar's "Explain this day", the monthly deduction box
// and the daily deduction box all open with this same choice — Training, Meeting, Double visit,
// Something else — and the person who can confirm it. Leave is never a reason: it is requested on
// the leave page. It wears the one form design (form-tokens.ts): micro-caps labels, the orange
// check tile, the square field — so the three boxes look and behave as one.

export type ExplainReasonDraft = {
  reasonCode: ExplainReasonCode | "";
  confirmerHrId: string;
  detailText: string;
};

export const EMPTY_EXPLAIN_DRAFT: ExplainReasonDraft = { confirmerHrId: "", detailText: "", reasonCode: "" };

export type ExplainConfirmerOption = { hrId: string; kind: ExplainConfirmerKind; name: string; title: string | null };

// One request per page, however many boxes it holds: a Deductions page with six rows asks once. A
// failed read is forgotten, so the next box to open tries again.
let confirmersRequest: Promise<ExplainConfirmerOption[]> | null = null;

function loadExplainConfirmers(): Promise<ExplainConfirmerOption[]> {
  confirmersRequest ??= fetch("/api/dispute-center/explanations/confirmers")
    .then((response) => response.json())
    .then((payload) => (Array.isArray(payload?.data) ? (payload.data as ExplainConfirmerOption[]) : []))
    .catch(() => {
      confirmersRequest = null;
      return [];
    });
  return confirmersRequest;
}

/** The people this employee may name — null while loading. `enabled` false asks for nothing. */
export function useExplainConfirmers(enabled = true): ExplainConfirmerOption[] | null {
  const [confirmers, setConfirmers] = useState<ExplainConfirmerOption[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadExplainConfirmers().then((options) => {
      if (live) setConfirmers(options);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return confirmers;
}

/** The draft's own check, as one sentence the employee can act on — or null when it is ready to send. */
export function explainDraftProblem(draft: ExplainReasonDraft): string | null {
  try {
    validateExplanationReason(draft);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Choose why first.";
  }
}

/** Other unexplained days the same reason can cover, ticked in the same action (the calendar only). */
export type ExplainExtraDays = {
  options: readonly string[];
  selected: readonly string[];
  onToggle: (date: string) => void;
};

export function ExplainReasonFields({
  extraDays,
  name,
  onChange,
  subject = "these days have no record",
  value,
}: {
  extraDays?: ExplainExtraDays;
  /** Unique per box, so two boxes on one page keep their own radio group. */
  name: string;
  onChange: (next: ExplainReasonDraft) => void;
  /** The end of the first question: "Why {subject}?" */
  subject?: string;
  value: ExplainReasonDraft;
}) {
  const confirmers = useExplainConfirmers();
  const reason = value.reasonCode ? EXPLAIN_REASONS.find((entry) => entry.code === value.reasonCode) ?? null : null;
  const options = useMemo(
    () => (confirmers ?? []).filter((option) => reason?.confirmerKinds.includes(option.kind) ?? false),
    [confirmers, reason],
  );
  const needsConfirmer = Boolean(reason && reason.confirmerKinds.length > 0);
  const isOther = value.reasonCode === "other";
  const progress = explainDetailProgress(value.detailText);
  const confirmerId = `${name}-confirmer`;
  const detailId = `${name}-detail`;

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className={phxLabelClassName}>
          Why {subject}?<span aria-hidden className={phxRequiredMarkClassName}>*</span>
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {EXPLAIN_REASONS.map((entry) => {
            const checked = value.reasonCode === entry.code;
            return (
              <label className={cn(phxCheckTileClassName(checked), "items-start py-3")} key={entry.code}>
                <input
                  checked={checked}
                  className={cn(phxCheckInputClassName, "mt-0.5")}
                  name={name}
                  onChange={() => onChange({ ...value, confirmerHrId: "", reasonCode: entry.code })}
                  type="radio"
                />
                <span className="min-w-0">
                  <span className="block font-black text-slate-900">{entry.label}</span>
                  <span className="mt-0.5 block text-xs font-medium leading-relaxed text-slate-500">{entry.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        <p className={phxHintClassName}>
          Was it leave?{" "}
          <a className="inline-flex items-center gap-1 font-bold text-slate-700 underline underline-offset-2 hover:text-orange-600" href={EXPLAIN_LEAVE_REDIRECT_HREF}>
            Request the leave instead
            <ArrowRight aria-hidden className="h-3 w-3" />
          </a>{" "}
          Leave is approved there, never explained here.
        </p>
      </fieldset>

      {needsConfirmer ? (
        <div>
          <label className={phxLabelClassName} htmlFor={confirmerId}>
            Who can confirm it<span aria-hidden className={phxRequiredMarkClassName}>*</span>
          </label>
          <select
            className={phxSelectClassName}
            id={confirmerId}
            onChange={(event) => onChange({ ...value, confirmerHrId: event.target.value })}
            value={value.confirmerHrId}
          >
            <option value="">{confirmers === null ? "Loading the people you can name" : "Choose a person"}</option>
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
          ) : (
            <span className={phxHintClassName}>They confirm it first. The Super Admin decides after that.</span>
          )}
        </div>
      ) : null}

      {reason ? (
        <div>
          <label className={phxLabelClassName} htmlFor={detailId}>
            {isOther ? (
              <>
                What happened<span aria-hidden className={phxRequiredMarkClassName}>*</span>
              </>
            ) : (
              <>
                Anything to add <span className="font-semibold normal-case tracking-normal text-slate-400">(optional)</span>
              </>
            )}
          </label>
          <textarea
            className={phxTextareaClassName}
            id={detailId}
            maxLength={1000}
            onChange={(event) => onChange({ ...value, detailText: event.target.value })}
            placeholder={isOther ? "Where you were and what you did that day" : "The training's name, or where the meeting was"}
            rows={3}
            value={value.detailText}
          />
          {isOther ? (
            progress.enough ? (
              <span className="mt-1 flex items-center gap-1 text-xs font-bold text-slate-700">
                <Check aria-hidden className="h-3.5 w-3.5 text-orange-600" />
                Enough for the Super Admin to read and decide.
              </span>
            ) : (
              <span className={phxHintClassName}>
                {progress.words} of {EXPLAIN_OTHER_MIN_WORDS} words · {progress.chars} of {EXPLAIN_OTHER_MIN_CHARS} characters. Nobody confirms this one, so say it in full.
              </span>
            )
          ) : null}
        </div>
      ) : null}

      {reason && extraDays && extraDays.options.length > 0 ? (
        <fieldset>
          <legend className={phxLabelClassName}>The same reason on other days</legend>
          <div className="flex flex-wrap gap-2">
            {extraDays.options.map((date) => {
              const checked = extraDays.selected.includes(date);
              return (
                <label className={cn(phxCheckTileClassName(checked), "py-1.5 text-xs")} key={date}>
                  <input
                    checked={checked}
                    className={phxCheckInputClassName}
                    onChange={() => extraDays.onToggle(date)}
                    type="checkbox"
                  />
                  {explainDayLabel(date)}
                </label>
              );
            })}
          </div>
          <span className={phxHintClassName}>
            Only days with nothing asked about yet are listed. One explanation covers {EXPLAIN_MAX_DAYS} days at most.
          </span>
        </fieldset>
      ) : null}
    </div>
  );
}
