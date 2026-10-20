"use client";

import { useMemo, useState } from "react";

import type { DeductionMethod, MyDigest, MyDigestLine } from "@/lib/attendance/digest-service.ts";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

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
    <div className="flex w-full flex-col gap-6">
      {error ? (
        <p className="border-l-2 border-red-600 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</p>
      ) : null}

      {open.length === 0 && settled.length === 0 ? (
        <p className={`border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600 ${adminSoftDepthClassName}`}>
          Nothing to answer. You are notified here, by email and on Telegram when a week needs your answer.
        </p>
      ) : null}

      {open.map((digest) => {
        const pendingCount = digest.lines.filter((line) => line.action === "pending").length;
        return (
          <section key={digest.id} className={`border border-slate-300 bg-white ${adminSoftDepthClassName}`}>
            <header className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-700">
                {formatDay(digest.weekStart, false)} to {formatDay(digest.weekEnd, false)}
              </h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                {pendingCount} {pendingCount === 1 ? "day" : "days"} to answer
                {showAmounts ? ` · estimated ${money(digest.totalDeductionValue, digest.currency)}` : ""}
              </p>
              {showAmounts && digest.hasUnpricedDay ? (
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  One or more days cannot be priced yet, so there is no week total. The days themselves still count.
                </p>
              ) : null}
              {digest.answerDueOn && pendingCount > 0 ? (
                digest.overdue ? (
                  <p className="mt-2 border-l-2 border-amber-600 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                    The deadline has passed. Days you did not answer are deducted from salary.
                  </p>
                ) : (
                  <p className="mt-2 border-l-2 border-slate-700 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-800">
                    Answer by the end of {formatDay(digest.answerDueOn)}. Any day not answered by then is deducted from salary.
                  </p>
                )
              ) : null}
            </header>

            <ul className="divide-y divide-slate-200">
              {digest.lines.map((line) => {
                const contradicting = [line.evidence?.approvedLeave, line.evidence?.crmActivity, line.evidence?.approvedExcuse]
                  .filter(Boolean)
                  .join(" · ");
                const busy = busyLineId === line.id;
                const lineDraft = draft?.lineId === line.id ? draft : null;
                const canAnswer = line.action === "pending" && !digest.overdue;
                return (
                  <li key={line.id} className="px-4 py-4">
                    <p className="text-sm font-bold text-slate-800">{formatDay(line.workDate)}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {STATUS_LABEL[line.status] ?? line.status}
                      {line.reason ? ` — ${line.reason}` : ""}
                    </p>
                    <p className="mt-1 text-sm font-semibold text-slate-700">
                      Deduction: {daysText(line.deductionDays)}
                      {showAmounts ? ` · ${line.deductionValue === null ? money(null) : `estimated ${money(line.deductionValue)}`}` : ""}
                    </p>
                    {contradicting ? (
                      <p className="mt-1 text-xs font-semibold text-emerald-700">On record for this day: {contradicting}</p>
                    ) : null}

                    {line.action !== "pending" ? (
                      <p className="mt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">{outcomeText(line)}</p>
                    ) : null}
                    {line.reviewNotes && (line.action === "dispute_upheld" || line.action === "dispute_rejected") ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700" dir="auto">
                        Reviewer&apos;s note: {line.reviewNotes}
                      </p>
                    ) : null}
                    {line.action === "pending" && digest.overdue ? (
                      <p className="mt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                        Not answered in time, so it will be deducted from salary
                      </p>
                    ) : null}

                    {canAnswer && !lineDraft ? (
                      <div className="mt-3">
                        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-600">How should this day be deducted?</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={() => setDraft({ lineId: line.id, method: "salary", step: "ask_dispute", reason: "" })}
                            type="button"
                          >
                            From my salary
                          </button>
                          <button
                            className="border border-slate-800 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-800 disabled:border-slate-300 disabled:text-slate-400"
                            disabled={busy || !line.balance?.covers}
                            onClick={() => setDraft({ lineId: line.id, method: "annual_balance", step: "ask_dispute", reason: "" })}
                            type="button"
                          >
                            From my annual balance
                          </button>
                        </div>
                        {line.balance ? (
                          <p className="mt-2 text-xs text-slate-600">
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
                      <div className={`mt-3 border border-slate-300 bg-slate-50 p-3 ${adminSoftDepthClassName}`}>
                        <p className="text-sm font-semibold text-slate-800">
                          You chose {methodText(lineDraft.method)}. Do you want to dispute this day?
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={() => submit(digest.id, { lineId: line.id, method: lineDraft.method, dispute: false })}
                            type="button"
                          >
                            No, save my answer
                          </button>
                          <button
                            className={`border border-slate-400 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50 disabled:shadow-none ${adminControlDepthClassName}`}
                            disabled={busy}
                            onClick={() => setDraft({ ...lineDraft, step: "write_reason" })}
                            type="button"
                          >
                            Yes, dispute it
                          </button>
                          <button
                            className="border border-transparent px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500 underline disabled:opacity-50"
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
                      <div className={`mt-3 border border-slate-300 bg-slate-50 p-3 ${adminSoftDepthClassName}`}>
                        <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-600" htmlFor={`reason-${line.id}`}>
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
                        <p className="mt-1 text-xs text-slate-600">
                          If the dispute is not accepted, the day is taken from {methodText(lineDraft.method)}.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                            disabled={busy}
                            onClick={() =>
                              submit(digest.id, { lineId: line.id, method: lineDraft.method, dispute: true, reason: lineDraft.reason })
                            }
                            type="button"
                          >
                            Send dispute
                          </button>
                          <button
                            className="border border-transparent px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-500 underline disabled:opacity-50"
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
          </section>
        );
      })}

      {settled.length ? (
        <section className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <header className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">Earlier weeks</h2>
          </header>
          <ul className="divide-y divide-slate-200">
            {settled.map((digest) => (
              <li key={digest.id} className="px-4 py-3">
                <p className="text-sm font-semibold text-slate-700">
                  {formatDay(digest.weekStart, false)} to {formatDay(digest.weekEnd, false)}
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {digest.lines.map((line) => (
                    <li key={line.id} className="text-xs text-slate-600">
                      {formatDay(line.workDate)} · {daysText(line.deductionDays)} · {outcomeText(line)}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
