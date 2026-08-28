"use client";

import { useState, useTransition } from "react";
import { Clock, Download, Fingerprint, LogIn, LogOut, RefreshCw, ScanLine, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { EmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { SearchableSelect } from "@/components/ui/searchable-select";


// ─── Types ──────────────────────────────────────────────────────────────────

export type FingerprintTarget = {
  hrId: string;
  label: string;
  sublabel?: string;
  isSelf: boolean;
};

type Props = {
  hrId: string;
  initialData: EmployeeAttendanceData;
  /** Selectable reports: always self first, then any direct reports a manager may view. */
  targets?: FingerprintTarget[];
};

type QuickFilter = "this-month" | "last-month" | "last-30" | "custom";

// ─── Date helpers ─────────────────────────────────────────────────────────────

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function firstDayOfMonth(year: number, month: number) {
  return `${year}-${pad(month)}-01`;
}

function lastDayOfMonth(year: number, month: number) {
  const d = new Date(year, month, 0); // day 0 of next month = last day of this month
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rangeForFilter(filter: QuickFilter, customMonth: string): { from: string; to: string } {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1; // 1-based

  if (filter === "this-month") {
    return { from: firstDayOfMonth(y, m), to: todayKey() };
  }

  if (filter === "last-month") {
    const lm = m === 1 ? 12 : m - 1;
    const ly = m === 1 ? y - 1 : y;
    return { from: firstDayOfMonth(ly, lm), to: lastDayOfMonth(ly, lm) };
  }

  if (filter === "last-30") {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return { from: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, to: todayKey() };
  }

  // custom month — "YYYY-MM"
  if (customMonth) {
    const [cy, cm] = customMonth.split("-").map(Number);
    const currentMonthKey = `${y}-${pad(m)}`;
    const isCurrentMonth = customMonth === currentMonthKey;
    return {
      from: firstDayOfMonth(cy, cm),
      to: isCurrentMonth ? todayKey() : lastDayOfMonth(cy, cm),
    };
  }

  return { from: todayKey(), to: todayKey() };
}

function generateMonthOptions(): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [];
  const today = new Date();
  for (let i = 0; i < 13; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    options.push({
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`,
    });
  }
  return options;
}

function displayDate(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// ─── KPI tile — flat corporate (square, crisp, black/orange) ──────────────────

type Accent = "amber" | "green" | "orange" | "red" | "slate";

const TONE: Record<Accent, { bar: string; value: string }> = {
  amber:  { bar: "bg-amber-500",   value: "text-amber-600"   },
  green:  { bar: "bg-emerald-500", value: "text-emerald-600" },
  orange: { bar: "bg-orange-500",  value: "text-orange-600"  },
  red:    { bar: "bg-rose-500",    value: "text-rose-600"    },
  slate:  { bar: "bg-slate-800",   value: "text-slate-900"   },
};

function KpiCard({ accent, label, note, value }: { accent: Accent; label: string; note: string; value: number }) {
  const { bar, value: valueColor } = TONE[accent];
  return (
    <div className="group relative min-h-[124px] overflow-hidden border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-colors duration-200 hover:border-orange-300">
      <div className={`absolute inset-x-0 top-0 h-[3px] ${bar}`} />
      <div className="flex h-full flex-col justify-between gap-4 p-5">
        <div className="flex items-center gap-2">
          <span className={`h-1.5 w-1.5 ${bar}`} />
          <p className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
        </div>
        <div>
          <p className={`text-[28px] font-black leading-none tracking-tight tabular-nums ${valueColor}`}>{value}</p>
          <p className="mt-2 text-phx-xs font-semibold text-slate-400">{note}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "Complete")    return <Badge variant="success">Complete</Badge>;
  if (status === "Exception")   return <Badge variant="neutral">Exception</Badge>;
  if (status === "Late")        return <Badge variant="warning">Late</Badge>;
  if (status === "Early leave") return <Badge variant="warning">Early leave</Badge>;
  if (status === "Short day")   return <Badge variant="warning">Short day</Badge>;
  return <Badge variant="danger">{status}</Badge>;
}

// ─── Shared chrome ────────────────────────────────────────────────────────────

const CARD = "border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
const FIELD =
  "h-10 border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100";

// ─── Main component ───────────────────────────────────────────────────────────

const QUICK_BUTTONS: Array<{ id: QuickFilter; label: string }> = [
  { id: "this-month",  label: "This Month"  },
  { id: "last-month",  label: "Last Month"  },
  { id: "last-30",     label: "Last 30 Days" },
  { id: "custom",      label: "Custom"      },
];

const MONTH_OPTIONS = generateMonthOptions();

export function FingerprintAnalytics({ hrId, initialData, targets }: Props) {
  const today = new Date();
  const currentMonthValue = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;

  const viewTargets: FingerprintTarget[] =
    targets && targets.length > 0 ? targets : [{ hrId, label: "My report", sublabel: "You", isSelf: true }];
  const hasReports = viewTargets.length > 1;

  const [data,         setData]         = useState<EmployeeAttendanceData>(initialData);
  const [activeFilter, setActiveFilter] = useState<QuickFilter>("this-month");
  const [customMonth,  setCustomMonth]  = useState<string>(currentMonthValue);
  const [selectedHrId, setSelectedHrId] = useState<string>(hrId);
  const [fetchError,   setFetchError]   = useState<string | null>(null);
  const [isPending,    startTransition] = useTransition();

  const selectedTarget = viewTargets.find((target) => target.hrId === selectedHrId) ?? viewTargets[0];

  function fetchFor(targetHrId: string, from: string, to: string) {
    setFetchError(null);
    const url =
      `/api/attendance/employee-attendance` +
      `?hrId=${encodeURIComponent(targetHrId)}&dateFrom=${from}&dateTo=${to}`;
    startTransition(async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setFetchError((body as { message?: string }).message ?? "Failed to load records.");
          return;
        }
        setData(await res.json());
      } catch {
        setFetchError("Network error — please try again.");
      }
    });
  }

  function fetchRange(from: string, to: string) {
    fetchFor(selectedHrId, from, to);
  }

  function handleQuickFilter(filter: QuickFilter) {
    setActiveFilter(filter);
    if (filter === "custom") return; // wait for month select
    const { from, to } = rangeForFilter(filter, "");
    fetchRange(from, to);
  }

  function handleCustomMonth(month: string) {
    setCustomMonth(month);
    const { from, to } = rangeForFilter("custom", month);
    fetchRange(from, to);
  }

  function handleTargetChange(nextHrId: string) {
    setSelectedHrId(nextHrId);
    // Keep the currently shown date window when switching whose report we view.
    fetchFor(nextHrId, data.dateFrom, data.dateTo);
  }

  const exportHref =
    `/api/attendance/employee-fingerprint-export` +
    `?hrId=${encodeURIComponent(selectedHrId)}&dateFrom=${data.dateFrom}&dateTo=${data.dateTo}`;

  const { summary, rows } = data;

  return (
    <div className="space-y-5">

      {/* ── Whose report (managers only) ─────────────────────────────────── */}
      {hasReports && (
        <div className={`overflow-hidden ${CARD} p-4`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-900 text-orange-400">
                <Users className="h-4 w-4" />
              </span>
              <div>
                <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">Whose Report</p>
                <p className="text-phx-md font-semibold text-slate-800">
                  {selectedTarget?.isSelf
                    ? "Your own attendance"
                    : `${selectedTarget?.label}${selectedTarget?.sublabel ? ` · ${selectedTarget.sublabel}` : ""}`}
                </p>
              </div>
            </div>
            <SearchableSelect
              className={`${FIELD} w-full sm:w-72`}
              onChange={(e) => handleTargetChange(e.target.value)}
              value={selectedHrId}
            >
              {viewTargets.map((target) => (
                <option key={target.hrId} value={target.hrId}>
                  {target.isSelf ? "My report" : `${target.label}${target.sublabel ? ` — ${target.sublabel}` : ""}`}
                </option>
              ))}
            </SearchableSelect>
          </div>
        </div>
      )}

      {/* ── Filter strip ─────────────────────────────────────────────────── */}
      <div className={`overflow-hidden ${CARD} p-4`}>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">

          {/* Quick-filter buttons */}
          <div className="flex flex-wrap gap-2">
            {QUICK_BUTTONS.map(({ id, label }) => {
              const active = activeFilter === id;
              return (
                <button
                  key={id}
                  onClick={() => handleQuickFilter(id)}
                  type="button"
                  disabled={isPending}
                  className={[
                    "inline-flex h-9 items-center gap-1.5 px-4 text-phx-sm font-bold uppercase tracking-wide transition-colors duration-150",
                    active
                      ? "bg-orange-500 text-white"
                      : "border border-slate-300 bg-white text-slate-600 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700",
                    isPending && !active ? "opacity-50 cursor-not-allowed" : "",
                  ].join(" ")}
                >
                  {isPending && active ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                  {label}
                </button>
              );
            })}
          </div>

          {/* Export button */}
          <a
            className="inline-flex h-9 shrink-0 items-center gap-1.5 border border-slate-300 bg-white px-4 text-phx-sm font-bold uppercase tracking-wide text-slate-600 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
            href={exportHref}
            data-no-print
          >
            <Download className="h-3.5 w-3.5" />
            Export XLSX
          </a>
        </div>

        {/* Custom month picker — only visible when "Custom" is active */}
        {activeFilter === "custom" && (
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
            <div className="space-y-1.5">
              <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">Select Month</p>
              <SearchableSelect
                className={FIELD}
                onChange={(e) => handleCustomMonth(e.target.value)}
                value={customMonth}
              >
                {MONTH_OPTIONS.map(({ label, value }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </SearchableSelect>
            </div>
            <p className="pb-2.5 text-xs font-semibold text-slate-400">
              Showing {displayDate(data.dateFrom)} → {displayDate(data.dateTo)}
            </p>
          </div>
        )}

        {fetchError && (
          <p className="mt-3 border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
            {fetchError}
          </p>
        )}
      </div>

      {/* ── Results (dims while a new range loads) ───────────────────────── */}
      <div
        aria-busy={isPending}
        className={`space-y-5 transition-opacity duration-200 ${isPending ? "opacity-60" : "opacity-100"}`}
      >

        {/* ── KPI tiles ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:gap-4">
          <KpiCard accent="slate"  label="Total Recorded" value={summary.totalRows}                      note="Days in range"     />
          <KpiCard accent="green"  label="Complete"        value={summary.completeDays}                   note="Full working days" />
          <KpiCard accent="amber"  label="Late / Early"    value={summary.lateDays}                       note="Attendance flags"  />
          <KpiCard accent="orange" label="Short / Absent"  value={summary.shortDays + summary.absentDays} note="Below threshold"   />
        </div>

        {/* ── Punch log ─────────────────────────────────────────────────── */}
        {rows.length === 0 ? (
          <div className={`flex flex-col items-center justify-center ${CARD} py-20 text-center`}>
            <span className="flex h-12 w-12 items-center justify-center bg-slate-900 text-orange-400">
              <ScanLine className="h-6 w-6" />
            </span>
            <p className="mt-4 text-sm font-bold text-slate-700">No records for this period</p>
            <p className="mt-1 text-xs text-slate-400">Try a different time range above.</p>
          </div>
        ) : (
          <div className={`overflow-hidden ${CARD}`}>

            {/* section header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-900 text-orange-400">
                  <Fingerprint className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-phx-2xs font-black uppercase tracking-[0.20em] text-orange-500">Fingerprint Log</p>
                  <p className="mt-0.5 text-phx-md font-semibold text-slate-800 tabular-nums">
                    {displayDate(data.dateFrom)} → {displayDate(data.dateTo)}
                  </p>
                </div>
              </div>
              <span className="bg-slate-900 px-2.5 py-1 text-phx-xs font-bold uppercase tracking-wide text-slate-100 tabular-nums">
                {rows.length} {rows.length === 1 ? "record" : "records"}
              </span>
            </div>

            {/* Mobile: premium card list (tables are desktop-only) */}
            <div className="space-y-2.5 p-3 md:hidden">
              {rows.map((row) => {
                const lateMin = parseInt(row.lateMinutes ?? "0", 10);
                return (
                  <div className="border border-slate-200 bg-white p-3" key={row.rawDate}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-slate-800">{row.date}</span>
                      <StatusBadge status={row.status} />
                    </div>
                    <dl className="mt-2.5 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <dt className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">In</dt>
                        <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-700">{row.firstPunch || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">Out</dt>
                        <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-700">{row.lastPunch || "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">Duration</dt>
                        <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-700">{row.timeLong || "—"}</dd>
                      </div>
                    </dl>
                    {lateMin > 0 && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="inline-flex bg-amber-100 px-2.5 py-0.5 text-phx-xs font-bold text-amber-800 tabular-nums">
                          +{lateMin} min late
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop: full table */}
            <div className="hidden overflow-x-auto md:block">
              {(() => {
                const baseCols = ["Date", "Clock In", "Clock Out", "Duration", "Late", "Status"] as const;
                return (
                  <table className="w-full text-sm">
                    <thead>
                      <tr>
                        {baseCols.map((col) => (
                          <th key={col} className="px-4 py-3 font-black uppercase tracking-[0.14em]">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody>
                      {rows.map((row, i) => {
                        const lateMin = parseInt(row.lateMinutes ?? "0", 10);
                        return (
                          <tr
                            key={row.rawDate}
                            className={`transition-colors duration-150 hover:bg-orange-50/60 ${i % 2 === 0 ? "bg-white" : "bg-slate-50/50"}`}
                          >
                            <td className="px-4 py-3 text-center font-mono text-xs font-bold text-slate-800">
                              {row.date}
                            </td>

                            <td className="px-4 py-3 text-center">
                              {row.firstPunch ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <LogIn className="h-3 w-3 shrink-0 text-emerald-500" />
                                  <span className="font-mono text-xs font-semibold text-slate-700">{row.firstPunch}</span>
                                </span>
                              ) : (
                                <span className="text-xs text-slate-300">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center">
                              {row.lastPunch ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <LogOut className="h-3 w-3 shrink-0 text-slate-400" />
                                  <span className="font-mono text-xs font-semibold text-slate-700">{row.lastPunch}</span>
                                </span>
                              ) : (
                                <span className="text-xs text-slate-300">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center">
                              {row.timeLong ? (
                                <span className="inline-flex items-center gap-1.5 bg-slate-100 px-2 py-0.5">
                                  <Clock className="h-3 w-3 text-slate-400" />
                                  <span className="font-mono text-xs font-bold text-slate-700">{row.timeLong}</span>
                                </span>
                              ) : (
                                <span className="text-xs text-slate-300">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center">
                              {lateMin > 0 ? (
                                <span className="inline-flex bg-amber-100 px-2.5 py-0.5 text-phx-xs font-bold text-amber-800 tabular-nums">
                                  +{lateMin} min
                                </span>
                              ) : (
                                <span className="text-xs text-slate-300">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center">
                              <StatusBadge status={row.status} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
