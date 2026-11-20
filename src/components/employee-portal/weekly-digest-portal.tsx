"use client";

import { useMemo, useState } from "react";

import type { DeductionMethod, MyDigest, MyDigestLine } from "@/lib/attendance/digest-service.ts";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingEmpty,
  LandingMeta,
  LandingPanel,
  LandingRailLine,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";

// House rules this component is built to, not decorated with:
//   • Square edges everywhere — owner rule 2026-09-04. No rounded-* classes.
//   • Never a horizontal scroll, mobile AND desktop. There is no table here at all:
//     a day is a stacked block, so 375px needs no min-width and nothing is clipped.
//   • Text wraps; it is never truncated with an ellipsis.
//
// The flow is the owner's, 2026-09-15: for each day the employee first chooses HOW it is
// deducted — salary or annual balance — and only then is asked whether they want to dispute it.

type Props = {
  initialDigests: MyDigest[];
  initialError: string | null;
  showAmounts: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  late: "Arrived late",
  short_hours: "Short hours",
  early_leave: "Left early",
  missing_punch: "Missing punch",
  // A field day decided in the HR operations report (src/lib/hr-ops-reports/bridge.ts).
  field_review: "Field day (reviewed by HR)",
};

function formatDay(iso: string, withWeekday = true): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    ...(withWeekday ? { weekday: "long" as const } : {}),
    // A date-only value: UTC is what STOPS the calendar day shifting, it is not a bug.
    timeZone: "UTC",
  }).format(date);
}

/**
 * How a money figure is shown.
 *
 * NULL is "we cannot price this day yet", never 0.00. The day is still chargeable — it becomes a
 * real month-end candidate — so printing zero would tell someone a day costs them nothing.
 */
function money(value: number | null, currency = "EGP"): string {
  return value === null ? "Amount not yet calculated" : `${value.toFixed(2)} ${currency}`;
}

function daysText(days: number): string {
  const rounded = Math.round(days * 1000) / 1000;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

function methodText(method: DeductionMethod | null): string {
  return method === "annual_balance" ? "annual balance" : "salary";
}

function outcomeText(line: MyDigestLine): string {
  switch (line.action) {
    case "salary":
      return "Deducted from salary";
    case "annual_balance":
      return `Taken from annual balance (${daysText(line.deductionDays)})`;
    case "auto_salary":
      return "Not answered in time, so deducted from salary";
    case "disputed":
      return `Disputed, waiting for a decision. You chose ${methodText(line.chosenMethod)}.`;
    case "dispute_upheld":
      return "Dispute accepted, so nothing is deducted";
    case "dispute_rejected":
      return `Dispute not accepted, so it is taken from ${methodText(line.chosenMethod)}`;
    case "confirmed":
      return "Confirmed";
    default:
      return "Answered";
  }
}

type Draft = { lineId: number; method: DeductionMethod; step: "ask_dispute" | "write_reason"; reason: string };

/** "Change my choice" and "Back": a quiet underlined step back, still a 40px target on a phone. */
const STEP_BACK_CLASS = `inline-flex min-h-10 items-center border border-transparent px-3 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500 underline underline-offset-2 transition-colors hover:text-[#08111f] disabled:opacity-50 motion-reduce:transition-none sm:min-h-8 ${LANDING_FOCUS}`;

/** The question box under a day once a method is chosen. */
const STEP_BOX_CLASS = `mt-3 border border-slate-200 bg-slate-50 p-3 ${adminSoftDepthClassName}`;

export function WeeklyDigestPortal({ initialDigests, initialError, showAmounts }: Props) {
  const [digests, setDigests] = useState<MyDigest[]>(initialDigests);
  const [error, setError] = useState<string | null>(initialError);
  const [busyLineId, setBusyLineId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const open = useMemo(() => digests.filter((digest) => digest.status === "open"), [digests]);
  const settled = useMemo(() => digests.filter((digest) => digest.status !== "open"), [digests]);

  async function refresh() {
    const response = await fetch("/api/attendance/digests");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload?.message ?? "Could not reload your attendance.");
      return;
    }
    setDigests(payload.digests ?? []);
  }

  async function submit(digestId: number, answer: { lineId: number; method: DeductionMethod; dispute: boolean; reason?: string }) {
    if (answer.dispute && !answer.reason?.trim()) {
      setError("Tell us why this day is wrong.");
      return;
    }
    setBusyLineId(answer.lineId);
    setError(null);
    try {
      const response = await fetch(`/api/attendance/digests/${digestId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineId: answer.lineId, method: answer.method, dispute: answer.dispute, reason: answer.reason?.trim() ?? null }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "Your answer could not be saved.");
      setDraft(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your answer could not be saved.");
      await refresh();
    } finally {
      setBusyLineId(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {error ? (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`} role="alert">
          <LandingRailLine rail="bg-rose-600">{error}</LandingRailLine>
        </div>
      ) : null}

      {open.length === 0 && settled.length === 0 ? (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <LandingEmpty>
            Nothing to answer. You are notified here, by email and on Telegram when a week needs your answer.
          </LandingEmpty>
        </div>
      ) : null}

      {open.map((digest) => {
        const pendingCount = digest.lines.filter((line) => line.action === "pending").length;
        return (
          <LandingPanel
            key={digest.id}
            right={
              <LandingMeta
                items={[
                  `${pendingCount} ${pendingCount === 1 ? "day" : "days"} to answer`,
                  showAmounts ? `estimated ${money(digest.totalDeductionValue, digest.currency)}` : null,
                ]}
              />
            }
            title={`${formatDay(digest.weekStart, false)} to ${formatDay(digest.weekEnd, false)}`}
          >
            {(showAmounts && digest.hasUnpricedDay) || (digest.answerDueOn && pendingCount > 0) ? (
              <div className="divide-y divide-slate-200 border-b border-slate-200">
                {showAmounts && digest.hasUnpricedDay ? (
                  <LandingRailLine rail="bg-slate-400">
                    One or more days cannot be priced yet, so there is no week total. The days themselves still count.
                  </LandingRailLine>
                ) : null}
                {digest.answerDueOn && pendingCount > 0 ? (
                  digest.overdue ? (
                    <LandingRailLine rail="bg-amber-600">
                      <span className="font-bold text-amber-800">
                        The deadline has passed. Days you did not answer are deducted from salary.
                      </span>
                    </LandingRailLine>
                  ) : (
                    <LandingRailLine rail="bg-[#08111f]">
                      <span className={`font-bold ${LANDING_INK}`}>
                        Answer by the end of {formatDay(digest.answerDueOn)}. Any day not answered by then is deducted from salary.
                      </span>
                    </LandingRailLine>
                  )
                ) : null}
              </div>
            ) : null}

            <ul className="divide-y divide-slate-200">
              {digest.lines.map((line) => {
                const contradicting = [line.evidence?.approvedLeave, line.evidence?.crmActivity, line.evidence?.approvedExcuse]
                  .filter(Boolean)
                  .join(" · ");
                const busy = busyLineId === line.id;
                const lineDraft = draft?.lineId === line.id ? draft : null;
                const canAnswer = line.action === "pending" && !digest.overdue;
                return (
                  <li key={line.id} className="px-3 py-4 sm:px-4">
                    <p className={`break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{formatDay(line.workDate)}</p>
                    <p className="mt-1 break-words text-phx-md text-slate-600" dir="auto">
                      {STATUS_LABEL[line.status] ?? line.status}
                      {line.reason ? ` — ${line.reason}` : ""}
                    </p>
                    <p className="mt-1 break-words text-phx-md font-semibold tabular-nums text-slate-700">
                      Deduction: {daysText(line.deductionDays)}
                      {showAmounts ? ` · ${line.deductionValue === null ? money(null) : `estimated ${money(line.deductionValue)}`}` : ""}
                    </p>
                    {contradicting ? (
                      <p className="mt-1 break-words text-phx-sm font-semibold text-emerald-700">On record for this day: {contradicting}</p>
                    ) : null}

                    {line.action !== "pending" ? (
                      <p className="mt-3 break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-600">{outcomeText(line)}</p>
                    ) : null}
                    {line.reviewNotes && (line.action === "dispute_upheld" || line.action === "dispute_rejected") ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-phx-md text-slate-700" dir="auto">
                        Reviewer&apos;s note: {line.reviewNotes}
                      </p>
                    ) : null}
                    {line.action === "pending" && digest.overdue ? (
                      <p className="mt-3 break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-amber-700">
                        Not answered in time, so it will be deducted from salary
                      </p>
                    ) : null}

                    {canAnswer && !lineDraft ? (
                      <div className="mt-3">
                        <p className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-600">How should this day be deducted?</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            className={landingActionClassName("solid")}
                            disabled={busy}
                            onClick={() => setDraft({ lineId: line.id, method: "salary", step: "ask_dispute", reason: "" })}
                            type="button"
                          >
                            From my salary
                          </button>
                          <button
                            className={landingActionClassName("outline", "disabled:border-slate-300 disabled:text-slate-400 disabled:hover:bg-transparent")}
                            disabled={busy || !line.balance?.covers}
                            onClick={() => setDraft({ lineId: line.id, method: "annual_balance", step: "ask_dispute", reason: "" })}
                            type="button"
                          >
                            From my annual balance
                          </button>
                        </div>
                        {line.balance ? (
                          <p className="mt-2 break-words text-phx-sm text-slate-600">
                            {line.balance.availableDays !== null
                              ? `Annual balance available: ${daysText(line.balance.availableDays)}. `
                              : ""}
                            {line.balance.covers
                              ? `Choosing balance takes ${daysText(line.deductionDays)} from it instead of your salary.`
                              : line.balance.unavailableReason}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {canAnswer && lineDraft?.step === "ask_dispute" ? (
                      <div className={STEP_BOX_CLASS}>
                        <p className={`break-words text-phx-md font-semibold ${LANDING_INK}`}>
                          You chose {methodText(lineDraft.method)}. Do you want to dispute this day?
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            className={landingActionClassName("solid")}
                            disabled={busy}
                            onClick={() => submit(digest.id, { lineId: line.id, method: lineDraft.method, dispute: false })}
                            type="button"
                          >
                            No, save my answer
                          </button>
                          <button
                            className={landingActionClassName("outline", "bg-white")}
                            disabled={busy}
                            onClick={() => setDraft({ ...lineDraft, step: "write_reason" })}
                            type="button"
                          >
                            Yes, dispute it
                          </button>
                          <button
                            className={STEP_BACK_CLASS}
                            disabled={busy}
                            onClick={() => setDraft(null)}
                            type="button"
                          >
                            Change my choice
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {canAnswer && lineDraft?.step === "write_reason" ? (
                      <div className={STEP_BOX_CLASS}>
                        <label className="block text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-600" htmlFor={`reason-${line.id}`}>
                          What actually happened?
                        </label>
                        <textarea
                          className={`${phxTextareaClassName} mt-2`}
                          dir="auto"
                          id={`reason-${line.id}`}
                          onChange={(event) => setDraft({ ...lineDraft, reason: event.target.value })}
                          rows={3}
                          value={lineDraft.reason}
                        />
                        <p className="mt-1 break-words text-phx-sm text-slate-600">
                          If the dispute is not accepted, the day is taken from {methodText(lineDraft.method)}.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            className={landingActionClassName("solid")}
                            disabled={busy}
                            onClick={() =>
                              submit(digest.id, { lineId: line.id, method: lineDraft.method, dispute: true, reason: lineDraft.reason })
                            }
                            type="button"
                          >
                            Send dispute
                          </button>
                          <button
                            className={STEP_BACK_CLASS}
                            disabled={busy}
                            onClick={() => setDraft({ ...lineDraft, step: "ask_dispute" })}
                            type="button"
                          >
                            Back
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </LandingPanel>
        );
      })}

      {settled.length ? (
        <LandingPanel title="Earlier weeks">
          <ul className="divide-y divide-slate-200">
            {settled.map((digest) => (
              <li key={digest.id} className="px-3 py-3 sm:px-4">
                <p className={`break-words text-phx-md font-semibold ${LANDING_INK}`}>
                  {formatDay(digest.weekStart, false)} to {formatDay(digest.weekEnd, false)}
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {digest.lines.map((line) => (
                    <li key={line.id} className="break-words text-phx-sm text-slate-600">
                      {formatDay(line.workDate)} · {daysText(line.deductionDays)} · {outcomeText(line)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </LandingPanel>
      ) : null}
    </div>
  );
}
