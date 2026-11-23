"use client";

// Daily Deductions — DEDUCT A DAY BY HAND (owner, 2026-11-23): choose a person, choose a day, read what
// Phoenix holds for that day, then push one day (or half a day) with a comment the employee reads. The
// push is written "Pending"; payroll charges it only once it is "Approved for Payroll" on the Deductions
// screen. Super Admin only — the page mounts it for him alone and the route refuses everyone else.

import { useEffect, useState } from "react";
import { AlertTriangle, CalendarSearch, CheckCircle2, Search } from "lucide-react";

import { adminPanelDepthClassName, adminPanelHeaderClassName } from "@/components/admin/admin-design-tokens";
import { CheckTile } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxFieldClassName,
  phxHintClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { deductionsCategoryNames, type DeductionsCategory } from "@/lib/deductions/types.ts";
import { cn } from "@/lib/utils";

const PANEL = cn("border border-slate-200 bg-white", adminPanelDepthClassName);
const PANEL_TITLE = "text-xs font-black uppercase tracking-[0.14em] text-white";
const LABEL = "text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500";
const COMMENT_MAX = 1000;

type EmployeeMatch = { hrId: string; name: string; jobTitle: string | null; isFinalSettlement: boolean };

type RecordItem = {
  source: string;
  sourceLabel: string;
  title: string;
  time: string | null;
  details: string[];
  severity: "danger" | "info" | "success" | "warning";
  status: string | null;
  isPlan: boolean;
};

type ExistingCharge = {
  candidateId: string;
  category: DeductionsCategory;
  monthKey: string;
  decisionStatus: string;
  amount: number | null;
  isDayReview: boolean;
};

type ReleasedLine = { lineId: string; label: string; amount: number; daysCount: number };

type DayRecord = {
  employee: { hrId: string; name: string; jobTitle: string | null; hasLeft: boolean; lastWorkingDate: string | null };
  date: string;
  items: RecordItem[];
  recordIncomplete: boolean;
  unreadableSources: string[];
  existingCharges: ExistingCharge[];
  releasedOnDay: ReleasedLine[];
  releasedUnreadable: boolean;
  price: { fullDay: number | null; halfDay: number | null };
  payrollMonthKey: string;
  refusal: string | null;
};

type PushResult = { employeeName: string; date: string; fraction: 1 | 0.5; amount: number | null; payrollMonthKey: string };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
  }
  return payload as T;
}

function money(value: number | null): string {
  if (value == null) return "No base salary on record";
  return `${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;
}

function dayLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-GB", { timeZone: "UTC", month: "long", year: "numeric" });
}

const SEVERITY_RAIL: Record<RecordItem["severity"], string> = {
  danger: "border-l-rose-500",
  warning: "border-l-amber-500",
  success: "border-l-emerald-500",
  info: "border-l-slate-400",
};

export function DailyDeductionsDayReview({ today }: { today: string }) {
  const [query, setQuery] = useState("");
  // Matches are kept with the term they answer, so a stale answer (or a cleared box) shows nothing.
  const [found, setFound] = useState<{ term: string; employees: EmployeeMatch[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<EmployeeMatch | null>(null);
  const [date, setDate] = useState(today);
  // The day is kept with the request it answers; a new person or day reads as loading until its own answer lands.
  const [loaded, setLoaded] = useState<{ key: string; record: DayRecord | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fraction, setFraction] = useState<1 | 0.5>(1);
  const [comment, setComment] = useState("");
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState<PushResult | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Name search. The month of the chosen day widens it to whoever left in that month.
  useEffect(() => {
    const term = query.trim();
    if (picked && term === picked.name) return;
    if (term.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      fetchJson<{ employees: EmployeeMatch[] }>(
        `/api/admin/deductions/employees?q=${encodeURIComponent(term)}&monthKey=${encodeURIComponent(date.slice(0, 7))}`,
      )
        .then((payload) => {
          if (!cancelled) setFound({ term, employees: payload.employees });
        })
        .catch(() => {
          if (!cancelled) setFound({ term, employees: [] });
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, date, picked]);

  // The day's record, read again whenever the person or the day changes (and after a push).
  const recordKey = picked && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${picked.hrId}|${date}|${reloadKey}` : null;
  useEffect(() => {
    if (!recordKey) return;
    const [hrId, day] = recordKey.split("|");
    let cancelled = false;
    fetchJson<{ record: DayRecord }>(
      `/api/admin/daily-deductions/day-review?employeeHrId=${encodeURIComponent(hrId)}&date=${encodeURIComponent(day)}`,
    )
      .then((payload) => {
        if (!cancelled) setLoaded({ key: recordKey, record: payload.record, error: null });
      })
      .catch((loadError) => {
        if (!cancelled) {
          setLoaded({ key: recordKey, record: null, error: loadError instanceof Error ? loadError.message : "Could not read that day." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [recordKey]);
  const current = recordKey && loaded?.key === recordKey ? loaded : null;
  const record = current?.record ?? null;
  const loading = Boolean(recordKey) && !current;
  const loadError = current?.error ?? null;
  const term = query.trim();
  const matches = !picked && found && found.term === term && term.length >= 2 ? found.employees : [];

  function choose(match: EmployeeMatch) {
    setPicked(match);
    setQuery(match.name);
    setFound(null);
    setPushed(null);
    setError(null);
  }

  async function push() {
    if (!picked || !record || pushing) return;
    if (!comment.trim()) {
      setError("Write the comment the employee will read.");
      return;
    }
    setPushing(true);
    setError(null);
    try {
      const payload = await fetchJson<{ result: PushResult }>("/api/admin/daily-deductions/day-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeHrId: picked.hrId, date, fraction, comment: comment.trim() }),
      });
      setPushed(payload.result);
      setComment("");
      setReloadKey((key) => key + 1);
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : "The deduction could not be pushed.");
    } finally {
      setPushing(false);
    }
  }

  const blocked = Boolean(record && (record.refusal || record.existingCharges.length > 0 || record.releasedOnDay.length > 0 || record.releasedUnreadable));
  const chosenPrice = record ? (fraction === 1 ? record.price.fullDay : record.price.halfDay) : null;
  const commentLength = comment.trim().length;
  const canPush = Boolean(record) && !blocked && !loading && commentLength > 0 && commentLength <= COMMENT_MAX && !pushing;

  return (
    <section className={PANEL}>
      <div className={cn("flex flex-wrap items-center gap-2 px-4 py-3", adminPanelHeaderClassName)}>
        <CalendarSearch className="h-4 w-4 text-white" />
        <h2 className={PANEL_TITLE}>Deduct a day by hand</h2>
      </div>

      <div className="space-y-5 p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <label className="relative flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Employee</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className={cn(phxFieldClassName, "pl-9")}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (picked && event.target.value !== picked.name) {
                    setPicked(null);
                    setPushed(null);
                  }
                }}
                placeholder="Type a name"
                type="search"
                value={query}
              />
            </span>
            {matches.length > 0 ? (
              <ul className="absolute left-0 right-0 top-full z-20 max-h-72 overflow-y-auto border border-slate-300 bg-white">
                {matches.map((match) => (
                  <li key={match.hrId}>
                    <button
                      className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-orange-50"
                      onClick={() => choose(match)}
                      type="button"
                    >
                      <span className="text-sm font-bold text-slate-900">{match.name}</span>
                      <span className="text-xs text-slate-500">
                        {[match.jobTitle, match.isFinalSettlement ? "Has left" : null].filter(Boolean).join(" · ") || "No job title on record"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {searching ? <span className={phxHintClassName}>Searching…</span> : null}
          </label>

          <label className="flex min-w-0 flex-col gap-1">
            <span className={LABEL}>Day</span>
            <input
              className={phxFieldClassName}
              max={today}
              onChange={(event) => {
                setDate(event.target.value);
                setPushed(null);
              }}
              type="date"
              value={date}
            />
          </label>
        </div>

        {!picked ? (
          <p className="text-sm text-slate-500">Choose an employee and a day to see what Phoenix holds for it.</p>
        ) : null}

        {error || loadError ? (
          <p className="flex items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{error ?? loadError}</span>
          </p>
        ) : null}

        {pushed ? (
          <p className="flex items-start gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              <strong>Sent for approval.</strong> {pushed.fraction === 0.5 ? "Half a day" : "1 day"} for {pushed.employeeName} on{" "}
              {dayLabel(pushed.date)} ({money(pushed.amount)}). {pushed.employeeName} sees it now on their Deductions page as under
              review, with your comment. Approve it on the Deductions screen — Other tab, {monthLabel(pushed.payrollMonthKey)} —
              and payroll charges it once it is Approved for Payroll.
            </span>
          </p>
        ) : null}

        {loading ? <p className="text-sm text-slate-500">Reading the day…</p> : null}

        {record && !loading ? (
          <div className="space-y-5">
            <div className="border-b border-slate-200 pb-3">
              <p className="text-base font-black text-slate-900">{record.employee.name}</p>
              <p className="text-sm text-slate-500">
                {[record.employee.jobTitle, dayLabel(record.date)].filter(Boolean).join(" · ")}
                {record.employee.hasLeft && record.employee.lastWorkingDate
                  ? ` · Last working day ${dayLabel(record.employee.lastWorkingDate)}`
                  : ""}
              </p>
            </div>

            <div className="space-y-2">
              <h3 className={LABEL}>What Phoenix holds for that day</h3>
              {record.recordIncomplete ? (
                <p className="border-l-4 border-l-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  {record.unreadableSources.length > 0
                    ? `Could not be read just now: ${record.unreadableSources.join(", ")}. What is listed below may be missing those.`
                    : "The day's record could not be read just now, so an empty list here does not mean nothing happened."}
                </p>
              ) : null}
              {record.items.length === 0 && !record.recordIncomplete ? (
                <p className="border border-slate-200 px-3 py-2 text-sm text-slate-600">
                  Nothing is recorded for this day — no punch, visit, leave, excuse, trip or interview.
                </p>
              ) : null}
              <ul className="space-y-2">
                {record.items.map((item, index) => (
                  <li className={cn("border border-slate-200 border-l-4 px-3 py-2", SEVERITY_RAIL[item.severity])} key={`${item.source}-${index}`}>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{item.sourceLabel}</span>
                      <span className="text-sm font-bold text-slate-900">{item.title}</span>
                      {item.time ? <span className="text-xs text-slate-500">{item.time}</span> : null}
                      {item.status ? <span className="text-xs text-slate-500">· {item.status}</span> : null}
                    </div>
                    {item.isPlan ? (
                      <p className="mt-1 text-xs font-bold text-amber-800">A plan is what was intended, not a record of what was done.</p>
                    ) : null}
                    {item.details.length > 0 ? (
                      <ul className="mt-1 space-y-0.5">
                        {item.details.map((line, lineIndex) => (
                          <li className="break-words text-sm text-slate-600" key={lineIndex}>
                            {line}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>

            {record.existingCharges.length > 0 ? (
              <div className="space-y-2">
                <h3 className={LABEL}>Already deducted on this day</h3>
                <ul className="space-y-2">
                  {record.existingCharges.map((charge) => (
                    <li className="border border-l-4 border-slate-200 border-l-rose-500 px-3 py-2 text-sm" key={charge.candidateId}>
                      <span className="font-bold text-slate-900">
                        {charge.isDayReview ? "Pushed by hand from this screen" : deductionsCategoryNames[charge.category] ?? "Deduction"}
                      </span>
                      <span className="text-slate-600">
                        {" "}
                        · {charge.decisionStatus} · {money(charge.amount)} · {monthLabel(charge.monthKey)} payroll
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={phxHintClassName}>One day is charged once. Change or clear that deduction on the Deductions screen first.</p>
              </div>
            ) : null}

            {record.releasedOnDay.length > 0 ? (
              <div className="space-y-2">
                <h3 className={LABEL}>Released on this page for that day</h3>
                <ul className="space-y-2">
                  {record.releasedOnDay.map((line) => (
                    <li className="border border-l-4 border-slate-200 border-l-rose-500 px-3 py-2 text-sm" key={line.lineId}>
                      <span className="font-bold text-slate-900">{line.label}</span>
                      <span className="text-slate-600">
                        {" "}
                        · {money(line.amount)} · {line.daysCount} {line.daysCount === 1 ? "day" : "days"} on that line
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={phxHintClassName}>
                  One day is charged once. Withdraw that line under Released to employees first if this push should replace it.
                </p>
              </div>
            ) : null}

            {record.releasedUnreadable ? (
              <p className="border-l-4 border-l-amber-500 px-3 py-2 text-sm font-bold text-amber-800">
                The lines already released on this page could not be read just now, so the push stays off. Open the day again in a moment.
              </p>
            ) : null}

            {record.refusal ? (
              <p className="border-l-4 border-l-rose-500 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{record.refusal}</p>
            ) : null}

            {!blocked ? (
              <div className="space-y-4 border-t border-slate-200 pt-4">
                <div className="space-y-2">
                  <span className={LABEL}>How much of the day</span>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <CheckTile checked={fraction === 1} name="day-review-fraction" onChange={() => setFraction(1)} type="radio">
                      <span className="font-bold">1 day</span> · {money(record.price.fullDay)}
                    </CheckTile>
                    <CheckTile checked={fraction === 0.5} name="day-review-fraction" onChange={() => setFraction(0.5)} type="radio">
                      <span className="font-bold">Half a day</span> · {money(record.price.halfDay)}
                    </CheckTile>
                  </div>
                  <span className={phxHintClassName}>
                    Base salary ÷ the days of that month. Charged in the {monthLabel(record.payrollMonthKey)} payroll.
                  </span>
                </div>

                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Comment shown to the employee</span>
                  <textarea
                    className={phxTextareaClassName}
                    maxLength={COMMENT_MAX}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder="Why this day is deducted — the employee reads exactly this."
                    rows={3}
                    value={comment}
                  />
                  <span className={phxHintClassName}>
                    {commentLength} of {COMMENT_MAX} characters. It is written as under review; nothing reaches payroll until it is
                    approved.
                  </span>
                </label>

                <div className="flex flex-wrap items-center gap-3">
                  <button className={phxButtonAccentClassName} disabled={!canPush || chosenPrice == null} onClick={push} type="button">
                    {pushing ? "Pushing…" : `Push ${fraction === 0.5 ? "half a day" : "1 day"} for approval`}
                  </button>
                  {chosenPrice == null ? (
                    <span className="text-sm text-rose-700">No base salary is on record, so this day cannot be priced.</span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
