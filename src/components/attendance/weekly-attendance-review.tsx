"use client";

import { Fragment, useState } from "react";

import { MAX_MARKED_DAYS, type ReviewWeekStage } from "@/lib/attendance/digest-rules.ts";
import type { DigestLineRow, ReviewEmployee, ReviewWeek, ReviewWeekOption } from "@/lib/attendance/digest-service.ts";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// The owner's gate, 2026-09-15: every week lands here first, and nothing reaches an employee until it
// is released from this page. The same day: "I want to be able to select the week I want … I can mark
// on the days that I want them to be deducted … I want full control." So he picks a week, ticks the
// flagged days to deduct (every day starts unticked), may change a ticked day's days up or down, and an
// unticked day is cleared on release.
//
// 2026-09-17 — "Show live, release any time". A week is here from its first day and holds the days up
// to yesterday; the daily job, or Refresh, brings it up to date. He can release the days so far in the
// middle of the week, and later days go out in a second release of the same week.
//
// 2026-09-17 — "every row has a release beside it … so I can release one employee and after release
// another". Each waiting employee has their own Release; the others keep waiting, ticks untouched. The
// week's Release still sends everyone waiting at once.
//
// House rules this is built to:
//   • Square edges — no rounded-* classes.
//   • Never a horizontal scroll. Desktop is `w-full table-fixed` with a colgroup, fitted by
//     MERGING columns (a person's days sit in one cell), never by a min-width; below md the
//     same data is cards.
//   • Names, never HR IDs. Text wraps, never an ellipsis.

type Props = {
  initialWeeks: ReviewWeekOption[];
  initialWeek: ReviewWeek | null;
  initialError: string | null;
  answerWorkingDays: number;
  /** Super Admin only: tick days, refresh a week, release it. A dispute reviewer sees the page read-only. */
  canManage: boolean;
};

type MarkPayload = {
  lineId: number;
  digestId: number;
  deduct: boolean;
  deductionDays: number;
  deductionValue: number | null;
  detectedDays: number | null;
  adjusted: boolean;
  totalDeductionDays: number;
  totalDeductionValue: number | null;
  hasUnpricedDay: boolean;
};

const STAGE_LABEL: Record<ReviewWeekStage, string> = {
  not_built: "No flagged days yet",
  trial: "Trial run, read-only",
  awaiting_release: "Waiting for release",
  released: "Released",
  closed: "Released, nothing deducted",
};

const STATUS_LABEL: Record<string, string> = {
  late: "Arrived late",
  short_hours: "Short hours",
  early_leave: "Left early",
  missing_punch: "Missing punch",
  // A field day decided in the HR operations report (src/lib/hr-ops-reports/bridge.ts).
  field_review: "Field day (reviewed by HR)",
};

const ANSWER_LABEL: Record<string, string> = {
  pending: "Not answered yet",
  removed: "Cleared",
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

function countText(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function money(value: number | null, currency: string): string {
  return value === null ? "Amount not yet calculated" : `${value.toFixed(2)} ${currency}`;
}

function weekKey(week: { cycleKey: string; weekIndex: number }): string {
  return `${week.cycleKey}:${week.weekIndex}`;
}

function runningText(option: Pick<ReviewWeekOption, "running" | "throughIso">): string {
  return option.running ? `Running, days through ${formatDay(option.throughIso, false)}` : "";
}

function weekLabel(option: ReviewWeekOption): string {
  const people = option.employeeCount ? ` · ${countText(option.employeeCount, "employee", "employees")}` : "";
  const running = option.running ? ` · ${runningText(option)}` : "";
  return `${formatDay(option.weekStart, false)} to ${formatDay(option.weekEnd, false)}${running} · ${STAGE_LABEL[option.stage]}${people}`;
}

/** The release an employee's days belong to, when a week has been released more than once. */
function roundLabel(round: number): string {
  if (round === 2) return "Second release";
  if (round === 3) return "Third release";
  return `Release ${round}`;
}

/** An employee whose days can be released now: a real week, not yet released. */
function waitingForRelease(employee: ReviewEmployee): boolean {
  return !employee.dryRun && employee.status === "awaiting_release";
}

/** One employee's days waiting for release, as this page shows them. */
function employeeSeenLines(employee: ReviewEmployee): Array<{ id: number; days: number }> {
  return employee.lines.filter((line) => line.action === "pending").map((line) => ({ id: line.id, days: line.deductionDays }));
}

/** Every day waiting for release, as this page shows it. The release is refused if the server holds any other. */
function seenLines(week: ReviewWeek): Array<{ id: number; days: number }> {
  return week.employees.filter(waitingForRelease).flatMap((employee) => employeeSeenLines(employee));
}

function answerText(line: DigestLineRow): string {
  const base = ANSWER_LABEL[line.action] ?? line.action;
  if (line.action === "disputed" || line.action === "dispute_rejected") {
    return `${base} (${line.chosenMethod === "annual_balance" ? "annual balance" : "salary"})`;
  }
  return base;
}

/** What a release would do right now: the ticked days asked about, the unticked days cleared. */
function selection(employees: readonly ReviewEmployee[]) {
  let ticked = 0;
  let unticked = 0;
  let tickedDays = 0;
  const told = new Set<number>();
  for (const employee of employees) {
    if (!waitingForRelease(employee)) continue;
    for (const line of employee.lines) {
      if (line.action !== "pending") continue;
      if (line.deduct) {
        ticked += 1;
        tickedDays += line.deductionDays;
        told.add(employee.digestId);
      } else {
        unticked += 1;
      }
    }
  }
  return { ticked, unticked, tickedDays, employeesTold: told.size };
}

function progress(week: ReviewWeek) {
  let open = 0;
  let answered = 0;
  for (const employee of week.employees) {
    if (employee.dryRun) continue;
    for (const line of employee.lines) {
      if (line.action === "removed") continue;
      if (line.action === "pending" || line.action === "disputed") open += 1;
      else answered += 1;
    }
  }
  return { open, answered };
}

export function WeeklyAttendanceReview({ initialWeeks, initialWeek, initialError, answerWorkingDays, canManage }: Props) {
  const [weeks, setWeeks] = useState<ReviewWeekOption[]>(initialWeeks);
  const [week, setWeek] = useState<ReviewWeek | null>(initialWeek);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  /** The release being confirmed: the whole week, one employee's (by digest), or none. */
  const [confirming, setConfirming] = useState<"week" | number | null>(null);

  async function load(target: { cycleKey: string; weekIndex: number } | null) {
    const query = target ? `?cycleKey=${encodeURIComponent(target.cycleKey)}&weekIndex=${target.weekIndex}` : "";
    const response = await fetch(`/api/attendance/weekly-review${query}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload?.message ?? "The review could not be reloaded.");
      return;
    }
    setWeeks(payload.weeks ?? []);
    setWeek(payload.week ?? null);
    setDrafts({});
    setConfirming(null);
  }

  async function choose(key: string) {
    const option = weeks.find((candidate) => weekKey(candidate) === key);
    if (!option) return;
    setBusy("load");
    setError(null);
    setNotice(null);
    try {
      await load(option);
    } finally {
      setBusy(null);
    }
  }

  function applyMark(result: MarkPayload) {
    setWeek((current) =>
      current
        ? {
            ...current,
            employees: current.employees.map((employee) =>
              employee.digestId !== result.digestId
                ? employee
                : {
                    ...employee,
                    totalDeductionDays: result.totalDeductionDays,
                    totalDeductionValue: result.totalDeductionValue,
                    hasUnpricedDay: result.hasUnpricedDay,
                    lines: employee.lines.map((line) =>
                      line.id !== result.lineId
                        ? line
                        : {
                            ...line,
                            deduct: result.deduct,
                            deductionDays: result.deductionDays,
                            deductionValue: result.deductionValue,
                            detectedDays: result.detectedDays,
                            adjusted: result.adjusted,
                          },
                    ),
                  },
            ),
          }
        : current,
    );
  }

  function dropDraft(lineId: number) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[lineId];
      return next;
    });
  }

  async function mark(line: DigestLineRow, deduct: boolean, days?: number) {
    setBusy(`line:${line.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/weekly-review/lines/${line.id}/mark`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(days === undefined ? { deduct } : { deduct, days }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "The day could not be saved.");
      applyMark(payload as MarkPayload);
      if (days !== undefined) dropDraft(line.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The day could not be saved.");
      // Show what is really saved, not what was clicked.
      if (week) await load(week);
    } finally {
      setBusy(null);
    }
  }

  function saveDays(line: DigestLineRow) {
    const draft = drafts[line.id];
    if (draft === undefined) return;
    const value = Number(draft);
    if (!draft.trim() || !Number.isFinite(value) || value <= 0 || value > MAX_MARKED_DAYS) {
      setError(`Enter more than 0 and at most ${MAX_MARKED_DAYS} days. To clear the day, untick it.`);
      return;
    }
    void mark(line, true, value);
  }

  async function refresh(current: ReviewWeek) {
    setBusy("refresh");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/attendance/weekly-review/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycleKey: current.cycleKey, weekIndex: current.weekIndex }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "The week could not be brought up to date.");
      const added = Number(payload.daysAdded ?? 0);
      const updated = Number(payload.daysUpdated ?? 0);
      const cleared = Number(payload.daysCleared ?? 0);
      const through = typeof payload.throughIso === "string" ? ` through ${formatDay(payload.throughIso, false)}` : "";
      const changes =
        added || updated || cleared
          ? `${countText(added, "new day", "new days")}, ${countText(updated, "day", "days")} with new figures, ${countText(cleared, "day", "days")} taken off because the report no longer flags ${cleared === 1 ? "it" : "them"}.`
          : "Nothing changed.";
      setNotice(`Up to date${through}. ${changes} Nothing was sent.${added ? " New days start unticked." : ""}`);
      const failures = Array.isArray(payload.failures) ? (payload.failures as string[]) : [];
      if (failures.length) setError(`These employees could not be brought up to date: ${failures.join("; ")}. Press Refresh again.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The week could not be brought up to date.");
    } finally {
      await load(current);
      setBusy(null);
    }
  }

  async function release(current: ReviewWeek) {
    setBusy("release");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/attendance/weekly-review/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cycleKey: current.cycleKey, weekIndex: current.weekIndex, seenLines: seenLines(current) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "The week could not be released.");
      const notified = Number(payload.notified ?? 0);
      const notNotified = Number(payload.notNotified ?? 0);
      const cleared = Number(payload.clearedDays ?? 0);
      setNotice(
        `Released. ${countText(notified, "employee was", "employees were")} told by email, on Telegram or in the app. ` +
          `${countText(cleared, "unticked day was", "unticked days were")} cleared and will never be deducted.` +
          (notNotified > 0
            ? ` ${countText(notNotified, "employee was", "employees were")} not counted as told (no email or Telegram reached them and they have never signed in, or they have left). Their days wait for HR and are never deducted automatically for going unanswered.`
            : ""),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The week could not be released.");
    } finally {
      await load(current);
      setBusy(null);
    }
  }

  /** Release one employee's days only; everyone else in the week keeps waiting. */
  async function releaseEmployee(current: ReviewWeek, employee: ReviewEmployee) {
    setBusy(`release:${employee.digestId}`);
    setError(null);
    setNotice(null);
    const name = employee.employeeName;
    const othersWaiting = current.employees.filter((other) => waitingForRelease(other) && other.digestId !== employee.digestId).length;
    try {
      const response = await fetch("/api/attendance/weekly-review/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cycleKey: current.cycleKey,
          weekIndex: current.weekIndex,
          digestId: employee.digestId,
          seenLines: employeeSeenLines(employee),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? `${name}'s days could not be released.`);
      const notified = Number(payload.notified ?? 0);
      const notNotified = Number(payload.notNotified ?? 0);
      const cleared = Number(payload.clearedDays ?? 0);
      setNotice(
        `Released for ${name}.` +
          (notified ? " They were told by email, on Telegram or in the app." : "") +
          (cleared ? ` ${countText(cleared, "unticked day was", "unticked days were")} cleared and will never be deducted.` : "") +
          (notNotified
            ? " They were not counted as told (no email or Telegram reached them and they have never signed in, or they have left): they still see the week on their page, and their days wait for HR and are never deducted automatically for going unanswered."
            : "") +
          (othersWaiting ? ` ${countText(othersWaiting, "other employee is", "other employees are")} still waiting for release.` : ""),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${name}'s days could not be released.`);
    } finally {
      await load(current);
      setBusy(null);
    }
  }

  function dayBlock(current: ReviewWeek, employee: ReviewEmployee, line: DigestLineRow, layout: "table" | "card") {
    const canMark =
      canManage && current.stage === "awaiting_release" && employee.status === "awaiting_release" && !employee.dryRun && line.action === "pending";
    const cleared = line.action === "removed";
    const waiting = line.action === "pending" && employee.status === "awaiting_release" && !employee.dryRun;
    const draft = drafts[line.id];
    const dirty = draft !== undefined && Number(draft) !== line.deductionDays;
    const id = `${layout}-${line.id}`;
    const tone = cleared ? "text-slate-400 line-through" : waiting && !line.deduct ? "text-slate-500" : "text-slate-800";
    const summary = (
      <>
        <span className="font-semibold">{formatDay(line.workDate)}</span> · {STATUS_LABEL[line.status] ?? line.status} ·{" "}
        {daysText(line.deductionDays)} · {money(line.deductionValue, employee.currency)}
      </>
    );
    return (
      <div className="py-2 first:pt-0 last:pb-0" key={line.id}>
        <div className="flex items-start gap-2">
          {canMark ? (
            <input
              checked={line.deduct}
              className="mt-0.5 h-4 w-4 flex-none accent-slate-800"
              disabled={busy !== null}
              id={`tick-${id}`}
              onChange={(event) => void mark(line, event.target.checked)}
              type="checkbox"
            />
          ) : null}
          {canMark ? (
            <label className={`min-w-0 flex-1 text-sm ${tone}`} htmlFor={`tick-${id}`}>
              {summary}
            </label>
          ) : (
            <p className={`min-w-0 flex-1 text-sm ${tone}`}>{summary}</p>
          )}
        </div>
        <div className={canMark ? "pl-6" : ""}>
          {line.reason ? <p className="text-xs text-slate-500">{line.reason}</p> : null}
          {line.adjusted && line.detectedDays !== null ? (
            <p className="text-xs font-semibold text-slate-600">Changed from the {daysText(line.detectedDays)} detected</p>
          ) : null}
          {cleared && line.removeReason ? (
            <p className="text-xs font-semibold text-slate-500" dir="auto">
              Cleared: {line.removeReason}
            </p>
          ) : null}
          {line.action !== "pending" && !cleared ? (
            <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{answerText(line)}</p>
          ) : null}
          {waiting ? (
            <p className="text-xs font-semibold text-slate-500">
              {line.deduct ? "Ticked: the employee is asked about it on release" : "Not ticked: cleared on release, never deducted"}
            </p>
          ) : null}
          {canMark && line.deduct ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <label className="text-xs font-black uppercase tracking-[0.12em] text-slate-600" htmlFor={`days-${id}`}>
                Days to deduct
              </label>
              <input
                className={cn(phxFieldClassName, "w-20")}
                id={`days-${id}`}
                inputMode="decimal"
                max={MAX_MARKED_DAYS}
                min={0.125}
                onChange={(event) => setDrafts((existing) => ({ ...existing, [line.id]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveDays(line);
                }}
                step={0.125}
                type="number"
                value={draft ?? String(line.deductionDays)}
              />
              {dirty ? (
                <>
                  <button
                    className="border border-slate-800 bg-slate-800 px-2 py-1 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => saveDays(line)}
                    type="button"
                  >
                    Save
                  </button>
                  <button
                    className="border border-slate-400 bg-white px-2 py-1 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
                    disabled={busy !== null}
                    onClick={() => dropDraft(line.id)}
                    type="button"
                  >
                    Undo
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function statusCell(employee: ReviewEmployee): string {
    if (employee.dryRun) return "Trial run";
    if (employee.status === "awaiting_release") {
      const ticked = employee.lines.filter((line) => line.action === "pending" && line.deduct).length;
      return ticked ? `${countText(ticked, "day", "days")} ticked` : "Nothing ticked";
    }
    if (employee.status === "void") return "Nothing deducted";
    const open = employee.lines.filter((line) => line.action === "pending").length;
    const disputed = employee.lines.filter((line) => line.action === "disputed").length;
    const parts = [];
    if (open) parts.push(`${open} not answered`);
    if (disputed) parts.push(`${disputed} disputed`);
    if (!parts.length) parts.push("All answered");
    if (employee.answerDueOn && open) parts.push(`answer by ${formatDay(employee.answerDueOn)}`);
    if (!employee.notified && open) parts.push("not notified");
    return parts.join(" · ");
  }

  const pick = week ? selection(week.employees) : null;
  const releasable =
    canManage && week !== null && week.stage === "awaiting_release" && week.employees.some((employee) => waitingForRelease(employee));
  const canRefresh = canManage && week !== null && week.canRefresh;
  // The week's button sends everyone still waiting; each employee's row has its own.
  const releaseLabel = week?.releasedAt ? "Release everyone waiting" : week?.running ? "Release everyone, days so far" : "Release everyone";

  function employeeReleasable(current: ReviewWeek, employee: ReviewEmployee): boolean {
    return canManage && current.stage === "awaiting_release" && waitingForRelease(employee);
  }

  function employeeReleaseButton(current: ReviewWeek, employee: ReviewEmployee) {
    if (!employeeReleasable(current, employee) || confirming === employee.digestId) return null;
    return (
      <button
        aria-label={`Release ${employee.employeeName} only`}
        className="mt-2 border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
        disabled={busy !== null}
        onClick={() => setConfirming(employee.digestId)}
        type="button"
      >
        Release
      </button>
    );
  }

  function employeeConfirmation(current: ReviewWeek, employee: ReviewEmployee) {
    const name = employee.employeeName;
    const counts = selection([employee]);
    const others = current.employees.filter((other) => waitingForRelease(other) && other.digestId !== employee.digestId).length;
    return (
      <>
        <p className="text-sm font-semibold text-slate-800">
          {counts.ticked === 0
            ? `Nothing is ticked for ${name}. Releasing clears their ${countText(counts.unticked, "flagged day", "flagged days")}: none is deducted and ${name} is not told.`
            : `Release ${countText(counts.ticked, "ticked day", "ticked days")} (${daysText(counts.tickedDays)}) to ${name}? They are told by email, on Telegram and in the app, and have ${countText(answerWorkingDays, "working day", "working days")} to choose salary or annual balance.` +
              (counts.unticked ? ` The ${countText(counts.unticked, "unticked day", "unticked days")} will be cleared and never deducted.` : "")}
          {others ? ` The other ${countText(others, "employee keeps", "employees keep")} waiting.` : ""}
          {current.running ? " Days from later in this week wait for a second release." : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => void releaseEmployee(current, employee)}
            type="button"
          >
            {busy === `release:${employee.digestId}` ? "Releasing" : "Yes, release"}
          </button>
          <button
            className="border border-slate-400 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => setConfirming(null)}
            type="button"
          >
            Not yet
          </button>
        </div>
      </>
    );
  }

  function weekSummary(current: ReviewWeek): string {
    const running = current.running ? `${runningText(current)} · ` : "";
    switch (current.stage) {
      case "awaiting_release": {
        const counts = selection(current.employees);
        const earlier = current.releasedAt ? ` · last release ${formatCairoMoment(current.releasedAt)}` : "";
        return `${running}Waiting for release · ${countText(current.employeeCount, "employee", "employees")} · ${counts.ticked} of ${counts.ticked + counts.unticked} days ticked · ${daysText(counts.tickedDays)} to deduct${earlier}`;
      }
      case "released":
      case "closed": {
        const { open, answered } = progress(current);
        return `${running}Released${current.releasedAt ? ` ${formatCairoMoment(current.releasedAt)}` : ""} · ${answered} answered · ${open} still open`;
      }
      case "trial":
        return "Trial run · read-only";
      default:
        return `${running}No flagged days yet`;
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <header>
        <h1 className="text-lg font-black uppercase tracking-[0.12em] text-slate-800">Weekly attendance review</h1>
        <p className="mt-1 text-sm text-slate-600">
          Pick a week. A week shows its flagged days up to yesterday and is brought up to date every morning and
          afternoon, or when you press Refresh. Tick the flagged days to deduct and set how many days each one takes; a
          day you do not tick is cleared when you release and never deducted. Release one employee from their own row
          and the others keep waiting, or release everyone waiting at once. You can release the days so far at any
          time, and days that arrive later wait for a second release. On release each employee is told by email, on
          Telegram and in the app, chooses salary or annual balance for each ticked day, and can dispute it. A day not answered within
          the deadline is deducted from salary.
        </p>
        {!canManage ? (
          <p className="mt-2 border-l-2 border-slate-400 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
            Only the Super Admin can tick days, refresh a week or release it. You can see the weeks here and decide disputes.
          </p>
        ) : null}
      </header>

      {weeks.length ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-black uppercase tracking-[0.12em] text-slate-600" htmlFor="weekly-review-week">
            Week
          </label>
          <select
            className={`${phxSelectClassName} max-w-xl`}
            disabled={busy !== null}
            id="weekly-review-week"
            onChange={(event) => void choose(event.target.value)}
            value={week ? weekKey(week) : ""}
          >
            {week ? null : <option value="">Choose a week</option>}
            {weeks.map((option) => (
              <option key={weekKey(option)} value={weekKey(option)}>
                {weekLabel(option)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {error ? (
        <p className="border-l-2 border-red-600 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</p>
      ) : null}
      {notice ? (
        <p className="border-l-2 border-emerald-600 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">{notice}</p>
      ) : null}

      {!weeks.length && !error ? (
        <p className="border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">No week of this month has started yet.</p>
      ) : null}

      {week ? (
        <section className="border border-slate-300 bg-white">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-700">
                {formatDay(week.weekStart, false)} to {formatDay(week.weekEnd, false)}
              </h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">{weekSummary(week)}</p>
              {week.stage === "trial" ? (
                <p className="mt-2 border-l-2 border-amber-600 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                  Trial run. This week can never be released or changed; it is here to check what the real weeks look like.
                </p>
              ) : week.stage === "awaiting_release" && week.employees.some((employee) => employee.dryRun) ? (
                <p className="mt-2 border-l-2 border-amber-600 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                  Some employees&apos; weeks were built as a trial run and will not be released with the others.
                </p>
              ) : null}
            </div>
            {releasable && confirming !== "week" ? (
              <button
                className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => setConfirming("week")}
                type="button"
              >
                {releaseLabel}
              </button>
            ) : null}
            {canRefresh ? (
              <button
                className="border border-slate-400 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void refresh(week)}
                type="button"
              >
                {busy === "refresh" ? "Refreshing" : "Refresh"}
              </button>
            ) : null}
          </header>

          {releasable && confirming === "week" && pick ? (
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-sm font-semibold text-slate-800">
                {pick.ticked === 0
                  ? `Nothing is ticked. Releasing clears all ${countText(pick.unticked, "flagged day", "flagged days")} in this week: none is deducted and no employee is told.`
                  : `Release ${countText(pick.ticked, "ticked day", "ticked days")} (${daysText(pick.tickedDays)}) to ${countText(pick.employeesTold, "employee", "employees")}? Each is told by email, on Telegram and in the app, and has ${countText(answerWorkingDays, "working day", "working days")} to choose salary or annual balance.` +
                    (pick.unticked ? ` The ${countText(pick.unticked, "unticked day", "unticked days")} will be cleared and never deducted.` : "")}
                {week.running ? " Days from later in this week wait for a second release." : ""}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void release(week)}
                  type="button"
                >
                  Yes, release
                </button>
                <button
                  className="border border-slate-400 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => setConfirming(null)}
                  type="button"
                >
                  Not yet
                </button>
              </div>
            </div>
          ) : null}

          {week.stage === "not_built" ? (
            <p className="px-4 py-6 text-sm text-slate-600">
              {canManage
                ? "No flagged day in this week so far. Press Refresh to check the latest punches. Nothing is sent to anyone until you release it."
                : "No flagged day in this week so far."}
            </p>
          ) : null}

          {week.employees.length ? (
            <>
              {/* Desktop: one fixed table, no min-width. */}
              <table className="hidden w-full table-fixed border-collapse md:table">
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[58%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead className="bg-slate-50 text-left text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-4 py-2">Employee</th>
                    <th className="border-b border-slate-200 px-4 py-2">Flagged days</th>
                    <th className="border-b border-slate-200 px-4 py-2">{week.stage === "awaiting_release" ? "To deduct" : "Answers"}</th>
                  </tr>
                </thead>
                <tbody>
                  {week.employees.map((employee) => (
                    <Fragment key={employee.digestId}>
                      <tr className="align-top">
                        <td className="break-words border-b border-slate-100 px-4 py-3">
                          <p className="text-sm font-bold text-slate-800">{employee.employeeName}</p>
                          {employee.jobTitle ? <p className="text-xs text-slate-500">{employee.jobTitle}</p> : null}
                          {employee.releaseRound >= 2 ? (
                            <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{roundLabel(employee.releaseRound)}</p>
                          ) : null}
                        </td>
                        <td className="break-words border-b border-slate-100 px-4 py-3">
                          <div className="divide-y divide-slate-100">{employee.lines.map((line) => dayBlock(week, employee, line, "table"))}</div>
                        </td>
                        <td className="break-words border-b border-slate-100 px-4 py-3 text-sm text-slate-700">
                          {employee.status === "awaiting_release" && !employee.dryRun ? (
                            <>
                              <p className="font-semibold">{daysText(employee.totalDeductionDays)}</p>
                              <p className="text-xs text-slate-500">{money(employee.totalDeductionValue, employee.currency)}</p>
                            </>
                          ) : null}
                          <p className="text-xs text-slate-500">{statusCell(employee)}</p>
                          {employeeReleaseButton(week, employee)}
                        </td>
                      </tr>
                      {confirming === employee.digestId && employeeReleasable(week, employee) ? (
                        <tr>
                          <td className="border-b border-slate-200 bg-slate-50 px-4 py-3" colSpan={3}>
                            {employeeConfirmation(week, employee)}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>

              {/* Mobile: cards. */}
              <ul className="divide-y divide-slate-200 md:hidden">
                {week.employees.map((employee) => (
                  <li className="px-4 py-3" key={employee.digestId}>
                    <p className="text-sm font-bold text-slate-800">{employee.employeeName}</p>
                    {employee.jobTitle ? <p className="text-xs text-slate-500">{employee.jobTitle}</p> : null}
                    {employee.releaseRound >= 2 ? (
                      <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{roundLabel(employee.releaseRound)}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-500">
                      {employee.status === "awaiting_release" && !employee.dryRun
                        ? `To deduct ${daysText(employee.totalDeductionDays)} · ${money(employee.totalDeductionValue, employee.currency)} · `
                        : ""}
                      {statusCell(employee)}
                    </p>
                    {employeeReleaseButton(week, employee)}
                    {confirming === employee.digestId && employeeReleasable(week, employee) ? (
                      <div className="mt-2 border-l-2 border-slate-400 bg-slate-50 px-3 py-2">{employeeConfirmation(week, employee)}</div>
                    ) : null}
                    <div className="mt-2 divide-y divide-slate-100 border-t border-slate-100 pt-2">
                      {employee.lines.map((line) => dayBlock(week, employee, line, "card"))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : week.stage !== "not_built" ? (
            <p className="px-4 py-6 text-sm text-slate-600">No employee has a flagged day in this week.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
