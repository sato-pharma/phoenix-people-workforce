"use client";

import { useState } from "react";

import type { DigestLineRow, ReviewEmployee, ReviewWeek } from "@/lib/attendance/digest-service.ts";

// The owner's gate, 2026-09-15: every closed week lands here first, and nothing reaches an
// employee until the week is released from this page.
//
// House rules this is built to:
//   • Square edges — no rounded-* classes.
//   • Never a horizontal scroll. Desktop is `w-full table-fixed` with a colgroup, fitted by
//     MERGING columns (a person's days sit in one cell), never by a min-width; below md the
//     same data is cards.
//   • Names, never HR IDs. Text wraps, never an ellipsis.

type Props = {
  initialWeeks: ReviewWeek[];
  initialError: string | null;
  answerWorkingDays: number;
  /** Super Admin only: remove a day, release a week. A dispute reviewer sees the page read-only. */
  canManage: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  late: "Arrived late",
  short_hours: "Short hours",
  early_leave: "Left early",
  missing_punch: "Missing punch",
};

const ANSWER_LABEL: Record<string, string> = {
  pending: "Not answered yet",
  removed: "Removed",
  salary: "Salary",
  annual_balance: "Annual balance",
  auto_salary: "Salary (no answer in time)",
  disputed: "Disputed, waiting for review",
  dispute_upheld: "Dispute accepted, no deduction",
  dispute_rejected: "Dispute rejected",
  confirmed: "Confirmed",
};

function formatDay(iso: string, withWeekday = true): string {
  // A date-only value: UTC is what stops the calendar day shifting.
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    ...(withWeekday ? { weekday: "short" as const } : {}),
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

function formatCairoMoment(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso));
}

function daysText(days: number): string {
  const rounded = Math.round(days * 1000) / 1000;
  return `${rounded} ${rounded === 1 ? "day" : "days"}`;
}

function money(value: number | null, currency: string): string {
  return value === null ? "Amount not yet calculated" : `${value.toFixed(2)} ${currency}`;
}

function answerText(line: DigestLineRow): string {
  const base = ANSWER_LABEL[line.action] ?? line.action;
  if (line.action === "disputed" || line.action === "dispute_rejected") {
    return `${base} (${line.chosenMethod === "annual_balance" ? "annual balance" : "salary"})`;
  }
  return base;
}

function visibleLines(employee: ReviewEmployee, stage: ReviewWeek["stage"]): DigestLineRow[] {
  // Before release a removed day stays on screen (struck through, with its reason) so the owner
  // can see what he took out. After release the employee never saw it, so neither does this list.
  return stage === "released" ? employee.lines.filter((line) => line.action !== "removed") : employee.lines;
}

function progress(week: ReviewWeek) {
  let open = 0;
  let answered = 0;
  for (const employee of week.employees) {
    for (const line of employee.lines) {
      if (line.action === "removed") continue;
      if (line.action === "pending" || line.action === "disputed") open += 1;
      else answered += 1;
    }
  }
  return { open, answered };
}

export function WeeklyAttendanceReview({ initialWeeks, initialError, answerWorkingDays, canManage }: Props) {
  const [weeks, setWeeks] = useState<ReviewWeek[]>(initialWeeks);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ lineId: number; reason: string } | null>(null);
  const [confirmingWeek, setConfirmingWeek] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch("/api/attendance/weekly-review");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload?.message ?? "The review could not be reloaded.");
      return;
    }
    setWeeks(payload.weeks ?? []);
  }

  async function removeLine(lineId: number, reason: string) {
    if (!reason.trim()) {
      setError("Say why this day is being removed.");
      return;
    }
    setBusy(`line:${lineId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/weekly-review/lines/${lineId}/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "The day could not be removed.");
      setRemoving(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The day could not be removed.");
    } finally {
      await refresh();
      setBusy(null);
    }
  }

  async function release(week: ReviewWeek) {
    setBusy(`week:${week.key}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/attendance/weekly-review/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycleKey: week.cycleKey, weekIndex: week.weekIndex }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "The week could not be released.");
      const released = Number(payload.released ?? 0);
      const notified = Number(payload.notified ?? 0);
      const notNotified = Number(payload.notNotified ?? 0);
      setNotice(
        `Released to ${released} ${released === 1 ? "employee" : "employees"}. ${notified} notified in-app or on Telegram.` +
          (notNotified > 0
            ? ` ${notNotified} could not be notified: they still see the week on their page, and their days are never deducted automatically for going unanswered.`
            : ""),
      );
      setConfirmingWeek(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The week could not be released.");
    } finally {
      await refresh();
      setBusy(null);
    }
  }

  function dayBlock(week: ReviewWeek, employee: ReviewEmployee, line: DigestLineRow, layout: "table" | "card") {
    const isRemoved = line.action === "removed";
    const canRemove = canManage && week.stage === "awaiting_release" && line.action === "pending";
    const removeOpen = removing?.lineId === line.id;
    return (
      <div className="py-2 first:pt-0 last:pb-0" key={line.id}>
        <p className={`text-sm ${isRemoved ? "text-slate-400 line-through" : "text-slate-800"}`}>
          <span className="font-semibold">{formatDay(line.workDate)}</span> · {STATUS_LABEL[line.status] ?? line.status} ·{" "}
          {daysText(line.deductionDays)} · {money(line.deductionValue, employee.currency)}
        </p>
        {line.reason ? <p className="text-xs text-slate-500">{line.reason}</p> : null}
        {isRemoved && line.removeReason ? (
          <p className="text-xs font-semibold text-slate-500" dir="auto">
            Removed: {line.removeReason}
          </p>
        ) : null}
        {week.stage === "released" ? (
          <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{answerText(line)}</p>
        ) : null}
        {canRemove && !removeOpen ? (
          <button
            className="mt-1 text-xs font-black uppercase tracking-[0.12em] text-slate-600 underline disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => setRemoving({ lineId: line.id, reason: "" })}
            type="button"
          >
            Remove this day
          </button>
        ) : null}
        {canRemove && removeOpen ? (
          <div className="mt-2 border border-slate-300 bg-slate-50 p-2">
            <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-600" htmlFor={`remove-${layout}-${line.id}`}>
              Why remove it?
            </label>
            <input
              className="mt-1 w-full border border-slate-300 bg-white p-2 text-sm text-slate-800"
              dir="auto"
              id={`remove-${layout}-${line.id}`}
              onChange={(event) => setRemoving({ lineId: line.id, reason: event.target.value })}
              value={removing.reason}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="border border-slate-800 bg-slate-800 px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => removeLine(line.id, removing.reason)}
                type="button"
              >
                Remove
              </button>
              <button
                className="border border-slate-400 bg-white px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => setRemoving(null)}
                type="button"
              >
                Keep it
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  function statusCell(week: ReviewWeek, employee: ReviewEmployee) {
    if (week.stage === "awaiting_release") {
      return employee.status === "void" ? "Every day removed" : "Waiting for release";
    }
    const lines = visibleLines(employee, week.stage);
    const open = lines.filter((line) => line.action === "pending").length;
    const disputed = lines.filter((line) => line.action === "disputed").length;
    const parts = [];
    if (open) parts.push(`${open} not answered`);
    if (disputed) parts.push(`${disputed} disputed`);
    if (!parts.length) parts.push("All answered");
    if (employee.answerDueOn && open) parts.push(`answer by ${formatDay(employee.answerDueOn)}`);
    if (!employee.notified) parts.push("not notified");
    return parts.join(" · ");
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <header>
        <h1 className="text-lg font-black uppercase tracking-[0.12em] text-slate-800">Weekly attendance review</h1>
        <p className="mt-1 text-sm text-slate-600">
          Each closed week waits here. Remove any day that is wrong, then release the week. Released employees are told
          in-app and on Telegram, choose salary or annual balance for each day, and can dispute it. A day not answered
          within the deadline is deducted from salary.
        </p>
        {!canManage ? (
          <p className="mt-2 border-l-2 border-slate-400 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
            Only the Super Admin can remove days or release a week. You can see the weeks here and decide disputes.
          </p>
        ) : null}
      </header>

      {error ? (
        <p className="border-l-2 border-red-600 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</p>
      ) : null}
      {notice ? (
        <p className="border-l-2 border-emerald-600 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">{notice}</p>
      ) : null}

      {weeks.length === 0 && !error ? (
        <p className="border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">Nothing waiting for release or answers.</p>
      ) : null}

      {weeks.map((week) => {
        const people = week.employees.filter((employee) => employee.status !== "void");
        const flaggedDays = people.reduce(
          (sum, employee) => sum + employee.lines.filter((line) => line.action !== "removed").length,
          0,
        );
        const { open, answered } = progress(week);
        const confirming = confirmingWeek === week.key;
        const realPeople = people.filter((employee) => !employee.dryRun);
        const trialPeople = people.length - realPeople.length;
        const releasable = canManage && week.stage === "awaiting_release" && realPeople.length > 0;
        return (
          <section className="border border-slate-300 bg-white" key={week.key}>
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-700">
                  {formatDay(week.weekStart, false)} to {formatDay(week.weekEnd, false)}
                </h2>
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  {week.stage === "awaiting_release"
                    ? `Waiting for release · ${people.length} ${people.length === 1 ? "employee" : "employees"} · ${flaggedDays} ${flaggedDays === 1 ? "day" : "days"}`
                    : `Released${week.releasedAt ? ` ${formatCairoMoment(week.releasedAt)}` : ""} · ${answered} answered · ${open} still open`}
                </p>
                {week.dryRun ? (
                  <p className="mt-2 border-l-2 border-amber-600 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                    Trial run. This week can never be released; it is here to check what the real weeks will look like.
                  </p>
                ) : trialPeople > 0 && week.stage === "awaiting_release" ? (
                  <p className="mt-2 border-l-2 border-amber-600 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                    {trialPeople} {trialPeople === 1 ? "employee's week was" : "employees' weeks were"} built as a trial run and
                    will not be released with the others.
                  </p>
                ) : null}
              </div>
              {releasable && !confirming ? (
                <button
                  className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => setConfirmingWeek(week.key)}
                  type="button"
                >
                  Release this week
                </button>
              ) : null}
            </header>

            {releasable && confirming ? (
              <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-sm font-semibold text-slate-800">
                  Release to {realPeople.length} {realPeople.length === 1 ? "employee" : "employees"}? Each is told in-app and on
                  Telegram and has {answerWorkingDays} working {answerWorkingDays === 1 ? "day" : "days"} to answer.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => release(week)}
                    type="button"
                  >
                    Yes, release
                  </button>
                  <button
                    className="border border-slate-400 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => setConfirmingWeek(null)}
                    type="button"
                  >
                    Not yet
                  </button>
                </div>
              </div>
            ) : null}

            {/* Desktop: one fixed table, no min-width. */}
            <table className="hidden w-full table-fixed border-collapse md:table">
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[52%]" />
                <col className="w-[24%]" />
              </colgroup>
              <thead className="bg-slate-50 text-left text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="border-b border-slate-200 px-4 py-2">Employee</th>
                  <th className="border-b border-slate-200 px-4 py-2">Flagged days</th>
                  <th className="border-b border-slate-200 px-4 py-2">{week.stage === "released" ? "Answers" : "Week total"}</th>
                </tr>
              </thead>
              <tbody>
                {week.employees.map((employee) => (
                  <tr className="align-top" key={employee.digestId}>
                    <td className="break-words border-b border-slate-100 px-4 py-3">
                      <p className="text-sm font-bold text-slate-800">{employee.employeeName}</p>
                      {employee.jobTitle ? <p className="text-xs text-slate-500">{employee.jobTitle}</p> : null}
                    </td>
                    <td className="break-words border-b border-slate-100 px-4 py-3">
                      <div className="divide-y divide-slate-100">
                        {visibleLines(employee, week.stage).map((line) => (
                          dayBlock(week, employee, line, "table")
                        ))}
                      </div>
                    </td>
                    <td className="break-words border-b border-slate-100 px-4 py-3 text-sm text-slate-700">
                      {week.stage === "awaiting_release" ? (
                        <>
                          <p className="font-semibold">{daysText(employee.totalDeductionDays)}</p>
                          <p className="text-xs text-slate-500">{money(employee.totalDeductionValue, employee.currency)}</p>
                        </>
                      ) : null}
                      <p className="text-xs text-slate-500">{statusCell(week, employee)}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile: cards. */}
            <ul className="divide-y divide-slate-200 md:hidden">
              {week.employees.map((employee) => (
                <li className="px-4 py-3" key={employee.digestId}>
                  <p className="text-sm font-bold text-slate-800">{employee.employeeName}</p>
                  {employee.jobTitle ? <p className="text-xs text-slate-500">{employee.jobTitle}</p> : null}
                  <p className="mt-1 text-xs text-slate-500">
                    {week.stage === "awaiting_release"
                      ? `${daysText(employee.totalDeductionDays)} · ${money(employee.totalDeductionValue, employee.currency)} · `
                      : ""}
                    {statusCell(week, employee)}
                  </p>
                  <div className="mt-2 divide-y divide-slate-100 border-t border-slate-100 pt-2">
                    {visibleLines(employee, week.stage).map((line) => (
                      dayBlock(week, employee, line, "card")
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
