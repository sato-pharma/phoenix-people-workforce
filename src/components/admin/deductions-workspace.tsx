"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, PlayCircle, RotateCcw, XCircle } from "lucide-react";

import {
  DEDUCTIONS_CATEGORY_CONFIG,
  resolveAppliedDeductionDates,
  scaleDeductionAmountToDays,
} from "@/lib/deductions/calculations.ts";
import { visibleDeductionsCategories, type DeductionsCategory } from "@/lib/deductions/types.ts";

type CandidateApiRow = {
  id: string;
  category: DeductionsCategory;
  employeeHrId: string;
  employeeName: string | null;
  /** Resolved from the employees table at read time — see service.ts. */
  hireDate?: string | null;
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
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(
    new Date(Date.UTC(year, month - 1, day)),
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
    <span className="whitespace-nowrap tabular-nums">
      {detected.map((date, index) => (
        <span className={applied.has(date) ? "text-slate-700" : "text-slate-400 line-through"} key={date}>
          {dayOfMonth(date)}
          {index < detected.length - 1 ? ", " : ""}
        </span>
      ))}
    </span>
  );
}

/** The day count a candidate currently charges. */
function appliedDaysOf(row: CandidateApiRow): number {
  if (row.unit !== "days") return 0;
  if (row.decision?.appliedValue != null) return row.decision.appliedValue;
  return row.decision?.appliedDates != null ? row.decision.appliedDates.length : row.rawValue;
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
    () => row.unit === "days" && row.decision?.appliedValue != null && row.decision.appliedValue !== appliedDatesOf(row).length,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
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
    if (!manualQuantity) setQuantity(String(next.length));
  }

  function setAll(checked: boolean) {
    const next = checked ? [...detected] : [];
    setSelected(next);
    if (!manualQuantity) setQuantity(String(next.length));
  }

  function resetQuantityToTicks() {
    setManualQuantity(false);
    setQuantity(String(selected.length));
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
      const payload = await fetchJson<{ decision: CandidateApiRow["decision"] }>("/api/admin/deductions/decisions", {
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
      onSaved(row.id, payload.decision);
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
            <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">Days to deduct</p>
            <button
              className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.08em] text-slate-500 underline transition hover:text-orange-600"
              onClick={() => setAll(true)}
              type="button"
            >
              Select all
            </button>
            <button
              className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.08em] text-slate-500 underline transition hover:text-orange-600"
              onClick={() => setAll(false)}
              type="button"
            >
              Clear all
            </button>
          </div>
          {/* A control grid, not a paragraph: fixed columns so a 19-day month
              lays out deliberately instead of reflowing like wrapped text. */}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-1.5">
            {detected.map((date) => {
              const checked = selectedSet.has(date);
              return (
                <label
                  className={[
                    "flex cursor-pointer items-center gap-1.5 whitespace-nowrap border px-2 py-1 text-xs font-bold tabular-nums transition",
                    checked
                      ? "border-orange-400 bg-white text-slate-900"
                      : "border-slate-200 bg-slate-100 text-slate-400 line-through",
                  ].join(" ")}
                  key={date}
                >
                  <input
                    checked={checked}
                    className="h-3.5 w-3.5 accent-orange-500"
                    onChange={() => toggleDay(date)}
                    type="checkbox"
                  />
                  Day {dayOfMonth(date)}
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-xs font-semibold text-slate-500">
          This deduction carries no dated days — set the quantity directly.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">
            {row.unit === "days" ? "Deduction quantity (days)" : "Deduction amount (EGP)"}
          </span>
          <input
            className="w-32 border border-slate-300 bg-white px-2 py-1 text-sm font-black tabular-nums text-slate-900 focus:border-orange-400 focus:outline-none"
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
          <span className="whitespace-nowrap text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">
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
            className="whitespace-nowrap bg-slate-900 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
            disabled={saving}
            onClick={save}
            type="button"
          >
            {saving ? "Saving…" : "Save days"}
          </button>
          <button
            className="whitespace-nowrap px-2 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-slate-500 transition hover:text-slate-800"
            disabled={saving}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>

      {manualQuantity && row.unit === "days" && parsedQuantity !== selected.length ? (
        <p className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          You typed {quantity} but {selected.length} day(s) are ticked — the typed number is what gets deducted.
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
        <p className="text-[11px] font-bold text-amber-800">
          No days ticked — this publishes as 0.00 EGP. To drop the deduction entirely, decide it as “Do Not Take Action”.
        </p>
      ) : null}

      {overDetected ? (
        <p className="text-[11px] font-bold text-red-700">
          Only {row.rawValue} day(s) were detected for this employee — you cannot deduct more than that.
        </p>
      ) : null}

      {error ? <p className="text-[11px] font-semibold text-red-700">{error}</p> : null}
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

type EmployeeSummary = {
  employeeHrId: string;
  employeeName: string | null;
  monthKey: string;
  byCategory: Partial<Record<DeductionsCategory, { days: number; amount: number; candidateCount: number }>>;
  totalAmount: number;
} | null;

const DECISION_STATUSES = ["Approved for Payroll", "Do Not Take Action", "Needs Follow-up", "Disputed"] as const;

function money(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value);
}

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
    <span className={["whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em]", tone].join(" ")}>
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
    try {
      const payload = await fetchJson<{ decision: CandidateApiRow["decision"] }>("/api/admin/deductions/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: row.id, decisionStatus: status, decisionReason: effectiveReason }),
      });
      onDecided(row.id, payload.decision);
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
      {open ? (
        <div className="space-y-1.5 rounded-sm border border-slate-200 bg-slate-50 p-2">
          <input
            className="w-full rounded-sm border border-slate-200 px-2 py-1 text-xs text-slate-900 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setReason(event.target.value)}
            placeholder="Decision reason"
            value={reason}
          />
          {error ? <p className="text-[11px] font-semibold text-red-700">{error}</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {DECISION_STATUSES.map((status) => (
              <button
                className="rounded-sm bg-slate-900 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
                disabled={submitting}
                key={status}
                onClick={() => decide(status)}
                type="button"
              >
                {status}
              </button>
            ))}
            <button
              className="rounded-sm px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-slate-500"
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
          className="rounded-sm border border-slate-300 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
          onClick={() => setOpen(true)}
          type="button"
        >
          Decide
        </button>
      )}
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
  }, [category, monthKey]);

  function handleDecided(candidateId: string, decision: CandidateApiRow["decision"]) {
    setRows((current) => current.map((row) => (row.id === candidateId ? { ...row, decision } : row)));
  }

  const config = DEDUCTIONS_CATEGORY_CONFIG[category];

  return (
    <div className="border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-5 py-3">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
          {loading ? "Loading…" : `${rows.length} ${config.label} candidate${rows.length === 1 ? "" : "s"}`}
        </h2>
        <div className="flex items-center gap-2">
          {!config.requiresApproval ? (
            <span className="whitespace-nowrap rounded-full bg-orange-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-orange-300">
              Mandatory unless cleared
            </span>
          ) : null}
          <a
            className="inline-flex items-center gap-1.5 whitespace-nowrap border border-orange-500 bg-orange-500 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-orange-600"
            download
            href={`/api/admin/deductions/export?category=${category}&monthKey=${monthKey}`}
          >
            <Download className="h-3.5 w-3.5" />
            Download XLSX
          </a>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      {!loading && rows.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-sm font-bold text-slate-500">No {config.label.toLowerCase()} candidates for {monthLabel(monthKey)}.</p>
        </div>
      ) : (
        <>
          {/* Desktop: table. Mobile: stacked cards — never horizontal-scroll a table. */}
          <div className="hidden overflow-hidden sm:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">
                  <th className="px-4 py-2">Employee</th>
                  <th className="whitespace-nowrap px-4 py-2">Hire date</th>
                  <th className="px-4 py-2">Days</th>
                  <th className="px-4 py-2">Dates deducted</th>
                  <th className="px-4 py-2">Amount</th>
                  <th className="px-4 py-2">Reason</th>
                  <th className="px-4 py-2">Status</th>
                  {canDecide ? <th className="px-4 py-2">Action</th> : null}
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
                        {/* Employee NAME only. Not "name, falling back to the HR
                            code" either — a raw code must never reach a screen, so
                            the name is resolved server-side from the employees
                            directory when the candidate did not carry one. */}
                        <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-slate-900">
                          {employeeLabel(row)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-600">
                          {hireDateLabel(row.hireDate)}
                        </td>
                        {/* What is CHARGED, with what was detected beside it when the
                            two differ. Showing rawValue alone made a reviewer's own
                            reduction invisible in the column it changed. */}
                        <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-700">
                          {row.unit === "days" ? (
                            <>
                              <span className={narrowed ? "font-black text-orange-600" : ""}>{appliedDays}</span>
                              {narrowed ? <span className="text-xs text-slate-400"> of {row.rawValue}</span> : null}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                        {/* WHICH days, not just how many. The candidate has always carried
                            the exact dates; the table simply never showed them, so a
                            reviewer could see "14 days" with no way to tell which 14 or to
                            check one against a calendar. Day numbers only — the whole view
                            is already scoped to one month, so the year/month would be
                            repetition, and this keeps a 19-day row on a single line
                            instead of wrapping or being cut off. */}
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-700">
                          <DayList row={row} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-slate-700">
                          {amount != null ? money(amount) : "requires review"}
                        </td>
                        <td className="max-w-xs px-4 py-2.5 text-xs text-slate-600">{row.reason ?? "—"}</td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={row.decision?.decisionStatus ?? null} />
                        </td>
                        {canDecide ? (
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                className="mt-1.5 whitespace-nowrap border border-slate-300 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
                                onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                                type="button"
                              >
                                {editingId === row.id ? "Close days" : "Edit days"}
                              </button>
                              <CandidateDecideRow canDecide={canDecide} onDecided={handleDecided} row={row} />
                            </div>
                          </td>
                        ) : null}
                      </tr>
                      {canDecide && editingId === row.id ? (
                        <tr className="border-b border-slate-200 bg-white">
                          <td className="px-4 pb-3" colSpan={8}>
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
          <div className="divide-y divide-slate-100 sm:hidden">
            {rows.map((row, index) => {
              const appliedDays = appliedDaysOf(row);
              const narrowed = row.unit === "days" && appliedDays !== row.rawValue;
              const amount = appliedAmountOf(row);
              return (
                <div className={["px-4 py-3", index % 2 === 1 ? "bg-slate-50/60" : ""].join(" ")} key={row.id}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="whitespace-nowrap font-semibold text-slate-900">{employeeLabel(row)}</p>
                    <StatusBadge status={row.decision?.decisionStatus ?? null} />
                  </div>
                  <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">Hired {hireDateLabel(row.hireDate)}</p>
                  <p className="mt-0.5 whitespace-nowrap text-xs text-slate-500">
                    {row.unit === "days" ? `${appliedDays}${narrowed ? ` of ${row.rawValue}` : ""} day(s)` : ""} ·{" "}
                    {amount != null ? `${money(amount)} EGP` : "requires review"}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-slate-700">
                    Dates: <DayList row={row} />
                  </p>
                  {row.reason ? <p className="mt-1 text-xs text-slate-600">{row.reason}</p> : null}
                  {canDecide ? (
                    <button
                      className="mt-1.5 whitespace-nowrap border border-slate-300 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-slate-700 transition hover:border-orange-400 hover:text-orange-600"
                      onClick={() => setEditingId(editingId === row.id ? null : row.id)}
                      type="button"
                    >
                      {editingId === row.id ? "Close days" : "Edit days"}
                    </button>
                  ) : null}
                  {canDecide && editingId === row.id ? (
                    <div className="mt-2">
                      <DeductionDaysEditor onClose={() => setEditingId(null)} onSaved={handleDecided} row={row} />
                    </div>
                  ) : null}
                  <CandidateDecideRow canDecide={canDecide} onDecided={handleDecided} row={row} />
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
          <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">Publish status — {monthLabel(monthKey)}</p>
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
            className="whitespace-nowrap rounded-sm bg-slate-900 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700 disabled:opacity-50"
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
        <p className="mt-2 text-[11px] text-slate-400">{publications.length - 1} prior publication(s) superseded — full history preserved for audit.</p>
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
        <p className="text-[11px] font-black uppercase tracking-[0.1em] text-orange-400">Will publish</p>
        <p className="mt-1 text-3xl font-black text-white">{money(summary.willPublishTotal)} EGP</p>
        <p className="mt-0.5 text-xs font-semibold text-slate-400">This is what pressing Publish commits.</p>
      </div>
      <div className="border border-amber-300 bg-amber-50 p-4 shadow-sm sm:col-span-2">
        <p className="text-[11px] font-black uppercase tracking-[0.1em] text-amber-700">Pending — will NOT publish</p>
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
            <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-500">{config.label}</p>
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
          className="w-full rounded-sm border border-slate-200 px-2 py-1.5 text-sm font-semibold text-slate-900 focus:border-orange-400 focus:outline-none"
          onChange={(event) => setEmployeeHrId(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setQuery(employeeHrId);
          }}
          placeholder="e.g. B-1"
          value={employeeHrId}
        />
        <button
          className="whitespace-nowrap rounded-sm bg-slate-900 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-slate-700"
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
          <div className="mt-3 divide-y divide-slate-100 border border-slate-200">
            {visibleDeductionsCategories
              .filter((category) => summary.byCategory[category])
              .map((category, index) => {
                const config = DEDUCTIONS_CATEGORY_CONFIG[category];
                const bucket = summary.byCategory[category]!;
                return (
                  <div className={["flex items-center justify-between px-4 py-2.5", index % 2 === 1 ? "bg-slate-50/60" : ""].join(" ")} key={category}>
                    <span className="text-sm font-semibold text-slate-800">{config.label}</span>
                    <span className="text-sm font-black text-slate-900">
                      {bucket.days > 0 ? `${bucket.days} day(s) · ` : ""}
                      {money(bucket.amount)} EGP
                    </span>
                  </div>
                );
              })}
          </div>
          <div className="mt-3 flex items-center justify-between border border-slate-900 bg-slate-900 px-4 py-2.5">
            <span className="text-xs font-black uppercase tracking-[0.1em] text-orange-400">Total</span>
            <span className="text-lg font-black text-white">{money(summary.totalAmount)} EGP</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DeductionsWorkspace({ canDecide, initialMonthKey }: { canDecide: boolean; initialMonthKey: string }) {
  const [monthKey, setMonthKey] = useState(initialMonthKey);
  const [activeTab, setActiveTab] = useState<"overview" | "by_employee" | DeductionsCategory>("overview");
  const [collecting, setCollecting] = useState(false);
  const [collectMessage, setCollectMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [collectorRuns, setCollectorRuns] = useState<CollectorRun[]>([]);

  const [year, month] = useMemo(() => monthKey.split("-").map(Number), [monthKey]);

  // Connectors are run ONE PER REQUEST. Bundling all five into a single call is
  // what blew the 300s Cloud Run limit and got this module reverted (#1377);
  // stepping through them keeps every request bounded and lets a slow connector
  // fail on its own instead of taking the whole run down with it.
  async function runCollection() {
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
              body: JSON.stringify({ month, year, connector: entry.key }),
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
    }
  }

  const tabs: Array<{ key: "overview" | "by_employee" | DeductionsCategory; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "by_employee", label: "By Employee" },
    ...visibleDeductionsCategories.map((category) => ({ key: category, label: DEDUCTIONS_CATEGORY_CONFIG[category].label })),
  ];

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <label className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.1em] text-slate-500">
          Month
          <input
            className="rounded-sm border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-900 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setMonthKey(event.target.value)}
            type="month"
            value={monthKey}
          />
        </label>
        {canDecide ? (
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-sm bg-orange-500 px-3 py-1.5 text-[11px] font-black uppercase tracking-[0.08em] text-white transition hover:bg-orange-600 disabled:opacity-50"
            disabled={collecting}
            onClick={runCollection}
            type="button"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            {collecting ? "Running…" : `Run collection for ${monthLabel(monthKey)}`}
          </button>
        ) : null}
      </div>

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
              "whitespace-nowrap rounded-t-sm px-3 py-2 text-[11px] font-black uppercase tracking-[0.08em] transition",
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

      {activeTab === "overview" ? <OverviewTab canDecide={canDecide} monthKey={monthKey} /> : null}
      {activeTab === "by_employee" ? <ByEmployeeTab monthKey={monthKey} /> : null}
      {activeTab !== "overview" && activeTab !== "by_employee" ? (
        <CategoryTab canDecide={canDecide} category={activeTab} monthKey={monthKey} />
      ) : null}
    </section>
  );
}
