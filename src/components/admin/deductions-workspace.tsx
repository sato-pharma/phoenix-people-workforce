"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Download, PlayCircle, RotateCcw, UserMinus, UserPlus, XCircle } from "lucide-react";

import {
  DEDUCTIONS_CATEGORY_CONFIG,
  daysForTickedDates,
  resolveAppliedDeductionDates,
  scaleDeductionAmountToDays,
} from "@/lib/deductions/calculations.ts";
import {
  isLeaveBalanceCategory,
  visibleDeductionsCategories,
  type DeductionsCategory,
} from "@/lib/deductions/types.ts";
import {
  cycleWindow,
  isCycleWindowCollectable,
  isSplitCycleMonth,
  type DeductionCycle,
} from "@/lib/deductions/cycle.ts";
import { findSameDayOverlaps, type SameDayOverlap } from "@/lib/deductions/day-overlap.ts";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import {
  phxButtonApproveDenseClassName,
  phxFieldClassName,
  phxLabelClassName,
  phxRequiredMarkClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

import { DisputesTab } from "./deductions-disputes-tab";

type CandidateApiRow = {
  id: string;
  category: DeductionsCategory;
  employeeHrId: string;
  employeeName: string | null;
  /** Resolved from the employees table at read time — see service.ts. */
  hireDate?: string | null;
  /** Days of this candidate that sit directly beside a governmental holiday. */
  holidayBridges?: Array<{ date: string; adjacentTo: "before" | "after"; holidayName: string }>;
  monthKey: string;
  unit: "days" | "amount";
  rawValue: number;
  estimatedAmount: number | null;
  calculationStatus: "calculated" | "requires_review";
  severity: "Low" | "Medium" | "High" | "Review" | null;
  reason: string | null;
  dates: string[];
  decision: {
    id: string;
    decisionStatus: string;
    decisionReason: string;
    hrNote: string;
    appliedValue: number | null;
    appliedAmount: number | null;
    /** null = never narrowed (every detected day charges); [] = all days cleared. */
    appliedDates: string[] | null;
    decidedBy: string | null;
    decidedAt: string | null;
  } | null;
  /**
   * The id of this candidate's ACTIVE pushed line, or null when it has not been
   * pushed. A pushed candidate is released to the employee's portal and to
   * payroll and is locked against edits; withdrawing its line (this id) frees it
   * again. Loaded by the candidates route from the active publication lines.
   */
  pushedLineId?: string | null;
  /**
   * Set when this deduction is taken from the employee's annual leave instead of salary (owner,
   * 2026-10-09): the net days charged and the comment the employee reads. Null when paid from salary.
   */
  leaveBalanceCharge?: { days: number; comment: string; chargedAt: string } | null;
};

/**
 * The day-of-month number for an ISO date.
 *
 * Day numbers rather than full ISO dates because the workspace is already scoped to a
 * single month, so "2026-07-" on every entry is pure repetition — and a 19-day CRM
 * candidate rendered as full dates cannot fit on one line, which would force either a
 * wrap or an ellipsis. Both are barred by the admin-shell rules.
 */
function dayOfMonth(date: string): number {
  return Number(String(date).slice(8, 10));
}

const MONTH_ABBREVIATIONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "22 Oct" — a day WITH its month. Used once a row's days run across two months: a Head Office cycle
 * row (lib/deductions/cycle.ts) holds the 22nd of the previous month → the 21st, and day numbers alone
 * would make 22 October read as 22 November.
 */
function dayWithMonth(date: string): string {
  const month = Number(String(date).slice(5, 7));
  return `${dayOfMonth(date)} ${MONTH_ABBREVIATIONS[month - 1] ?? ""}`.trim();
}

/** True when any of the row's days fall outside its own payroll month (a Head Office cycle row). */
function rowSpansMonths(row: Pick<CandidateApiRow, "monthKey" | "dates">): boolean {
  const monthKey = String(row.monthKey).slice(0, 7);
  return (row.dates ?? []).some((date) => !String(date).startsWith(monthKey));
}

/** A row's day as the reviewer reads it — the day number, or "22 Oct" on a row spanning two months. */
function rowDayLabel(row: Pick<CandidateApiRow, "monthKey" | "dates">, date: string): string {
  return rowSpansMonths(row) ? dayWithMonth(date) : String(dayOfMonth(date));
}

/**
 * A person is shown by NAME, never by an HR code — the owner's standing rule,
 * and the reason this helper exists rather than a `?? row.employeeHrId`
 * fallback. The name is resolved server-side (service.ts fills a missing one
 * from the employees directory), so this only guards the case where the person
 * genuinely has no name anywhere.
 */
function employeeLabel(row: CandidateApiRow): string {
  return row.employeeName?.trim() || "Name unavailable";
}

/**
 * The hiring date, as a plain calendar date.
 *
 * Formatted in UTC from its own Y/M/D parts and never shifted into Cairo: this
 * is a DATE column, not an instant, and running it through a timezone is how a
 * hire date lands a day early.
 */
function hireDateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const [year, month, day] = String(value).slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return "—";
  return stableEnGbFormatter({ day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** Sunday-first, matching buildHrCalendarDays in hr-calendar/calendar-logic.ts. */
const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** Friday is the one day off for EVERY population — see isFieldWorkforceWeeklyOff. */
const FRIDAY_COLUMN = 5;

/**
 * The month laid out as a real calendar: leading blanks to the first weekday,
 * then every day, padded to whole weeks. Sunday-first to match the HR calendar
 * this company already reads.
 *
 * Built in UTC from the month key's own parts. A local-time Date would put the
 * first-of-month on the wrong weekday for anyone east of GMT, which silently
 * rotates the entire grid by a day.
 */
function buildMonthGrid(monthKey: string, dates: readonly string[] = []): Array<string | null> {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return [];
  // A Head Office cycle row starts on the 22nd of the PREVIOUS month — the grid starts there too, so
  // every one of its days can be seen and unticked, not only the ones inside the payroll month.
  const monthStart = Date.UTC(year, month - 1, 1);
  const earliest = dates
    .filter((date) => /^\d{4}-\d{2}-\d{2}/.test(date))
    .map((date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))))
    .reduce((min, value) => Math.min(min, value), monthStart);
  const end = Date.UTC(year, month, 0);
  const cells: Array<string | null> = Array.from({ length: new Date(earliest).getUTCDay() }, () => null);
  for (let at = earliest; at <= end; at += 86_400_000) {
    cells.push(new Date(at).toISOString().slice(0, 10));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * "6 Oct · before" — which governmental holiday this row's day touches, and on
 * which side. Named because "flagged" alone leaves the reviewer to work out
 * WHY, and the reason is the entire justification for the deduction.
 */
function HolidayBridgeCell({ row }: { row: CandidateApiRow }) {
  const bridges = row.holidayBridges ?? [];
  if (bridges.length === 0) return <span className="text-slate-300">—</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {bridges.map((bridge) => (
        <span className="break-words text-phx-xs font-bold text-orange-700" key={`${bridge.date}:${bridge.adjacentTo}`}>
          {rowDayLabel(row, bridge.date)} {bridge.adjacentTo === "before" ? "before" : "after"} {bridge.holidayName}
        </span>
      ))}
    </span>
  );
}

function sortedDates(dates: readonly string[] | null | undefined): string[] {
  return [...(dates ?? [])].filter((date) => Number.isInteger(dayOfMonth(date)) && dayOfMonth(date) > 0).sort();
}

/** The days this candidate currently charges, per the saved decision. */
function appliedDatesOf(row: CandidateApiRow): string[] {
  return sortedDates(resolveAppliedDeductionDates(row));
}

/**
 * Detected days on one line, with the ones the reviewer removed struck through
 * rather than deleted. "14 detected, 12 charged, and these are the 2 I dropped"
 * is the sentence a reviewer needs; silently rendering only the survivors makes
 * a narrowed row indistinguishable from one that never had those days at all.
 */
function DayList({ row }: { row: CandidateApiRow }) {
  const detected = sortedDates(row.dates);
  if (detected.length === 0) return <span className="text-slate-400">—</span>;
  const applied = new Set(appliedDatesOf(row));
  return (
    <span className="tabular-nums">
      {detected.map((date, index) => (
        <span className={applied.has(date) ? "text-slate-700" : "text-slate-400 line-through"} key={date}>
          {rowDayLabel(row, date)}
          {index < detected.length - 1 ? ", " : ""}
        </span>
      ))}
    </span>
  );
}

/** The days a set of ticked dates charges on this candidate — a half-day date is 0.5, not 1. */
function tickedDays(row: CandidateApiRow, tickedDates: number): number {
  return daysForTickedDates({ rawValue: row.rawValue, detectedDates: sortedDates(row.dates).length, tickedDates });
}

/** The day count a candidate currently charges. */
function appliedDaysOf(row: CandidateApiRow): number {
  if (row.unit !== "days") return 0;
  if (row.decision?.appliedValue != null) return row.decision.appliedValue;
  return row.decision?.appliedDates != null ? tickedDays(row, row.decision.appliedDates.length) : row.rawValue;
}

/** What this candidate currently costs — the same scaling rule the server re-derives on save. */
function appliedAmountOf(row: CandidateApiRow): number | null {
  if (row.decision?.appliedAmount != null) return row.decision.appliedAmount;
  if (row.unit !== "days") return row.estimatedAmount;
  return scaleDeductionAmountToDays({
    estimatedAmount: row.estimatedAmount,
    rawValue: row.rawValue,
    appliedDays: appliedDaysOf(row),
  });
}

/**
 * Tick the days that should be deducted; the quantity follows, and the amount
 * follows the quantity.
 *
 * Every detected day starts TICKED, because every detected day is what this
 * module charges today — starting empty would read as "nothing is deducted until
 * you confirm each day", quietly zeroing a month that nobody had reviewed yet.
 * So the reviewer's action here is removal, and the quantity is the count of
 * what is left unless they type over it.
 */
function DeductionDaysEditor({
  row,
  onSaved,
  onClose,
}: {
  row: CandidateApiRow;
  onSaved: (candidateId: string, decision: CandidateApiRow["decision"]) => void;
  onClose: () => void;
}) {
  const detected = useMemo(() => sortedDates(row.dates), [row.dates]);
  const [selected, setSelected] = useState<string[]>(() => appliedDatesOf(row));
  // Held as a string, not a number: a controlled number input that coerces on
  // every keystroke cannot be cleared to retype it.
  const [quantity, setQuantity] = useState<string>(() =>
    // A loan/other candidate has no days — its applied VALUE is the money, so it
    // seeds from the amount. Seeding it from the (always zero) day count would
    // offer to write the deduction down to nothing the moment it was opened.
    String(row.unit === "days" ? appliedDaysOf(row) : (row.decision?.appliedValue ?? row.rawValue)),
  );
  const [manualQuantity, setManualQuantity] = useState(
    () => row.unit === "days" && row.decision?.appliedValue != null && row.decision.appliedValue !== tickedDays(row, appliedDatesOf(row).length),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the days were saved but payroll could not follow them (Part 2
  // already confirmed, or the resync failed) — the editor stays open to say so.
  const [payrollNotice, setPayrollNotice] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const detectedSet = useMemo(() => new Set(detected), [detected]);
  const monthGrid = useMemo(() => buildMonthGrid(row.monthKey, row.dates ?? []), [row.monthKey, row.dates]);
  const spansMonths = rowSpansMonths(row);
  const parsedQuantity = Number(quantity);
  const quantityValid = quantity.trim() !== "" && Number.isFinite(parsedQuantity) && parsedQuantity >= 0;
  const overDetected = quantityValid && row.unit === "days" && parsedQuantity > row.rawValue;
  const previewAmount =
    quantityValid && !overDetected
      ? scaleDeductionAmountToDays({
          estimatedAmount: row.estimatedAmount,
          rawValue: row.rawValue,
          appliedDays: parsedQuantity,
        })
      : null;

  function toggleDay(date: string) {
    // Computed outside the updater, not inside it: a state updater must stay
    // pure, and React may invoke it more than once.
    const next = selected.includes(date) ? selected.filter((entry) => entry !== date) : [...selected, date].sort();
    setSelected(next);
    // The point of the checkboxes: the quantity auto-populates from them. It
    // stops following only once the reviewer has typed a number of their own.
    if (!manualQuantity) setQuantity(String(tickedDays(row, next.length)));
  }

  function setAll(checked: boolean) {
    const next = checked ? [...detected] : [];
    setSelected(next);
    if (!manualQuantity) setQuantity(String(tickedDays(row, next.length)));
  }

  function resetQuantityToTicks() {
    setManualQuantity(false);
    setQuantity(String(tickedDays(row, selected.length)));
  }

  async function save() {
    if (!quantityValid) {
      setError("Enter the number of days to deduct.");
      return;
    }
    if (overDetected) {
      setError(`Only ${row.rawValue} day(s) were detected — you cannot deduct more than that.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Carry the existing decision forward untouched. This control edits the
      // days, not the verdict — re-sending the status and reason keeps a row
      // that was already "Approved for Payroll" approved, and keeps the DB's
      // reason-required-when-decided constraint satisfied.
      const status = row.decision?.decisionStatus ?? "Pending";
      const payload = await fetchJson<{
        decision: CandidateApiRow["decision"] & { payrollNotices?: string[] };
      }>("/api/admin/deductions/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId: row.id,
          decisionStatus: status,
          decisionReason: row.decision?.decisionReason ?? "",
          hrNote: row.decision?.hrNote ?? "",
          appliedValue: parsedQuantity,
          appliedDates: selected,
        }),
      });
      const notices = payload.decision?.payrollNotices ?? [];
      onSaved(row.id, payload.decision);
      if (notices.length > 0) {
        setPayrollNotice(notices.join(" "));
        return;
      }
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save these days.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 border border-orange-200 bg-orange-50/50 p-3">
      {detected.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">Days to deduct</p>
            <button
              className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500 underline transition hover:text-orange-600"
              onClick={() => setAll(true)}
              type="button"
            >
              Select all
            </button>
            <button
              className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500 underline transition hover:text-orange-600"
              onClick={() => setAll(false)}
              type="button"
            >
              Clear all
            </button>
          </div>
          {/* A real month calendar, not a row of chips. "Days 5, 8, 12, 14, 18…"
              tells a reviewer nothing about the SHAPE of the absence; the same
              days on a calendar immediately show whether someone missed every
              Sunday, a solid week, or scattered singles. Days the engine did not
              flag are still drawn, greyed and inert, because the gaps are half
              the picture. */}
          {/* FITS THE SCREEN. Seven `1fr` tracks inside a phone card are about 34px
              each at 375px and 27px at 320px, but every cell used to hold a 2.4rem
              (38px) floor, so the last column ran out of its own box and a 320px
              phone pushed past the card's edge. Below `sm` the calendar takes the
              full card width, the cell floor is dropped, and the tick box sits ABOVE
              the day number instead of beside it — the number is the same size, and
              the cell now needs about 17px rather than 33px. From `sm` up it is the
              compact inline calendar it always was. */}
          {spansMonths && detected.length > 0 ? (
            <p className="text-xs font-semibold text-slate-600">
              Head Office cycle — this row runs {dayWithMonth(detected[0])} to{" "}
              {dayWithMonth(detected[detected.length - 1])}. The calendar starts on the first of those days.
            </p>
          ) : null}
          <div className="block w-full border border-slate-200 bg-white p-2 sm:inline-block sm:w-auto">
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAY_LABELS.map((label, index) => (
                <div
                  className={[
                    "px-1 pb-1 text-center text-phx-2xs font-black uppercase tracking-[0.06em]",
                    index === FRIDAY_COLUMN ? "text-orange-500" : "text-slate-400",
                  ].join(" ")}
                  key={label}
                >
                  {label}
                </div>
              ))}
              {monthGrid.map((date, index) => {
                if (!date) return <div className="h-9" key={`pad-${index}`} />;
                const isFriday = index % 7 === FRIDAY_COLUMN;
                if (!detectedSet.has(date)) {
                  return (
                    <div
                      className={[
                        "flex h-9 min-w-0 items-center justify-center text-xs tabular-nums sm:min-w-[2.4rem]",
                        isFriday ? "bg-orange-50/60 text-slate-300" : "text-slate-300",
                      ].join(" ")}
                      key={date}
                    >
                      {dayOfMonth(date)}
                    </div>
                  );
                }
                const checked = selectedSet.has(date);
                return (
                  <label
                    className={[
                      "flex h-9 min-w-0 cursor-pointer flex-col items-center justify-center gap-0.5 whitespace-nowrap border text-xs font-bold tabular-nums transition sm:min-w-[2.4rem] sm:flex-row sm:gap-1",
                      checked
                        ? "border-orange-400 bg-white text-slate-900"
                        : "border-slate-200 bg-slate-100 text-slate-400 line-through",
                    ].join(" ")}
                    key={date}
                    title={date}
                  >
                    <input
                      checked={checked}
                      className="h-3 w-3 accent-orange-500"
                      onChange={() => toggleDay(date)}
                      type="checkbox"
                    />
                    {dayOfMonth(date)}
                  </label>
                );
              })}
            </div>
          </div>
          {/* Friday is the only day off for EVERY population — Saturday depends
              on the job title (isFieldWorkforceWeeklyOff), so it is deliberately
              not tinted here rather than asserting a rule that is wrong for half
              the company. */}
          <p className="text-phx-2xs font-semibold uppercase tracking-[0.08em] text-slate-400">
            Tickable days are the ones detected · greyed days were not flagged · Friday column tinted
          </p>
        </div>
      ) : (
        <p className="text-xs font-semibold text-slate-500">
          This deduction carries no dated days — set the quantity directly.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            {row.unit === "days" ? "Deduction quantity (days)" : "Deduction amount (EGP)"}
          </span>
          <input
            className={cn(phxFieldClassName, "w-32 tabular-nums")}
            inputMode="decimal"
            min={0}
            onChange={(event) => {
              setQuantity(event.target.value);
              setManualQuantity(true);
            }}
            step="0.5"
            type="number"
            value={quantity}
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            {row.unit === "days" ? "Amount" : "Detected"}
          </span>
          <p className="whitespace-nowrap py-1 text-sm font-black tabular-nums text-slate-900">
            {row.unit === "days"
              ? previewAmount != null
                ? `${money(previewAmount)} EGP`
                : "requires review"
              : `${money(row.rawValue)}`}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            className="whitespace-nowrap bg-slate-900 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
            disabled={saving}
            onClick={save}
            type="button"
          >
            {saving ? "Saving…" : "Save days"}
          </button>
          <button
            className="whitespace-nowrap px-2 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500 transition hover:text-slate-800"
            disabled={saving}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>

      {manualQuantity && row.unit === "days" && parsedQuantity !== tickedDays(row, selected.length) ? (
        <p className="flex flex-wrap items-center gap-2 text-phx-xs font-bold text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          You typed {quantity} but the ticked dates come to {tickedDays(row, selected.length)} day(s) — the typed number is what gets deducted.
          <button
            className="inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-[0.08em] underline transition hover:text-orange-600"
            onClick={resetQuantityToTicks}
            type="button"
          >
            <RotateCcw className="h-3 w-3" />
            Match the ticks
          </button>
        </p>
      ) : null}

      {selected.length === 0 && detected.length > 0 && parsedQuantity === 0 ? (
        <p className="text-phx-xs font-bold text-amber-800">
          No days ticked — this publishes as 0.00 EGP. To drop the deduction entirely, decide it as “Do Not Take Action”.
        </p>
      ) : null}

      {overDetected ? (
        <p className="text-phx-xs font-bold text-red-700">
          Only {row.rawValue} day(s) were detected for this employee — you cannot deduct more than that.
        </p>
      ) : null}

      {error ? <p className="text-phx-xs font-semibold text-red-700">{error}</p> : null}
      {payrollNotice ? <p className="text-phx-xs font-semibold text-amber-800">{payrollNotice}</p> : null}
    </div>
  );
}

type CategoryBucket = { candidateCount: number; employeeCount: number; totalAmount: number };
type CompanySummary = {
  willPublish: Record<DeductionsCategory, CategoryBucket>;
  pending: Record<DeductionsCategory, CategoryBucket>;
  willPublishTotal: number;
  pendingTotal: number;
};

type EmployeeCategoryBucket = { days: number; amount: number; candidateCount: number };
type EmployeeSummary = {
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  willPublish: Partial<Record<DeductionsCategory, EmployeeCategoryBucket>>;
  pending: Partial<Record<DeductionsCategory, EmployeeCategoryBucket>>;
  willPublishTotal: number;
  pendingTotal: number;
} | null;

const DECISION_STATUSES = ["Approved for Payroll", "Do Not Take Action", "Needs Follow-up", "Disputed"] as const;

function money(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
}

// DATE-ONLY (a "YYYY-MM" period key, rendered off a synthetic `Date.UTC`), which `new Date` parses as
// UTC midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a
// zone offset. Not an instant — do not "fix" this one to Cairo.
function monthLabel(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
  }
  return payload;
}

// Each collection request runs one company-wide scan. Give it the platform's own
// 300s ceiling plus a little slack, then fail with a message — the original cut of
// this screen left the button spinning with nothing shown when the request was
// killed at the gateway (#1377).
const COLLECT_REQUEST_TIMEOUT_MS = 310_000;

async function fetchJsonWithTimeout<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchJson<T>(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s — the scan is too slow to finish in one request.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type CollectorRun = {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed";
  created?: number;
  skippedExisting?: number;
  warnings?: string[];
  error?: string;
};

/**
 * The row's decision. "Approved for Payroll" IS what Automated Payroll charges, pushed or not — the
 * push gate was retired on 2026-10-07 (owner), so the amber "Approved — not pushed" state this badge
 * carried for a fortnight no longer describes anything and is gone.
 */
function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? "Pending";
  const tone =
    label === "Approved for Payroll"
      ? "bg-emerald-100 text-emerald-700"
      : label === "Do Not Take Action"
        ? "bg-slate-200 text-slate-700"
        : label === "Disputed"
          ? "bg-red-100 text-red-700"
          : label === "Needs Follow-up"
            ? "bg-amber-100 text-amber-700"
            : "bg-sky-50 text-sky-700";
  return (
    <span className={["inline-block rounded-full px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em]", tone].join(" ")}>
      {label}
    </span>
  );
}

function CandidateDecideRow({
  row,
  canDecide,
  onDecided,
}: {
  row: CandidateApiRow;
  canDecide: boolean;
  onDecided: (candidateId: string, decision: CandidateApiRow["decision"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(row.decision?.decisionReason ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the decision is saved but could NOT reach Automated Payroll (Part 2 already confirmed, or
  // the step could not be updated). The decision is what payroll charges, so saying nothing here would
  // leave this page reading "Approved" while payroll pays the old figure.
  const [payrollNotice, setPayrollNotice] = useState<string | null>(null);

  async function decide(status: (typeof DECISION_STATUSES)[number]) {
    // Every non-Pending decision needs a reason — the server enforces this
    // (service.ts's validation) and so does a DB CHECK constraint. The UI used
    // to exempt "Approved for Payroll", which meant clicking Approve with an
    // empty box failed server-side every single time. Prefill a sensible
    // default for approvals rather than blocking on an empty field.
    const effectiveReason =
      reason.trim() || (status === "Approved for Payroll" ? `Approved for payroll after review (${row.monthKey})` : "");
    if (!effectiveReason) {
      setError("A decision reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setPayrollNotice(null);
    try {
      const payload = await fetchJson<{
        decision: CandidateApiRow["decision"] & { payrollNotices?: string[] };
      }>("/api/admin/deductions/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: row.id, decisionStatus: status, decisionReason: effectiveReason }),
      });
      onDecided(row.id, payload.decision);
      const notices = payload.decision?.payrollNotices ?? [];
      setPayrollNotice(notices.length > 0 ? notices.join(" ") : null);
      setOpen(false);
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Unable to record this decision.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!canDecide) return null;

  return (
    <div className="mt-1.5">
      {payrollNotice && !open ? (
        <p className="mb-1 text-phx-xs font-semibold text-amber-800">{payrollNotice}</p>
      ) : null}
      {open ? (
        <div className="space-y-1.5 rounded-sm border border-slate-200 bg-slate-50 p-2">
          <input
            className={phxFieldClassName}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Decision reason"
            value={reason}
          />
          {error ? <p className="text-phx-xs font-semibold text-red-700">{error}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {DECISION_STATUSES.map((status) => (
              <button
                className="rounded-sm bg-slate-900 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
                disabled={submitting}
                key={status}
                onClick={() => decide(status)}
                type="button"
              >
                {status}
              </button>
            ))}
            <button
              className="rounded-sm px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500"
              disabled={submitting}
              onClick={() => setOpen(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="rounded-sm border border-slate-300 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
          onClick={() => setOpen(true)}
          type="button"
        >
          Decide
        </button>
      )}
    </div>
  );
}

/** What the server says taking one deduction from annual leave would do (GET /api/admin/deductions/leave-balance). */
type LeaveBalancePreviewApi = {
  dueDays: number;
  availableDays: number | null;
  chargeDays: number;
  salaryDays: number;
  refusal: string | null;
  alreadyCleared: boolean;
  uncollectedDays: number;
  withinFirstSixMonths: boolean;
  employeeHasLeft: boolean;
  lastWorkingDate: string | null;
};

/**
 * Which rows offer the button: one of `LEAVE_BALANCE_CATEGORIES`, counted in days. The list is
 * imported rather than written again here — the server, the decide guard and the database function
 * read the same one, and a tab that shows a button the server then refuses is the drift that matters.
 */
function canTakeFromLeaveBalance(row: CandidateApiRow): boolean {
  return isLeaveBalanceCategory(row.category) && row.unit === "days";
}

function daysText(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Says the person has LEFT — in the charge dialog AND in the already-charged view (owner,
 * 2026-10-09: allow it, but say he has left). It never blocks the charge; what was missing was the
 * words. Measured on production the same day: 3 of the 16 September Unpaid Vacation rows belong to
 * people who have left, and two of them were being offered 5 and 1.25 days of balance with nothing
 * on screen to say so.
 */
function EmployeeHasLeftNotice({ lastWorkingDate }: { lastWorkingDate: string | null }) {
  // hireDateLabel is this file's date-only renderer — UTC parts through stableEnGbFormatter, which
  // is what keeps an en-GB "Sep"/"Sept" month out of React hydration error #418. A last working day
  // is the same kind of column, so it is rendered by the same function, never by a second one.
  const label = hireDateLabel(lastWorkingDate);
  const when = label === "—" ? "" : label;
  return (
    <p className="text-phx-xs font-semibold text-amber-800">
      This employee has left the company{when ? ` on ${when}` : ""}. The charge still goes through, but it spends a
      balance the final settlement may already have paid out, and the Vacation Report cannot show it — the Entitlements
      tab lists active employees, so someone who has left has no row there.
    </p>
  );
}

/**
 * "Deduct from leave balance" and "Return to salary" (owner, 2026-10-09). The comment is required: it
 * is what the employee reads, as written, in their Vacation Report. The confirmation shows what the
 * server worked out — how much annual leave there is, how many days come off it and how many stay on
 * salary — before anything is saved.
 */
function LeaveBalanceControl({ row, onChanged }: { row: CandidateApiRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<LeaveBalancePreviewApi | null>(null);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 🔴 An ALREADY-CHARGED row never opens the dialog, so without this read `preview` stays null
  // there for ever and any notice hung off it is a silently dead branch. It is read once, only for
  // the rows that carry a charge — 6 of them on production on 2026-10-09 — because "this person has
  // left" is exactly what the Return to salary button beside it needs to say.
  useEffect(() => {
    if (!row.leaveBalanceCharge) return;
    let live = true;
    void fetchJson<{ preview: LeaveBalancePreviewApi }>(
      `/api/admin/deductions/leave-balance?candidateId=${encodeURIComponent(row.id)}`,
    )
      .then((payload) => {
        if (live) setPreview(payload.preview);
      })
      // Silent on purpose: the badge, the comment and the Return button below do not depend on it.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [row.id, row.leaveBalanceCharge]);

  const charged = row.leaveBalanceCharge ?? null;
  if (!charged && !canTakeFromLeaveBalance(row)) return null;

  async function openDialog() {
    setOpen(true);
    setError(null);
    setPreview(null);
    setLoading(true);
    try {
      const payload = await fetchJson<{ preview: LeaveBalancePreviewApi }>(
        `/api/admin/deductions/leave-balance?candidateId=${encodeURIComponent(row.id)}`,
      );
      setPreview(payload.preview);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Unable to read the leave balance.");
    } finally {
      setLoading(false);
    }
  }

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fetchJson("/api/admin/deductions/leave-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: row.id, ...body }),
      });
      setOpen(false);
      setComment("");
      onChanged();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Unable to change the leave balance.");
    } finally {
      setBusy(false);
    }
  }

  if (charged) {
    return (
      <div className="mt-1.5 space-y-1">
        <span className="inline-block rounded-full bg-sky-100 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-sky-800">
          From leave balance · {daysText(charged.days)}
        </span>
        <p className="text-phx-xs text-slate-600">{charged.comment}</p>
        <button
          className="border border-slate-300 px-2 py-1 text-left text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600 disabled:opacity-50"
          disabled={busy}
          onClick={() => send({ action: "return" })}
          type="button"
        >
          {busy ? "Returning…" : "Return to salary"}
        </button>
        {preview?.employeeHasLeft ? <EmployeeHasLeftNotice lastWorkingDate={preview.lastWorkingDate} /> : null}
        {error ? <p className="text-phx-xs font-semibold text-red-700">{error}</p> : null}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-1.5">
        <button
          className="border border-sky-300 px-2 py-1 text-left text-phx-2xs font-black uppercase tracking-[0.08em] text-sky-800 transition hover:border-sky-500 hover:bg-sky-50"
          onClick={openDialog}
          type="button"
        >
          Deduct from leave balance
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5 rounded-sm border border-slate-200 bg-slate-50 p-2">
      {loading ? <p className="text-phx-xs text-slate-500">Reading the annual leave balance…</p> : null}
      {preview ? (
        preview.refusal ? (
          <p className="text-phx-xs font-semibold text-amber-800">{preview.refusal}</p>
        ) : (
          <>
            <p className="text-phx-xs text-slate-700">
              Annual leave left: {preview.availableDays == null ? "unknown" : daysText(preview.availableDays)}. This takes{" "}
              <span className="font-black">{daysText(preview.chargeDays)}</span> from leave
              {preview.salaryDays > 0 ? (
                <>
                  {" "}
                  and <span className="font-black">{daysText(preview.salaryDays)}</span> stay on salary
                </>
              ) : null}
              {preview.uncollectedDays > 0 ? (
                <>
                  {" "}
                  and <span className="font-black">{daysText(preview.uncollectedDays)}</span> stay cleared, reaching no salary
                </>
              ) : null}
              .
            </p>
            {preview.alreadyCleared ? (
              <p className="text-phx-xs font-semibold text-amber-800">
                This row is already cleared, so nothing is on salary — the charge only takes the day off the leave balance,
                and the row stays cleared. Return to salary puts it back to Pending.
              </p>
            ) : null}
            {preview.withinFirstSixMonths ? (
              <p className="text-phx-xs font-semibold text-amber-800">
                Still inside the first six months, so this spends days already accrued but not yet available to request.
              </p>
            ) : null}
            {preview.employeeHasLeft ? <EmployeeHasLeftNotice lastWorkingDate={preview.lastWorkingDate} /> : null}
          </>
        )
      ) : null}
      <label className="block">
        <span className={phxLabelClassName}>
          Comment for the employee<span className={phxRequiredMarkClassName}>*</span>
        </span>
        <textarea
          className={phxTextareaClassName}
          onChange={(event) => setComment(event.target.value)}
          placeholder="The employee reads this exactly as written, in their Vacation Report"
          rows={2}
          value={comment}
        />
      </label>
      {error ? <p className="text-phx-xs font-semibold text-red-700">{error}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        <button
          className="rounded-sm bg-slate-900 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
          disabled={busy || loading || !preview || Boolean(preview.refusal) || !comment.trim()}
          onClick={() => send({ action: "charge", comment })}
          type="button"
        >
          {busy ? "Saving…" : "Deduct from leave"}
        </button>
        <button
          className="rounded-sm px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500"
          disabled={busy}
          onClick={() => setOpen(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const BULK_DECIDE_CONCURRENCY = 3;

/**
 * Decide every ticked candidate with ONE decision and ONE reason.
 *
 * It posts to the same `/api/admin/deductions/decisions` route the single Decide button uses, one
 * candidate per request, so every rule that route carries — the permission, the reason requirement,
 * the locked-line refusal, the payroll resync on a decision made after a step was confirmed — applies
 * to each row exactly as it does one at a time. No days are sent: a reviewer's saved day selection
 * on a row is left as it is, and the amount is still derived server-side. A failure on one row never
 * stops the others, and only the rows that succeeded are un-ticked, so the failures stay selected
 * for a retry.
 */
/** Two rows charging one employee on one day — see lib/deductions/day-overlap.ts. */
function SameDayBadge({ overlap }: { overlap: SameDayOverlap | undefined }) {
  if (!overlap) return null;
  const days = overlap.dates.map((date) => dayOfMonth(date)).join(", ");
  return (
    <span className="mb-1 mr-1.5 inline-block rounded-sm border border-red-300 bg-red-50 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-red-700">
      Same day on another row · {days}
    </span>
  );
}

function BulkDecideBar({
  selectedRows,
  overlaps,
  onDecided,
  onFinished,
}: {
  selectedRows: CandidateApiRow[];
  overlaps: ReadonlyMap<string, SameDayOverlap>;
  onDecided: (candidateId: string, decision: CandidateApiRow["decision"]) => void;
  onFinished: (succeededIds: string[]) => void;
}) {
  const [reason, setReason] = useState("");
  const [pendingStatus, setPendingStatus] = useState<(typeof DECISION_STATUSES)[number] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<{ ok: number; failed: Array<{ name: string; message: string }>; notices: number } | null>(
    null,
  );

  const count = selectedRows.length;
  const totalAmount = selectedRows.reduce((sum, row) => sum + (appliedAmountOf(row) ?? 0), 0);
  // Employees for whom BOTH rows of a same-day pair are ticked: approving them together double-charges.
  const selectedIdSet = new Set(selectedRows.map((row) => row.id));
  const clashingNames = [
    ...new Set(
      selectedRows
        .filter((row) => overlaps.get(row.id)?.otherIds.some((otherId) => selectedIdSet.has(otherId)))
        .map((row) => employeeLabel(row)),
    ),
  ];

  async function apply(status: (typeof DECISION_STATUSES)[number]) {
    const rows = selectedRows;
    // Same default the single Decide button prefills: the server refuses a decision with no reason.
    const effectiveReason =
      reason.trim() || (status === "Approved for Payroll" ? `Approved for payroll after review (${rows[0]?.monthKey ?? ""})` : "");
    if (!effectiveReason) {
      setSummary({ ok: 0, failed: [{ name: "Nothing was changed", message: "A decision reason is required." }], notices: 0 });
      setPendingStatus(null);
      return;
    }
    setRunning(true);
    setSummary(null);
    setProgress(0);
    const succeeded: string[] = [];
    const failed: Array<{ name: string; message: string }> = [];
    let notices = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const payload = await fetchJson<{
            decision: CandidateApiRow["decision"] & { payrollNotices?: string[] };
          }>("/api/admin/deductions/decisions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidateId: row.id, decisionStatus: status, decisionReason: effectiveReason }),
          });
          onDecided(row.id, payload.decision);
          succeeded.push(row.id);
          notices += (payload.decision?.payrollNotices ?? []).length > 0 ? 1 : 0;
        } catch (decideError) {
          failed.push({
            name: employeeLabel(row),
            message: decideError instanceof Error ? decideError.message : "Unable to record this decision.",
          });
        }
        setProgress((current) => current + 1);
      }
    }

    await Promise.all(Array.from({ length: Math.min(BULK_DECIDE_CONCURRENCY, rows.length) }, () => worker()));
    setRunning(false);
    setPendingStatus(null);
    setSummary({ ok: succeeded.length, failed, notices });
    if (failed.length === 0) setReason("");
    onFinished(succeeded);
  }

  if (count === 0 && !summary) return null;

  return (
    <div className="space-y-2 border-b border-slate-200 bg-orange-50/60 px-4 py-3">
      {count > 0 ? (
        <>
          <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-800">
            {count} selected · {money(totalAmount)} EGP
          </p>
          <input
            className={phxFieldClassName}
            disabled={running}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Decision reason (applied to all selected)"
            value={reason}
          />
          {pendingStatus ? (
            <div className="space-y-1.5 border border-slate-300 bg-white p-2">
              <p className="text-xs font-semibold text-slate-800">
                Record “{pendingStatus}” on {count} deduction{count === 1 ? "" : "s"} ({money(totalAmount)} EGP)?
              </p>
              {clashingNames.length > 0 && pendingStatus === "Approved for Payroll" ? (
                <p className="text-xs font-semibold text-red-700">
                  Two of the selected rows charge the same day for {clashingNames.join(", ")}. Approving both charges that day twice — untick one first.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                <button
                  className="rounded-sm bg-slate-900 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
                  disabled={running}
                  onClick={() => apply(pendingStatus)}
                  type="button"
                >
                  {running ? `Saving ${progress} of ${count}` : `Confirm — ${pendingStatus}`}
                </button>
                <button
                  className="rounded-sm px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500"
                  disabled={running}
                  onClick={() => setPendingStatus(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {DECISION_STATUSES.map((status) => (
                <button
                  className="rounded-sm bg-slate-900 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
                  disabled={running}
                  key={status}
                  onClick={() => setPendingStatus(status)}
                  type="button"
                >
                  {status}
                </button>
              ))}
            </div>
          )}
        </>
      ) : null}
      {summary ? (
        <div className="space-y-1">
          {summary.ok > 0 ? (
            <p className="text-xs font-semibold text-emerald-800">
              Decision recorded on {summary.ok} deduction{summary.ok === 1 ? "" : "s"}.
            </p>
          ) : null}
          {summary.notices > 0 ? (
            <p className="text-xs font-semibold text-amber-800">
              {summary.notices} of them could not reach Automated Payroll — open the row to read why.
            </p>
          ) : null}
          {summary.failed.map((entry, index) => (
            <p className="text-xs font-semibold text-red-700" key={`${entry.name}-${index}`}>
              {entry.name}: {entry.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Would the server accept a PUSH for this row right now? Mirrors
 * isEligibleForPublish (calculations.ts): a category that requires approval needs
 * an explicit "Approved for Payroll"; a mandatory-unless-cleared category needs
 * only that it was not marked "Do Not Take Action". The `dsm_no_record`
 * source-system override is not represented on the client row — the server
 * refuses those and PushControl surfaces the reason inline — so this stays a
 * best-effort gate on when to OFFER the button, never the authority on the write.
 */
function eligibleForPush(row: CandidateApiRow): boolean {
  const status = row.decision?.decisionStatus ?? "Pending";
  if (DEDUCTIONS_CATEGORY_CONFIG[row.category].requiresApproval) {
    return status === "Approved for Payroll";
  }
  return status !== "Do Not Take Action";
}

/**
 * The per-line PUSH / WITHDRAW control — the owner's "push per one person, per
 * one deduction, push two and leave one" (2026-09-22).
 *
 * A pushed line is the SINGLE gate for pay and for the employee's portal, and it
 * fires the employee + manager-chain notification. So this is money: it shows a
 * plain "Push" only where the row is eligible AND has a computable amount, and
 * once pushed it shows a "Pushed" badge with a "Withdraw" that pulls the line
 * back (freeing the candidate to be edited and re-pushed). No amount or category
 * is ever spoken by the notification — that lives behind the self-only portal.
 *
 * It talks to the API directly (not fetchJson) so a no-op withdraw — the line was
 * already gone — still lands on the desired end-state (not pushed) instead of
 * reading as an error.
 */
function PushControl({
  row,
  onPushChange,
}: {
  row: CandidateApiRow;
  onPushChange: (candidateId: string, pushedLineId: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function push() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/deductions/push", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthKey: row.monthKey, candidateId: row.id }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        message?: string;
        line?: { lineId?: string };
      };
      const lineId = payload.line?.lineId;
      if (!response.ok || payload.success === false || !lineId) {
        throw new Error(payload.error || payload.message || `Push failed (${response.status})`);
      }
      onPushChange(row.id, String(lineId));
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : "Unable to push this deduction.");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!row.pushedLineId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/deductions/push", {
        method: "DELETE",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lineId: row.pushedLineId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      // A no-op withdraw (the line was already withdrawn elsewhere) returns 200
      // with success:false, and the end-state is still "not pushed" — only a real
      // HTTP error is a failure worth showing.
      if (!response.ok) {
        throw new Error(payload.error || payload.message || `Withdraw failed (${response.status})`);
      }
      onPushChange(row.id, null);
    } catch (withdrawError) {
      setError(withdrawError instanceof Error ? withdrawError.message : "Unable to withdraw this deduction.");
    } finally {
      setBusy(false);
    }
  }

  if (row.pushedLineId) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-100 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-emerald-700">
          <CheckCircle2 className="h-3 w-3" />
          Pushed
        </span>
        <button
          className="whitespace-nowrap border border-red-300 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-red-700 transition hover:border-red-500 hover:bg-red-50 disabled:opacity-50"
          disabled={busy}
          onClick={withdraw}
          type="button"
        >
          {busy ? "Withdrawing…" : "Withdraw"}
        </button>
        {error ? <span className="text-phx-2xs font-semibold text-red-700">{error}</span> : null}
      </div>
    );
  }

  // Not pushed. Offer Push only where it would actually go through — otherwise the
  // Decide / Edit-days controls beside this one are the way forward.
  if (!eligibleForPush(row) || appliedAmountOf(row) == null) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        className={cn(
          phxButtonApproveDenseClassName,
          "inline-flex items-center gap-1 whitespace-nowrap border px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] transition disabled:opacity-50",
        )}
        disabled={busy}
        onClick={push}
        type="button"
      >
        <UserPlus className="h-3 w-3" />
        {busy ? "Pushing…" : "Push"}
      </button>
      {error ? <span className="text-phx-2xs font-semibold text-red-700">{error}</span> : null}
    </div>
  );
}

type EmployeeMatch = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  employmentStatus: string | null;
  lastWorkingDate?: string | null;
  isFinalSettlement?: boolean;
};

/**
 * "9 Aug 2026" from a YYYY-MM-DD string, without going through Date().
 *
 * `new Date("2026-08-09")` is parsed as UTC midnight and then rendered in
 * the BROWSER's timezone, which shows the 8th to anyone west of UTC. The
 * date is already the calendar day we want, so read it as written.
 */
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function readableDate(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!match) return null;
  const monthName = SHORT_MONTHS[Number(match[2]) - 1];
  if (!monthName) return null;
  return `${Number(match[3])} ${monthName} ${match[1]}`;
}

/**
 * Add an employee to a manual category (Loan / Other) and deduct from them.
 *
 * Only these two categories: the other five are DETECTED from source data, and
 * hand-adding a row there would be inventing evidence. The manual API already
 * existed but nothing on this screen called it, so the only way to add somebody
 * was a hand-crafted request.
 *
 * The employee is chosen by NAME. The amount for a days entry is priced by the
 * server from the employee's base salary — the preview here is exactly that
 * same figure, fetched for the one selected person, so what you see before
 * saving is what gets written.
 */
function AddManualDeduction({
  category,
  monthKey,
  onAdded,
}: {
  category: Extract<DeductionsCategory, "loan" | "other">;
  monthKey: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<EmployeeMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<{ hrId: string; name: string; dayRate: number | null } | null>(null);
  const [unit, setUnit] = useState<"days" | "amount">("days");
  const [value, setValue] = useState("1");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedValue = Number(value);
  const valueValid = value.trim() !== "" && Number.isFinite(parsedValue) && parsedValue > 0;
  const preview =
    unit === "amount"
      ? valueValid
        ? parsedValue
        : null
      : valueValid && picked?.dayRate != null
        ? Math.round(picked.dayRate * parsedValue * 100) / 100
        : null;

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMatches([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      fetchJson<{ employees: EmployeeMatch[] }>(
        `/api/admin/deductions/employees?q=${encodeURIComponent(term)}&monthKey=${encodeURIComponent(monthKey)}`,
      )
        .then((payload) => {
          if (!cancelled) setMatches(payload.employees);
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, monthKey]);

  async function pick(match: EmployeeMatch) {
    setError(null);
    setPicked({ hrId: match.hrId, name: match.name, dayRate: null });
    setQuery(match.name);
    setMatches([]);
    try {
      const payload = await fetchJson<{ employee: { hrId: string; name: string | null; dayRate: number | null } }>(
        `/api/admin/deductions/employees?hrId=${encodeURIComponent(match.hrId)}&monthKey=${monthKey}`,
      );
      setPicked({ hrId: match.hrId, name: payload.employee.name || match.name, dayRate: payload.employee.dayRate });
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "Could not load that employee's day rate.");
    }
  }

  async function submit() {
    if (!picked) {
      setError("Choose an employee first.");
      return;
    }
    if (!valueValid) {
      setError(unit === "days" ? "Enter how many days." : "Enter an amount.");
      return;
    }
    if (!reason.trim()) {
      setError("A reason is required — this writes an approved deduction.");
      return;
    }
    const [year, month] = monthKey.split("-").map(Number);
    setSaving(true);
    setError(null);
    try {
      const saved = await fetchJson<{ payrollNotices?: string[] }>("/api/admin/deductions/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          employeeHrId: picked.hrId,
          month,
          year,
          unit,
          value: parsedValue,
          reason: reason.trim(),
        }),
      });
      setPicked(null);
      setQuery("");
      setValue("1");
      setReason("");
      onAdded();
      // Added, but payroll could not follow it (Part 2 confirmed, or the resync failed) — keep the
      // form open to say so rather than closing as if payroll has it.
      const notices = saved?.payrollNotices ?? [];
      if (notices.length > 0) {
        setError(notices.join(" "));
        return;
      }
      setOpen(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not add this deduction.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        className="inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-300 bg-white px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
        onClick={() => setOpen(true)}
        type="button"
      >
        <UserPlus className="h-3.5 w-3.5" />
        Add employee
      </button>
    );
  }

  return (
    <div className="w-full space-y-3 border border-orange-200 bg-orange-50/50 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="relative flex flex-col gap-1">
          <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            Employee
          </span>
          <input
            className={cn(phxFieldClassName, "w-72")}
            onChange={(event) => {
              setQuery(event.target.value);
              setPicked(null);
            }}
            placeholder="Type a name…"
            value={query}
          />
          {matches.length > 0 ? (
            <ul className="absolute top-full z-10 max-h-56 w-72 overflow-y-auto border border-slate-300 bg-white shadow-lg">
              {matches.map((match) => (
                <li key={match.hrId}>
                  <button
                    className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left transition hover:bg-orange-50"
                    onClick={() => pick(match)}
                    type="button"
                  >
                    <span className="text-xs font-bold text-slate-900">{match.name}</span>
                    {match.jobTitle ? (
                      <span className="text-phx-2xs text-slate-500">{match.jobTitle}</span>
                    ) : null}
                    {match.isFinalSettlement ? (
                      <span className="text-phx-2xs font-bold text-amber-700">
                        {`Left ${readableDate(match.lastWorkingDate) ?? "this month"} — final settlement`}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {searching ? <span className="text-phx-2xs font-semibold text-slate-400">Searching…</span> : null}
        </label>

        <label className="flex flex-col gap-1">
          <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            Deduct by
          </span>
          <select
            className={phxSelectClassName}
            onChange={(event) => setUnit(event.target.value === "amount" ? "amount" : "days")}
            value={unit}
          >
            <option value="days">Days</option>
            <option value="amount">Amount (EGP)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            {unit === "days" ? "Days" : "Amount"}
          </span>
          <input
            className={cn(phxFieldClassName, "w-28 tabular-nums")}
            inputMode="decimal"
            min={0}
            onChange={(event) => setValue(event.target.value)}
            step={unit === "days" ? "0.5" : "1"}
            type="number"
            value={value}
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            Amount
          </span>
          <p className="whitespace-nowrap py-1 text-sm font-black tabular-nums text-slate-900">
            {preview != null ? `${money(preview)} EGP` : picked && unit === "days" ? "no base salary on record" : "—"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            Reason
          </span>
          <input
            className={phxFieldClassName}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this being deducted?"
            value={reason}
          />
        </label>
        <div className="flex items-center gap-1.5">
          <button
            className="whitespace-nowrap bg-slate-900 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
            disabled={saving}
            onClick={submit}
            type="button"
          >
            {saving ? "Adding…" : "Add deduction"}
          </button>
          <button
            className="whitespace-nowrap px-2 py-1.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500 transition hover:text-slate-800"
            disabled={saving}
            onClick={() => setOpen(false)}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>

      {/* A manual entry auto-approves on insert — there is nothing to decide
          about a number a human just typed — so the warning belongs here, before
          the click, not in a confirmation nobody reads. */}
      <p className="text-phx-xs font-bold text-amber-800">
        This is added as “Approved for Payroll” immediately and will publish with the month.
      </p>

      {error ? <p className="text-phx-xs font-semibold text-red-700">{error}</p> : null}
    </div>
  );
}

function CategoryTab({ category, monthKey, canDecide }: { category: DeductionsCategory; monthKey: string; canDecide: boolean }) {
  const [rows, setRows] = useState<CandidateApiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // One open editor at a time. A month can carry hundreds of candidates, each
  // with up to ~19 days — rendering every checkbox at once would put thousands
  // of live inputs on the page for no benefit.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Bumped to force a refetch after a manual entry is added, so the new row
  // appears without a full page reload.
  const [reloadToken, setReloadToken] = useState(0);
  // Ticked candidate ids for the bulk decision. Ids that are no longer decidable (a refetch, a
  // push) simply drop out of `selectedRows` below, so a stale tick can never be decided.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  // Rows that charge the same employee on the same day as another row on this tab.
  const overlaps = useMemo(() => findSameDayOverlaps(rows), [rows]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchJson<{ candidates: CandidateApiRow[] }>(`/api/admin/deductions/candidates?monthKey=${monthKey}&category=${category}`)
      .then((payload) => {
        if (!cancelled) setRows(payload.candidates);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load candidates.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category, monthKey, reloadToken]);

  function handleDecided(candidateId: string, decision: CandidateApiRow["decision"]) {
    setRows((current) => current.map((row) => (row.id === candidateId ? { ...row, decision } : row)));
  }

  // Push and withdraw flip one candidate's active-line id in place, so the row
  // moves between "Push" and "Pushed ✓ · Withdraw" without a full refetch.
  function handlePushChange(candidateId: string, pushedLineId: string | null) {
    setRows((current) => current.map((row) => (row.id === candidateId ? { ...row, pushedLineId } : row)));
  }

  const config = DEDUCTIONS_CATEGORY_CONFIG[category];

  // A pushed line is locked against edits, so it can be neither ticked nor decided in bulk.
  const selectableRows = canDecide ? rows.filter((row) => !row.pushedLineId && !row.leaveBalanceCharge) : [];
  const selectedRows = selectableRows.filter((row) => selectedIds.has(row.id));
  const allSelected = selectableRows.length > 0 && selectedRows.length === selectableRows.length;
  const pendingRows = selectableRows.filter((row) => (row.decision?.decisionStatus ?? "Pending") === "Pending");

  function toggleSelected(candidateId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }

  function setSelection(ids: readonly string[]) {
    setSelectedIds(new Set(ids));
  }

  function toggleAll() {
    setSelection(allSelected ? [] : selectableRows.map((row) => row.id));
  }

  function handleBulkFinished(succeededIds: string[]) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of succeededIds) next.delete(id);
      return next;
    });
  }

  return (
    <div className="border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-5 py-3">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
          {loading ? "Loading…" : `${rows.length} ${config.label} candidate${rows.length === 1 ? "" : "s"}`}
        </h2>
        <div className="flex items-center gap-2">
          {!config.requiresApproval ? (
            <span className="whitespace-nowrap rounded-full bg-phx-warn/20 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-phx-warn-bg">
              Mandatory unless cleared
            </span>
          ) : null}
          <a
            className="inline-flex items-center gap-1.5 whitespace-nowrap border border-orange-500 bg-orange-500 px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-orange-600"
            download
            href={`/api/admin/deductions/export?category=${category}&monthKey=${monthKey}`}
          >
            <Download className="h-3.5 w-3.5" />
            Download XLSX
          </a>
        </div>
      </div>

      {/* Manual categories only. Loan and Other have no source system to scan,
          so an employee is added by hand; the other five are DETECTED, and
          hand-adding a row there would be inventing evidence for a deduction. */}
      {canDecide && (category === "loan" || category === "other") ? (
        <div className="flex flex-wrap items-start gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
          <AddManualDeduction category={category} monthKey={monthKey} onAdded={() => setReloadToken((n) => n + 1)} />
        </div>
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {canDecide && selectableRows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-slate-100 bg-slate-50/60 px-4 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs font-black uppercase tracking-[0.08em] text-slate-700">
            <input
              checked={allSelected}
              className="h-3.5 w-3.5 accent-orange-500"
              onChange={toggleAll}
              ref={(element) => {
                if (element) element.indeterminate = selectedRows.length > 0 && !allSelected;
              }}
              type="checkbox"
            />
            Select all ({selectableRows.length})
          </label>
          {pendingRows.length > 0 && pendingRows.length < selectableRows.length ? (
            <button
              className="whitespace-nowrap border border-slate-300 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
              onClick={() => setSelection(pendingRows.map((row) => row.id))}
              type="button"
            >
              Select pending only ({pendingRows.length})
            </button>
          ) : null}
          {selectedRows.length > 0 ? (
            <button
              className="whitespace-nowrap px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-500 hover:text-slate-800"
              onClick={() => setSelection([])}
              type="button"
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
      {overlaps.size > 0 ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {overlaps.size} row{overlaps.size === 1 ? "" : "s"} charge an employee on a day another row already charges — marked in red below. Approve one, set the other to Do Not Take Action.
        </div>
      ) : null}
      {canDecide ? (
        <BulkDecideBar onDecided={handleDecided} onFinished={handleBulkFinished} overlaps={overlaps} selectedRows={selectedRows} />
      ) : null}

      {!loading && rows.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-sm font-bold text-slate-500">No {config.label.toLowerCase()} candidates for {monthLabel(monthKey)}.</p>
        </div>
      ) : (
        <>
          {/* Desktop: table. Mobile: stacked cards — never horizontal-scroll a table.
              The split is at `md` (768px), not `sm` (640px). Both halves existed from the start;
              the boundary moved on 2026-09-03 when this screen entered the HR shell, because the
              640-767px band was still handing a phone-sized viewport all NINE columns. That is the
              width tests/hr-shell-mobile-tables.test.ts measures, and `md` is the breakpoint every
              sibling uses — PortalResponsiveDataList emits `md:hidden` cards beside a `md:block`
              table, so a screen splitting at `sm` disagrees with the rest of the shell.

              FITS THE SCREEN (owner golden rule; measured 2026-10-19 on production, a 1024px
              window, Fingerprint tab: the table was 1,455px inside an 893px card, so Amount,
              Reason, Status and Action fell off the right edge). It was TEN columns of
              `whitespace-nowrap` cells, and the Dates cell alone listed up to a month of day
              numbers on one line. Now `table-fixed` with a percentage colgroup that sums to 100,
              and the width is bought by MERGING, never by shrinking type: Hire date sits under the
              Employee, the day count sits over its dates, and Status carries the Action buttons.
              Every cell wraps — the dates break at their commas, and nothing is cut with an
              ellipsis. No `overflow-x-auto` and no `min-w-[…]` floor: either one is the bug. This
              tab is one `CategoryTab` for CRM, Fingerprint, Half Day (CRM), Unpaid Vacation,
              Insufficient Balance Vacation, Loan and Other, so all seven fit by this one table. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                {canDecide ? (
                  <>
                    <col className="w-[5%]" />
                    <col className="w-[15%]" />
                    <col className="w-[20%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                    <col className="w-[20%]" />
                  </>
                ) : (
                  <>
                    <col className="w-[16%]" />
                    <col className="w-[26%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[17%]" />
                    <col className="w-[15%]" />
                  </>
                )}
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                  {canDecide ? (
                    <th className="px-2 py-2">
                      <input
                        aria-label="Select all candidates"
                        checked={allSelected}
                        className="h-3.5 w-3.5 accent-orange-500"
                        disabled={selectableRows.length === 0}
                        onChange={toggleAll}
                        type="checkbox"
                      />
                    </th>
                  ) : null}
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Days and dates deducted</th>
                  <th className="px-3 py-2">Holiday bridge</th>
                  <th className="px-2 py-2">Amount</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2">{canDecide ? "Status and action" : "Status"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const appliedDays = appliedDaysOf(row);
                  const narrowed = row.unit === "days" && appliedDays !== row.rawValue;
                  const amount = appliedAmountOf(row);
                  return (
                    <Fragment key={row.id}>
                      <tr className="border-b border-slate-100 odd:bg-slate-50/60 hover:bg-orange-50/40">
                        {canDecide ? (
                          <td className="px-2 py-2.5 align-top">
                            <input
                              aria-label={`Select ${employeeLabel(row)}`}
                              checked={selectedIds.has(row.id)}
                              className="h-3.5 w-3.5 accent-orange-500"
                              disabled={Boolean(row.pushedLineId)}
                              onChange={() => toggleSelected(row.id)}
                              type="checkbox"
                            />
                          </td>
                        ) : null}
                        {/* Employee NAME only. Not "name, falling back to the HR
                            code" either — a raw code must never reach a screen, so
                            the name is resolved server-side from the employees
                            directory when the candidate did not carry one. The hire
                            date rides under it: it was its own column until the table
                            had to fit a 1024px window. */}
                        <td className="px-3 py-2.5 align-top">
                          <span className="block break-words font-semibold text-slate-900">{employeeLabel(row)}</span>
                          <span className="mt-0.5 block text-xs tabular-nums text-slate-500">
                            Hired {hireDateLabel(row.hireDate)}
                          </span>
                        </td>
                        {/* What is CHARGED, with what was detected beside it when the
                            two differ. Showing rawValue alone made a reviewer's own
                            reduction invisible in the column it changed.

                            WHICH days, not just how many. The candidate has always carried
                            the exact dates; the table simply never showed them, so a
                            reviewer could see "14 days" with no way to tell which 14 or to
                            check one against a calendar. Day numbers only — the whole view
                            is already scoped to one month, so the year/month would be
                            repetition. The list WRAPS at its commas: it used to be held on
                            one line, and a long month of dates then pushed every column
                            after it off the card. */}
                        <td className="px-3 py-2.5 align-top tabular-nums text-slate-700">
                          {row.unit === "days" ? (
                            <p>
                              <span className={narrowed ? "font-black text-orange-600" : ""}>{appliedDays}</span>
                              {narrowed ? <span className="text-xs text-slate-400"> of {row.rawValue}</span> : null}
                              <span className="text-xs text-slate-500"> day(s)</span>
                            </p>
                          ) : null}
                          <p className={row.unit === "days" ? "mt-0.5 text-xs text-slate-700" : "text-xs text-slate-700"}>
                            <DayList row={row} />
                          </p>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <HolidayBridgeCell row={row} />
                        </td>
                        <td className="px-2 py-2.5 align-top tabular-nums text-slate-700">
                          {amount != null ? money(amount) : "requires review"}
                        </td>
                        <td className="break-words px-3 py-2.5 align-top text-xs text-slate-600">
                          {/* A candidate the engine could not settle on its own —
                              a vacation day that also carried real work, for
                              instance — must not read like every other row.

                              🔴 BUT IT CLEARS ONCE HE HAS DECIDED IT (owner-reported 2026-10-07:
                              "i presss approv to payroll nothing happns and kept needs review").
                              calculation_status is the ENGINE's verdict and no decision ever rewrites
                              it, so this pill kept demanding a review he had already done. Measured
                              that night: all five September unpaid-vacation rows marked
                              requires_review already carried a decision, one saved two minutes before
                              he wrote in, and every one still showed this pill. The decision landed
                              and the screen denied it, which reads exactly like a broken button.

                              The engine's inability to compute still matters — it is why the amount
                              comes from the estimate — but "needs YOUR review" is a claim about him,
                              and it stops being true the moment he decides. StatusBadge in the next
                              column already states the decision, so the row is never left silent.
                              Pinned by tests/deductions-approved-not-pushed-feedback.test.ts. */}
                          {row.calculationStatus === "requires_review" &&
                          (row.decision?.decisionStatus ?? "Pending") === "Pending" ? (
                            <span className="mb-1 mr-1.5 inline-block rounded-full bg-phx-warn-bg px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.08em] text-phx-warn">
                              Needs your review
                            </span>
                          ) : null}
                          <SameDayBadge overlap={overlaps.get(row.id)} />
                          {row.reason ?? "—"}
                        </td>
                        {/* Status and the decision controls share one cell — Action was its own
                            column until the table had to fit a 1024px window. The controls
                            wrap under the badge, one per line when the cell is narrow. */}
                        <td className="px-3 py-2.5 align-top">
                          <StatusBadge status={row.decision?.decisionStatus ?? null} />
                          {canDecide ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {/* A pushed line is LOCKED — editing days or changing the
                                  decision would be refused server-side. Hide those and
                                  offer only Withdraw until it is pulled back. */}
                              {row.pushedLineId ? null : row.leaveBalanceCharge ? (
                                <LeaveBalanceControl onChanged={() => setReloadToken((token) => token + 1)} row={row} />
                              ) : (
                                <>
                                  <button
                                    className="mt-1.5 whitespace-nowrap border border-slate-300 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
                                    onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                                    type="button"
                                  >
                                    {editingId === row.id ? "Close days" : "Edit days"}
                                  </button>
                                  <CandidateDecideRow canDecide={canDecide} onDecided={handleDecided} row={row} />
                                  <LeaveBalanceControl onChanged={() => setReloadToken((token) => token + 1)} row={row} />
                                </>
                              )}
                              <PushControl onPushChange={handlePushChange} row={row} />
                            </div>
                          ) : null}
                        </td>
                      </tr>
                      {canDecide && editingId === row.id ? (
                        <tr className="border-b border-slate-200 bg-white">
                          <td className="px-4 pb-3" colSpan={canDecide ? 7 : 6}>
                            <DeductionDaysEditor onClose={() => setEditingId(null)} onSaved={handleDecided} row={row} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="divide-y divide-slate-100 md:hidden">
            {rows.map((row, index) => {
              const appliedDays = appliedDaysOf(row);
              const narrowed = row.unit === "days" && appliedDays !== row.rawValue;
              const amount = appliedAmountOf(row);
              return (
                <div className={["px-4 py-3", index % 2 === 1 ? "bg-slate-50/60" : ""].join(" ")} key={row.id}>
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex min-w-0 items-center gap-2">
                      {canDecide ? (
                        <input
                          aria-label={`Select ${employeeLabel(row)}`}
                          checked={selectedIds.has(row.id)}
                          className="h-4 w-4 shrink-0 accent-orange-500"
                          disabled={Boolean(row.pushedLineId)}
                          onChange={() => toggleSelected(row.id)}
                          type="checkbox"
                        />
                      ) : null}
                      <span className="break-words font-semibold text-slate-900">{employeeLabel(row)}</span>
                    </label>
                    <div className="max-w-[55%] shrink-0 text-right">
                      <StatusBadge status={row.decision?.decisionStatus ?? null} />
                    </div>
                  </div>
                  <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">Hired {hireDateLabel(row.hireDate)}</p>
                  <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">
                    {row.unit === "days" ? `${appliedDays}${narrowed ? ` of ${row.rawValue}` : ""} day(s)` : ""} ·{" "}
                    {amount != null ? `${money(amount)} EGP` : "requires review"}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-slate-700">
                    Dates: <DayList row={row} />
                  </p>
                  {(row.holidayBridges ?? []).length > 0 ? (
                    <p className="mt-1">
                      <HolidayBridgeCell row={row} />
                    </p>
                  ) : null}
                  {overlaps.has(row.id) ? (
                    <p className="mt-1">
                      <SameDayBadge overlap={overlaps.get(row.id)} />
                    </p>
                  ) : null}
                  {row.reason ? <p className="mt-1 text-xs text-slate-600">{row.reason}</p> : null}
                  {/* A pushed line is LOCKED — hide Edit days + Decide, offer only
                      Withdraw, until it is pulled back. */}
                  {canDecide && !row.pushedLineId && !row.leaveBalanceCharge ? (
                    <button
                      className="mt-1.5 whitespace-nowrap border border-slate-300 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
                      onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                      type="button"
                    >
                      {editingId === row.id ? "Close days" : "Edit days"}
                    </button>
                  ) : null}
                  {canDecide && !row.pushedLineId && editingId === row.id ? (
                    <div className="mt-2">
                      <DeductionDaysEditor onClose={() => setEditingId(null)} onSaved={handleDecided} row={row} />
                    </div>
                  ) : null}
                  {canDecide && !row.pushedLineId && !row.leaveBalanceCharge ? (
                    <CandidateDecideRow canDecide={canDecide} onDecided={handleDecided} row={row} />
                  ) : null}
                  {canDecide && !row.pushedLineId ? (
                    <LeaveBalanceControl onChanged={() => setReloadToken((token) => token + 1)} row={row} />
                  ) : null}
                  {canDecide ? (
                    <div className="mt-1.5">
                      <PushControl onPushChange={handlePushChange} row={row} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

type PublicationApiRow = {
  id: string;
  status: "published" | "superseded";
  publishedBy: string;
  publishedAt: string;
  candidateCount: number;
  employeeCount: number;
};

function PublicationPanel({ monthKey, canDecide }: { monthKey: string; canDecide: boolean }) {
  const [publications, setPublications] = useState<PublicationApiRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  function reload() {
    setLoading(true);
    fetchJson<{ publications: PublicationApiRow[] }>(`/api/admin/deductions/publish?monthKey=${monthKey}`)
      .then((payload) => setPublications(payload.publications))
      .catch(() => setPublications([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey]);

  async function publish() {
    setPublishing(true);
    setMessage(null);
    try {
      const payload = await fetchJson<{ candidateCount: number; employeeCount: number }>("/api/admin/deductions/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthKey }),
      });
      setMessage({
        tone: "success",
        text: `Published ${payload.candidateCount} candidate(s) across ${payload.employeeCount} employee(s) for ${monthLabel(monthKey)}.`,
      });
      reload();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Publish failed." });
    } finally {
      setPublishing(false);
    }
  }

  const active = publications?.find((publication) => publication.status === "published") ?? null;

  return (
    <div className="border border-slate-200 bg-white p-4 shadow-sm sm:col-span-2 lg:col-span-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">Publish status — {monthLabel(monthKey)}</p>
          {loading ? (
            <p className="mt-1 text-sm font-semibold text-slate-500">Loading…</p>
          ) : active ? (
            <p className="mt-1 text-sm font-semibold text-emerald-700">
              Published by {active.publishedBy} · {active.candidateCount} candidate(s) · {active.employeeCount} employee(s) ·{" "}
              {new Date(active.publishedAt).toLocaleString()}
            </p>
          ) : (
            <p className="mt-1 text-sm font-semibold text-slate-500">Not yet published for this month.</p>
          )}
        </div>
        {canDecide ? (
          <button
            className="whitespace-nowrap rounded-sm bg-slate-900 px-3 py-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
            disabled={publishing}
            onClick={publish}
            type="button"
          >
            {publishing ? "Publishing…" : active ? "Republish (supersedes current)" : "Publish this month"}
          </button>
        ) : null}
      </div>
      {message ? (
        <p className={["mt-2 text-xs font-semibold", message.tone === "success" ? "text-emerald-700" : "text-red-700"].join(" ")}>
          {message.text}
        </p>
      ) : null}
      {publications && publications.length > 1 ? (
        <p className="mt-2 text-phx-xs text-slate-400">{publications.length - 1} prior publication(s) superseded — full history preserved for audit.</p>
      ) : null}
    </div>
  );
}

function OverviewTab({ monthKey, canDecide }: { monthKey: string; canDecide: boolean }) {
  const [summary, setSummary] = useState<CompanySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchJson<{ summary: CompanySummary }>(`/api/admin/deductions/summary/company?monthKey=${monthKey}`)
      .then((payload) => {
        if (!cancelled) setSummary(payload.summary);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load the overview.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey]);

  if (loading) return <p className="p-6 text-sm font-semibold text-slate-500">Loading…</p>;
  if (error) return <p className="p-6 text-sm font-semibold text-red-700">{error}</p>;
  if (!summary) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <PublicationPanel canDecide={canDecide} monthKey={monthKey} />

      {/* Two totals, never one. "Will publish" uses the exact predicate
          publishMonth uses; "Pending" is everything detected but not yet
          approved, which will NOT be deducted. Showing a single combined figure
          is how HR ended up reading ~3x what publish would actually commit. */}
      <div className="border border-slate-900 bg-slate-900 p-4 shadow-sm sm:col-span-2">
        <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-orange-400">Will publish</p>
        <p className="mt-1 text-3xl font-black text-white">{money(summary.willPublishTotal)} EGP</p>
        <p className="mt-0.5 text-xs font-semibold text-slate-400">This is what pressing Publish commits.</p>
      </div>
      <div className="border border-amber-300 bg-amber-50 p-4 shadow-sm sm:col-span-2">
        <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-amber-700">Pending — will NOT publish</p>
        <p className="mt-1 text-3xl font-black text-amber-900">{money(summary.pendingTotal)} EGP</p>
        <p className="mt-0.5 text-xs font-semibold text-amber-700">
          Detected but awaiting your decision. Not deducted until approved.
        </p>
      </div>

      {visibleDeductionsCategories.map((category) => {
        const config = DEDUCTIONS_CATEGORY_CONFIG[category];
        const willPublish = summary.willPublish[category];
        const pending = summary.pending[category];
        return (
          <div className="border border-slate-200 bg-white p-4 shadow-sm" key={category}>
            <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{config.label}</p>
            <p className="mt-1 text-2xl font-black text-slate-900">{money(willPublish?.totalAmount ?? 0)}</p>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {willPublish?.candidateCount ?? 0} candidate(s) · {willPublish?.employeeCount ?? 0} employee(s)
            </p>
            {(pending?.candidateCount ?? 0) > 0 ? (
              <p className="mt-1 text-xs font-bold text-amber-700">
                + {pending.candidateCount} pending ({money(pending.totalAmount)} EGP) — not publishing
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ByEmployeeTab({ monthKey }: { monthKey: string }) {
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [query, setQuery] = useState("");
  const [summary, setSummary] = useState<EmployeeSummary>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSummary(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<{ summary: EmployeeSummary }>(
      `/api/admin/deductions/summary/employee?monthKey=${monthKey}&employeeHrId=${encodeURIComponent(query.trim())}`,
    )
      .then((payload) => {
        if (!cancelled) setSummary(payload.summary);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load this employee's summary.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey, query]);

  return (
    <div className="border border-slate-200 bg-white p-5 shadow-sm">
      <label className="flex max-w-sm items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
        Employee HR_ID
        <input
          className={phxFieldClassName}
          onChange={(event) => setEmployeeHrId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setQuery(employeeHrId);
          }}
          placeholder="e.g. B-1"
          value={employeeHrId}
        />
        <button
          className="whitespace-nowrap rounded-sm bg-slate-900 px-3 py-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700"
          onClick={() => setQuery(employeeHrId)}
          type="button"
        >
          Look up
        </button>
      </label>

      {loading ? <p className="mt-4 text-sm font-semibold text-slate-500">Loading…</p> : null}
      {error ? <p className="mt-4 text-sm font-semibold text-red-700">{error}</p> : null}
      {!loading && query.trim() && !summary && !error ? (
        <p className="mt-4 text-sm font-semibold text-slate-500">No deductions found for {query} in {monthLabel(monthKey)}.</p>
      ) : null}

      {summary ? (
        <div className="mt-5">
          <h3 className="text-sm font-black text-slate-900">
            {/* Name only — the HR code used to sit beside it as a monospace
                badge. A person is identified by their name on screen; the code
                belongs in the lookup box above, not in the heading. */}
            {summary.employeeName?.trim() || "Name unavailable"}
          </h3>
          {/* Same two-figure presentation as the Overview tab, and for the same
              reason: a per-person card that folds Pending into one "Total" tells
              an employee they are losing money publishing will never take. The
              category rows carry the will-publish amount; anything still
              awaiting a decision is stated beside it, never added to it. */}
          <div className="mt-3 divide-y divide-slate-100 border border-slate-200">
            {visibleDeductionsCategories
              .filter((category) => summary.willPublish[category] || summary.pending[category])
              .map((category, index) => {
                const config = DEDUCTIONS_CATEGORY_CONFIG[category];
                const willPublish = summary.willPublish[category];
                const pending = summary.pending[category];
                return (
                  <div className={["px-4 py-2.5", index % 2 === 1 ? "bg-slate-50/60" : ""].join(" ")} key={category}>
                    <div className="flex items-center justify-between">
                      <span className="whitespace-nowrap text-sm font-semibold text-slate-800">{config.label}</span>
                      <span className="whitespace-nowrap text-sm font-black text-slate-900">
                        {(willPublish?.days ?? 0) > 0 ? `${willPublish!.days} day(s) · ` : ""}
                        {money(willPublish?.amount ?? 0)} EGP
                      </span>
                    </div>
                    {pending ? (
                      <p className="mt-1 whitespace-nowrap text-xs font-bold text-amber-700">
                        + {pending.candidateCount} pending ({money(pending.amount)} EGP) — not publishing
                      </p>
                    ) : null}
                  </div>
                );
              })}
          </div>
          <div className="mt-3 flex items-center justify-between border border-slate-900 bg-slate-900 px-4 py-2.5">
            <span className="whitespace-nowrap text-xs font-black uppercase tracking-[0.1em] text-orange-400">Will publish</span>
            <span className="whitespace-nowrap text-lg font-black text-white">{money(summary.willPublishTotal)} EGP</span>
          </div>
          {summary.pendingTotal > 0 ? (
            <div className="mt-2 flex items-center justify-between border border-amber-300 bg-amber-50 px-4 py-2.5">
              <span className="whitespace-nowrap text-xs font-black uppercase tracking-[0.1em] text-amber-700">
                Pending — will NOT publish
              </span>
              <span className="whitespace-nowrap text-lg font-black text-amber-900">{money(summary.pendingTotal)} EGP</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Final settlement for ONE leaver, inside a month that has not finished.
 *
 * The month guard is right that an unfinished month cannot be collected
 * company-wide. It is not right about somebody who already left: their days
 * ARE over, and the only moment their deductions are worth anything is BEFORE
 * their final settlement is paid. August 2026 is the case that proved it -
 * 13 leavers, every one already resigned, every route to record them shut,
 * and their settlements went out while the workspace insisted on waiting for
 * September.
 *
 * Deliberately one person at a time and one connector per request: the scans
 * are company-wide underneath, and bundling them is what blew the 300s limit
 * and got this module reverted (#1377).
 */
function LeaverSettlementPanel({ monthKey }: { monthKey: string }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<EmployeeMatch[]>([]);
  const [picked, setPicked] = useState<EmployeeMatch | null>(null);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<CollectorRun[]>([]);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const [year, month] = useMemo(() => monthKey.split("-").map(Number), [monthKey]);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2 || picked) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchJson<{ employees: EmployeeMatch[] }>(
        `/api/admin/deductions/employees?q=${encodeURIComponent(term)}&monthKey=${encodeURIComponent(monthKey)}`,
      )
        .then((payload) => {
          // Only leavers here. An active employee's month is not over, so this
          // panel must never offer them - that is the company-wide run's job.
          if (!cancelled) setMatches(payload.employees.filter((entry) => entry.isFinalSettlement));
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, monthKey, picked]);

  async function runSettlement() {
    if (!picked || running) return;
    setRunning(true);
    setMessage(null);
    setRuns([]);
    try {
      const { plan, eligibility } = await fetchJson<{
        plan: Array<{ key: string; label: string }>;
        eligibility: { eligible: boolean; reason?: string };
      }>("/api/admin/deductions/settlement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year, employeeHrId: picked.hrId }),
      });
      if (!eligibility.eligible) {
        setMessage({ tone: "error", text: eligibility.reason ?? "This employee cannot be settled for this month." });
        return;
      }

      let stepped: CollectorRun[] = plan.map((entry) => ({ ...entry, state: "pending" }));
      setRuns(stepped);

      for (const entry of plan) {
        stepped = stepped.map((run) => (run.key === entry.key ? { ...run, state: "running" } : run));
        setRuns(stepped);
        try {
          const payload = await fetchJsonWithTimeout<{
            result: { created: number; skippedExisting: number; warnings: string[] };
          }>(
            "/api/admin/deductions/settlement",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ month, year, employeeHrId: picked.hrId, connector: entry.key }),
            },
            COLLECT_REQUEST_TIMEOUT_MS,
          );
          stepped = stepped.map((run) =>
            run.key === entry.key ? { ...run, state: "done" as const, ...payload.result } : run,
          );
        } catch (error) {
          stepped = stepped.map((run) =>
            run.key === entry.key
              ? { ...run, state: "failed" as const, error: error instanceof Error ? error.message : "Connector failed." }
              : run,
          );
        }
        setRuns(stepped);
      }

      const created = stepped.reduce((sum, run) => sum + (run.created ?? 0), 0);
      const failed = stepped.filter((run) => run.state === "failed");
      setMessage({
        tone: failed.length > 0 ? "error" : "success",
        text:
          `Settlement for ${picked.name}: ${created} candidate(s) found.` +
          (failed.length > 0 ? ` ${failed.length} connector(s) failed.` : " They go to Pending for your decision."),
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Settlement run failed." });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-start gap-2">
        <UserMinus className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <span className="text-sm font-semibold text-slate-700">
          Someone who already left can still be settled. Their last working day has passed, so their days are
          final — and this is the only moment their deductions can come off before the final payment goes out.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <input
            className={cn(phxFieldClassName, "w-72")}
            onChange={(event) => {
              setPicked(null);
              setQuery(event.target.value);
            }}
            placeholder="Search a leaver by name…"
            value={query}
          />
          {matches.length > 0 ? (
            <ul className="absolute top-full z-10 max-h-56 w-72 overflow-y-auto border border-amber-300 bg-white shadow-lg">
              {matches.map((match) => (
                <li key={match.hrId}>
                  <button
                    className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left transition hover:bg-amber-50"
                    onClick={() => {
                      setPicked(match);
                      setQuery(match.name);
                      setMatches([]);
                    }}
                    type="button"
                  >
                    <span className="whitespace-nowrap text-xs font-bold text-slate-900">{match.name}</span>
                    <span className="whitespace-nowrap text-phx-2xs font-bold text-amber-700">
                      {`Left ${readableDate(match.lastWorkingDate) ?? "this month"}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          className="inline-flex items-center gap-1.5 border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!picked || running}
          onClick={runSettlement}
          type="button"
        >
          <PlayCircle className="h-3.5 w-3.5" />
          {running ? "Running…" : "Run final settlement"}
        </button>
      </div>
      {message ? (
        <span
          className={`whitespace-nowrap text-xs font-bold ${message.tone === "error" ? "text-red-700" : "text-emerald-700"}`}
        >
          {message.text}
        </span>
      ) : null}
      {runs.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {runs.map((run) => (
            <li className="whitespace-nowrap text-phx-xs font-semibold text-slate-600" key={run.key}>
              {`${run.label}: ${run.state === "done" ? `${run.created ?? 0} found` : run.state === "failed" ? (run.error ?? "failed") : run.state}`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One (line, region) bucket present in this month's deductions, from
 *  /api/admin/deductions/filters. The pairs — not two independent lists — are
 *  what let this screen answer "how many will this download" exactly. */
type DeductionsOrgGroup = { line: string; region: string; candidates: number; employees: number };

type OrgFilterOption = { value: string; candidates: number };

/** Distinct values on one axis, cross-filtered by the OTHER axis's selection, so
 *  choosing Line: CNS never offers a region that has no CNS deduction. A value
 *  that is currently selected is always listed even when the other axis has
 *  narrowed it away — dropping it would silently change what the button does. */
function orgFilterOptions(
  groups: DeductionsOrgGroup[],
  axis: "line" | "region",
  otherValue: string,
  selectedValue: string,
): OrgFilterOption[] {
  const otherAxis = axis === "line" ? "region" : "line";
  const totals = new Map<string, number>();
  for (const group of groups) {
    if (otherValue && group[otherAxis] !== otherValue) continue;
    totals.set(group[axis], (totals.get(group[axis]) ?? 0) + group.candidates);
  }
  if (selectedValue && !totals.has(selectedValue)) totals.set(selectedValue, 0);
  return Array.from(totals.entries())
    .map(([value, candidates]) => ({ value, candidates }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

/**
 * The whole-month Master workbook, with its Line and Region filters.
 *
 * The filters live HERE, in the same strip as the button, rather than in the
 * page toolbar — they narrow the downloaded file and nothing else on screen, and
 * a control that silently governs only a download has to sit where the download
 * is. The live "N of M deductions" is rendered for the same reason: pressing
 * Download can then hold no surprise, and it is computed from the same (line,
 * region) grouping the server filters on rather than from a second rule.
 */
function MasterExportBar({ monthKey }: { monthKey: string }) {
  const [groups, setGroups] = useState<DeductionsOrgGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [region, setRegion] = useState("");

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetchJson<{ groups: DeductionsOrgGroup[]; totals: { candidates: number } }>(
      `/api/admin/deductions/filters?monthKey=${monthKey}`,
    )
      .then((payload) => {
        if (cancelled) return;
        setGroups(payload.groups ?? []);
        setTotal(payload.totals?.candidates ?? 0);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Unable to load the filters.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monthKey]);

  // The selection is deliberately NOT reset when the month changes — comparing
  // one line across two months is the normal use. A selection with nothing in
  // the new month reads 0 and disables the button, which says so plainly.
  const lineOptions = useMemo(() => orgFilterOptions(groups, "line", region, line), [groups, region, line]);
  const regionOptions = useMemo(() => orgFilterOptions(groups, "region", line, region), [groups, line, region]);
  const matching = useMemo(
    () =>
      groups.reduce(
        (sum, group) => ((line && group.line !== line) || (region && group.region !== region) ? sum : sum + group.candidates),
        0,
      ),
    [groups, line, region],
  );

  const href =
    `/api/admin/deductions/export/master?monthKey=${monthKey}` +
    (line ? `&line=${encodeURIComponent(line)}` : "") +
    (region ? `&region=${encodeURIComponent(region)}` : "");
  const filtered = Boolean(line || region);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <span className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">Master export</span>

      <label className="flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
        Line
        <select
          className={phxSelectClassName}
          disabled={loading || Boolean(error)}
          onChange={(event) => setLine(event.target.value)}
          value={line}
        >
          <option value="">All lines</option>
          {lineOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value} ({option.candidates})
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
        Region
        <select
          className={phxSelectClassName}
          disabled={loading || Boolean(error)}
          onChange={(event) => setRegion(event.target.value)}
          value={region}
        >
          <option value="">All regions</option>
          {regionOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value} ({option.candidates})
            </option>
          ))}
        </select>
      </label>

      {filtered ? (
        <button
          className="text-phx-xs font-black uppercase tracking-[0.08em] text-slate-400 underline transition hover:text-slate-700"
          onClick={() => {
            setLine("");
            setRegion("");
          }}
          type="button"
        >
          Clear
        </button>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-3">
        <span className="text-phx-xs font-bold text-slate-500">
          {loading
            ? "Counting…"
            : error
              ? "Filter options unavailable — the download still works and covers the whole month."
              : filtered
                ? `${matching} of ${total} deduction${total === 1 ? "" : "s"} in this selection`
                : `${total} deduction${total === 1 ? "" : "s"} — the whole company`}
        </span>
        {/* An anchor cannot be disabled, so an empty selection renders as a dead
            button instead. A workbook with no rows in it is not an answer to
            "which of these did I ask for". */}
        {!loading && !error && filtered && matching === 0 ? (
          <span className="inline-flex cursor-not-allowed items-center gap-1.5 whitespace-nowrap border border-slate-200 bg-slate-50 px-3 py-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-400">
            <Download className="h-3.5 w-3.5" />
            Nothing to export
          </span>
        ) : (
          <a
            className="inline-flex items-center gap-1.5 whitespace-nowrap border border-orange-500 bg-white px-3 py-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-orange-600 transition hover:bg-orange-50"
            download
            href={href}
          >
            <Download className="h-3.5 w-3.5" />
            {filtered ? "Master XLSX (filtered)" : "Master XLSX"}
          </a>
        )}
      </div>
    </div>
  );
}

export function DeductionsWorkspace({
  canDecide,
  currentCairoDateIso,
  currentCairoMonthKey,
  highlightCandidateId,
  initialMonthKey,
  initialTab,
}: {
  canDecide: boolean;
  /** Today in Cairo, YYYY-MM-DD — the Head Office cycle's own end (the 21st) is compared against it. */
  currentCairoDateIso: string;
  currentCairoMonthKey: string;
  /** Candidate id from a deduction-comment notification link — opens the Disputes tab on it. */
  highlightCandidateId?: string;
  initialMonthKey: string;
  /** "disputes" when a notification deep-links here; otherwise the workspace opens on Overview. */
  initialTab?: "disputes";
}) {
  const [monthKey, setMonthKey] = useState(initialMonthKey);
  const [activeTab, setActiveTab] = useState<"overview" | "by_employee" | "disputes" | DeductionsCategory>(
    initialTab ?? "overview",
  );
  const [collecting, setCollecting] = useState(false);
  const [collectMessage, setCollectMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [collectorRuns, setCollectorRuns] = useState<CollectorRun[]>([]);
  // Every panel below fetches on mount and on a month change only, so a run that wrote rows left the
  // page reading 0 until a manual reload (owner, 2026-10-26: "it's not pulling any deduction" — the
  // October Head Office run had written 28). Bumping this after every run re-keys the panels, and each
  // one remounts and re-reads what the run just wrote.
  const [dataVersion, setDataVersion] = useState(0);
  const panelKey = `${monthKey}:${dataVersion}`;

  // `isCollectableMonth` on the server is the real enforcement and stays that way — this is only the
  // matching UI. Without it the page was a trap. The month selector is seeded to the CURRENT Cairo
  // month on purpose (that is the month publish files under), so for the whole of an unfinished month
  // pressing Run fired one request per connector, every one was refused, and the summary rendered
  // "6 connector(s) failed" in red with a red cross. Nothing had failed — the guard had worked.
  // Presenting a working safety guard as six errors is precisely how somebody ends up "fixing" the
  // guard, and that guard exists because collecting an in-progress month charged real people
  // 39,225.73 EGP on 2026-08-03. Lexicographic compare is exact for `YYYY-MM`, and comparing strings
  // keeps the server-only collector module out of this client bundle.
  const monthHasFinished = monthKey < currentCairoMonthKey;

  const [year, month] = useMemo(() => monthKey.split("-").map(Number), [monthKey]);

  // THE TWO CYCLES (owner, 2026-10-26). From the October 2026 payroll month the one-part employees are
  // collected on the Head Office cycle — the 22nd of the previous month → the 21st — so Part 1 can carry
  // their deductions before the month ends; everyone paid in two parts stays on the calendar month.
  // Each choice is gated on ITS OWN window's end; the server re-checks both (collect.ts).
  const [cycleChoice, setCycleChoice] = useState<DeductionCycle>("office");
  const splitCycleMonth = Boolean(year && month) && isSplitCycleMonth({ year, month });
  const cycle: DeductionCycle = splitCycleMonth ? cycleChoice : "calendar";
  const officeWindow = cycle === "office" ? cycleWindow("office", { year, month }) : null;
  const windowHasFinished = officeWindow ? isCycleWindowCollectable(officeWindow, currentCairoDateIso) : monthHasFinished;
  const cycleRunLabel = officeWindow
    ? `Head Office cycle (${dayWithMonth(officeWindow.start)} → ${dayWithMonth(officeWindow.end)})`
    : monthLabel(monthKey);

  // Connectors are run ONE PER REQUEST. Bundling all five into a single call is
  // what blew the 300s Cloud Run limit and got this module reverted (#1377);
  // stepping through them keeps every request bounded and lets a slow connector
  // fail on its own instead of taking the whole run down with it.
  async function runCollection() {
    // The button is disabled, but never let a stray call fan out into six refusals.
    if (!windowHasFinished) return;
    setCollecting(true);
    setCollectMessage(null);
    setCollectorRuns([]);
    try {
      const { plan } = await fetchJson<{ plan: Array<{ key: string; label: string }> }>("/api/admin/deductions/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, year }),
      });

      let runs: CollectorRun[] = plan.map((entry) => ({ ...entry, state: "pending" }));
      setCollectorRuns(runs);

      for (const entry of plan) {
        runs = runs.map((run) => (run.key === entry.key ? { ...run, state: "running" } : run));
        setCollectorRuns(runs);
        try {
          const payload = await fetchJsonWithTimeout<{
            result: { created: number; skippedExisting: number; warnings: string[] };
          }>(
            "/api/admin/deductions/collect",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ month, year, connector: entry.key, cycle }),
            },
            COLLECT_REQUEST_TIMEOUT_MS,
          );
          runs = runs.map((run) =>
            run.key === entry.key ? { ...run, state: "done" as const, ...payload.result } : run,
          );
        } catch (error) {
          runs = runs.map((run) =>
            run.key === entry.key
              ? { ...run, state: "failed" as const, error: error instanceof Error ? error.message : "Connector failed." }
              : run,
          );
        }
        setCollectorRuns(runs);
      }

      const created = runs.reduce((sum, run) => sum + (run.created ?? 0), 0);
      const warnings = runs.flatMap((run) => run.warnings ?? []);
      const failed = runs.filter((run) => run.state === "failed");
      setCollectMessage({
        tone: failed.length > 0 || warnings.length > 0 ? "error" : "success",
        text:
          `Collection complete: ${created} new candidate(s).` +
          (failed.length > 0 ? ` ${failed.length} connector(s) failed — see the breakdown below.` : "") +
          (warnings.length > 0 ? ` ${warnings.length} warning(s) — listed per connector below.` : ""),
      });
    } catch (error) {
      setCollectMessage({ tone: "error", text: error instanceof Error ? error.message : "Collection run failed." });
    } finally {
      setCollecting(false);
      setDataVersion((version) => version + 1);
    }
  }

  const tabs: Array<{ key: "overview" | "by_employee" | "disputes" | DeductionsCategory; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "by_employee", label: "By Employee" },
    ...visibleDeductionsCategories.map((category) => ({ key: category, label: DEDUCTIONS_CATEGORY_CONFIG[category].label })),
    { key: "disputes", label: "Disputes" },
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <label className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
          Month
          <input
            className={phxFieldClassName}
            onChange={(event) => setMonthKey(event.target.value)}
            type="month"
            value={monthKey}
          />
        </label>
        {canDecide && splitCycleMonth ? (
          <label className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
            Cycle
            <select
              className={phxSelectClassName}
              disabled={collecting}
              onChange={(event) => setCycleChoice(event.target.value === "calendar" ? "calendar" : "office")}
              value={cycleChoice}
            >
              <option value="office">Head Office cycle (22nd → 21st) — paid in one part</option>
              <option value="calendar">Calendar month — paid in two parts</option>
            </select>
          </label>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {canDecide ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-sm bg-orange-500 px-3 py-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-white transition hover:bg-orange-600 disabled:opacity-50"
              disabled={collecting || !windowHasFinished}
              onClick={runCollection}
              type="button"
            >
              <PlayCircle className="h-3.5 w-3.5" />
              {collecting ? "Running…" : `Run collection for ${cycleRunLabel}`}
            </button>
          ) : null}
        </div>
      </div>

      {/* Master workbook for the whole month, every category together — a
          per-employee summary of what will actually be deducted plus a full
          detail sheet (Line, Region and Direct Manager), narrowable to one line
          and/or one region. Sits BESIDE the per-category "Download XLSX" on each
          tab, never replacing it. */}
      <MasterExportBar key={panelKey} monthKey={monthKey} />

      {canDecide && !windowHasFinished && officeWindow ? (
        <div className="flex items-start gap-2 border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>
            The Head Office cycle for {monthLabel(monthKey)} runs to {dayWithMonth(officeWindow.end)} and has not
            finished — it can be collected from the day after. A day with no activity only means something after
            that day has ended, so collecting now would charge people for days they are still working.
          </span>
        </div>
      ) : null}

      {canDecide && !windowHasFinished && !officeWindow ? (
        <div className="flex items-start gap-2 border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>
            {monthLabel(monthKey)} has not finished — collection runs once the month is over. A day with no
            activity only means something after that day has ended, so collecting now would charge people
            for days they are still working. Select a completed month to run collection.
          </span>
        </div>
      ) : null}

      {canDecide && !monthHasFinished ? <LeaverSettlementPanel key={panelKey} monthKey={monthKey} /> : null}

      {collectMessage ? (
        <div
          className={[
            "flex items-center gap-2 border px-4 py-2.5 text-sm font-semibold",
            collectMessage.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800",
          ].join(" ")}
        >
          {collectMessage.tone === "success" ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
          {collectMessage.text}
        </div>
      ) : null}

      {collectorRuns.length > 0 ? (
        <div className="divide-y divide-slate-200 border border-slate-200 bg-white">
          {collectorRuns.map((run) => (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5" key={run.key}>
              <span className="text-sm font-semibold text-slate-800">{run.label}</span>
              <span className="ml-auto text-sm font-semibold">
                {run.state === "pending" ? <span className="text-slate-400">Waiting…</span> : null}
                {run.state === "running" ? <span className="text-orange-600">Running…</span> : null}
                {run.state === "done" ? (
                  <span className={run.warnings && run.warnings.length > 0 ? "text-amber-700" : "text-emerald-700"}>
                    {run.created ?? 0} new · {run.skippedExisting ?? 0} already live
                    {run.warnings && run.warnings.length > 0 ? ` · ${run.warnings.length} warning(s)` : ""}
                  </span>
                ) : null}
                {run.state === "failed" ? <span className="text-red-700">{run.error}</span> : null}
              </span>
              {/* Show the warnings themselves. The first production run reported
                  "120 warning(s) — see server logs", but warnings are returned in
                  the response and never logged, so the logs were empty and the
                  only copy of the diagnosis was thrown away by this component. */}
              {run.warnings && run.warnings.length > 0 ? (
                <ul className="w-full list-disc space-y-1 border-t border-slate-100 pl-5 pt-2 text-xs font-medium text-amber-800">
                  {run.warnings.slice(0, 10).map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                  {run.warnings.length > 10 ? (
                    <li className="list-none pl-0 text-slate-500">
                      …and {run.warnings.length - 10} more of the same kind.
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-px">
        {tabs.map((tab) => (
          <button
            className={[
              "whitespace-nowrap rounded-t-sm px-3 py-2 text-phx-xs font-black uppercase tracking-[0.08em] transition",
              activeTab === tab.key
                ? "border border-b-0 border-slate-200 bg-white text-orange-600"
                : "text-slate-500 hover:text-slate-800",
            ].join(" ")}
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? <OverviewTab key={panelKey} canDecide={canDecide} monthKey={monthKey} /> : null}
      {activeTab === "by_employee" ? <ByEmployeeTab key={panelKey} monthKey={monthKey} /> : null}
      {activeTab === "disputes" ? <DisputesTab canReply={canDecide} highlightCandidateId={highlightCandidateId} /> : null}
      {activeTab !== "overview" && activeTab !== "by_employee" && activeTab !== "disputes" ? (
        <CategoryTab key={panelKey} canDecide={canDecide} category={activeTab} monthKey={monthKey} />
      ) : null}
    </section>
  );
}
