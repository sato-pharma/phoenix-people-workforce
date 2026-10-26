"use client";

import { useState, useTransition } from "react";
import { AlarmClock, CalendarDays, CheckCircle2, Clock, Download, RefreshCw, Users, UserX } from "lucide-react";

import {
  PortalEmptyState,
  PortalMetricCard,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import {
  isNoRecordDay,
  mergeNoRecordDays,
  NO_RECORD_STATUS,
  workedHoursLabel,
} from "@/lib/attendance/attendance-day-display";
import type { EmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { addDaysToDateOnly } from "@/lib/date-only";
import { utcDate } from "@/lib/format/cairo-datetime";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { adminControlDepthClassName, adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";


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
//
// Every range is built from the CAIRO calendar day, never the browser's clock: a phone set to
// another zone (or a laptop left on UTC) used to ask for the wrong month between midnight and
// 03:00, and "today" silently fell out of "This month".

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function cairoToday() {
  const today = currentCairoDateOnlyIso();
  const [year, month] = today.split("-").map(Number);
  return { month, today, year };
}

function firstDayOfMonth(year: number, month: number) {
  return `${year}-${pad(month)}-01`;
}

function lastDayOfMonth(year: number, month: number) {
  // Day 0 of the next month is the last day of this one; UTC so no zone can shift it.
  return `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}

function rangeForFilter(filter: QuickFilter, customMonth: string): { from: string; to: string } {
  const { month: m, today, year: y } = cairoToday();

  if (filter === "this-month") {
    return { from: firstDayOfMonth(y, m), to: today };
  }

  if (filter === "last-month") {
    const lm = m === 1 ? 12 : m - 1;
    const ly = m === 1 ? y - 1 : y;
    return { from: firstDayOfMonth(ly, lm), to: lastDayOfMonth(ly, lm) };
  }

  if (filter === "last-30") {
    return { from: addDaysToDateOnly(today, -30) ?? today, to: today };
  }

  // custom month — "YYYY-MM"
  if (customMonth) {
    const [cy, cm] = customMonth.split("-").map(Number);
    const isCurrentMonth = customMonth === `${y}-${pad(m)}`;
    return {
      from: firstDayOfMonth(cy, cm),
      to: isCurrentMonth ? today : lastDayOfMonth(cy, cm),
    };
  }

  return { from: today, to: today };
}

function generateMonthOptions(): Array<{ label: string; value: string }> {
  const { month, year } = cairoToday();
  const options: Array<{ label: string; value: string }> = [];
  for (let i = 0; i < 13; i++) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    options.push({
      label: d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC", year: "numeric" }),
      value: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`,
    });
  }
  return options;
}

// "27 Sept 2026" from the digits (utcDate, the platform's one date-only format) — never the
// server's MM/DD/YYYY row.date, and never the browser's own month names.
function displayDate(key: string) {
  return utcDate(key.slice(0, 10));
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "Complete")    return <Badge variant="success">Complete</Badge>;
  if (status === "Exception")   return <Badge variant="neutral">Exception</Badge>;
  if (status === "Late")        return <Badge variant="warning">Late</Badge>;
  if (status === "Early leave") return <Badge variant="warning">Early leave</Badge>;
  if (status === "Short day")   return <Badge variant="warning">Short day</Badge>;
  if (status === NO_RECORD_STATUS) return <Badge variant="neutral">{NO_RECORD_STATUS}</Badge>;
  return <Badge variant="danger">{status}</Badge>;
}

function lateMinutesOf(value: string | null | undefined) {
  const minutes = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(minutes) ? minutes : 0;
}

// ─── Shared chrome ────────────────────────────────────────────────────────────

const CARD = `border border-slate-200 bg-white ${adminPanelDepthClassName}`;
const FIELD = "px-3";

// ─── Main component ───────────────────────────────────────────────────────────

const QUICK_BUTTONS: Array<{ id: QuickFilter; label: string }> = [
  { id: "last-30",     label: "Last 30 days" },
  { id: "this-month",  label: "This month"   },
  { id: "last-month",  label: "Last month"   },
  { id: "custom",      label: "Pick a month" },
];

export function FingerprintAnalytics({ hrId, initialData, targets }: Props) {
  const [monthOptions] = useState(generateMonthOptions);

  const viewTargets: FingerprintTarget[] =
    targets && targets.length > 0 ? targets : [{ hrId, label: "My report", sublabel: "You", isSelf: true }];
  const hasReports = viewTargets.length > 1;

  const [data,         setData]         = useState<EmployeeAttendanceData>(initialData);
  // Both pages that render this load the last 30 days on the server, so that is the chip that
  // starts selected. It used to start on "This month" while the table showed the last 30 days.
  const [activeFilter, setActiveFilter] = useState<QuickFilter>("last-30");
  const [customMonth,  setCustomMonth]  = useState<string>(() => monthOptions[0]?.value ?? "");
  const [selectedHrId, setSelectedHrId] = useState<string>(hrId);
  const [fetchError,   setFetchError]   = useState<string | null>(null);
  const [isPending,    startTransition] = useTransition();

  const selectedTarget = viewTargets.find((target) => target.hrId === selectedHrId) ?? viewTargets[0];

  function fetchFor(targetHrId: string, from: string, to: string) {
    setFetchError(null);
    const url =
      `/api/attendance/employee-attendance` +
      `?hrId=${encodeURIComponent(targetHrId)}&dateFrom=${from}&dateTo=${to}&noRecordDays=1`;
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
    if (filter === "custom") {
      // Load the month already showing in the picker, so the chip never sits selected over
      // another range's data.
      const { from, to } = rangeForFilter("custom", customMonth);
      fetchRange(from, to);
      return;
    }
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

  const { summary } = data;
  // Working days with no punch at all sit in the list as "No record" rows (never "Absent", and
  // counted in no card) instead of silently missing from it.
  const rows = mergeNoRecordDays(data.rows, data.noRecordDates);
  const rangeLabel = `${displayDate(data.dateFrom)} – ${displayDate(data.dateTo)}`;

  return (
    <div className="space-y-4">

      {/* ── Whose report (managers only) ─────────────────────────────────── */}
      {hasReports && (
        <div className={`${CARD} p-4`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-900 text-orange-400">
                <Users className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">Whose report</p>
                <p className="break-words text-phx-md font-semibold text-slate-800">
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

      {/* ── Range + export ───────────────────────────────────────────────── */}
      <div className={`${CARD} p-3 sm:p-4`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Quick ranges: a 2×2 grid on a phone, one row from tablet up — never a sideways scroll. */}
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {QUICK_BUTTONS.map(({ id, label }) => {
              const active = activeFilter === id;
              return (
                <button
                  aria-pressed={active}
                  key={id}
                  onClick={() => handleQuickFilter(id)}
                  type="button"
                  disabled={isPending}
                  className={[
                    "inline-flex min-h-10 items-center justify-center gap-1.5 px-3 text-phx-sm font-bold uppercase leading-tight tracking-wide transition-colors duration-150 sm:px-4",
                    active
                      ? "bg-orange-500 text-white"
                      : `border border-slate-300 bg-white text-slate-600 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 ${adminControlDepthClassName}`,
                    isPending && !active ? "cursor-not-allowed opacity-50" : "",
                  ].join(" ")}
                >
                  {isPending && active ? <RefreshCw className="h-3 w-3 shrink-0 animate-spin" /> : null}
                  {label}
                </button>
              );
            })}
          </div>

          <a
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 border border-slate-900 bg-slate-900 px-4 text-phx-sm font-bold uppercase tracking-wide text-white transition-colors hover:border-orange-600 hover:bg-orange-600"
            href={exportHref}
            data-no-print
          >
            <Download className="h-3.5 w-3.5 shrink-0" />
            Download Excel
          </a>
        </div>

        {activeFilter === "custom" && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <label className="block max-w-xs space-y-1.5">
              <span className="block text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-400">Month</span>
              <SearchableSelect
                className={`${FIELD} w-full`}
                onChange={(e) => handleCustomMonth(e.target.value)}
                value={customMonth}
              >
                {monthOptions.map(({ label, value }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </SearchableSelect>
            </label>
          </div>
        )}

        {fetchError && (
          <p className="mt-3 border border-rose-200 bg-rose-50 px-3 py-2 text-phx-sm font-semibold text-rose-700">
            {fetchError}
          </p>
        )}
      </div>

      {/* ── Results (dims while a new range loads) ───────────────────────── */}
      <div
        aria-busy={isPending}
        className={`space-y-4 transition-opacity duration-200 ${isPending ? "opacity-60" : "opacity-100"}`}
      >
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <PortalMetricCard accent="slate" icon={CalendarDays} label="Days recorded" value={summary.totalRows} />
          <PortalMetricCard accent="emerald" icon={CheckCircle2} label="Complete" value={summary.completeDays} />
          <PortalMetricCard accent="amber" icon={AlarmClock} label="Late / early" value={summary.lateOrEarlyDays ?? summary.lateDays} />
          <PortalMetricCard accent="rose" icon={UserX} label="Short / absent" value={summary.shortDays + summary.absentDays} />
        </div>

        <PortalSection
          actions={
            <span className="bg-slate-900 px-2.5 py-1 text-phx-xs font-bold uppercase tracking-wide text-slate-100 tabular-nums">
              {rows.length} {rows.length === 1 ? "day" : "days"}
            </span>
          }
          eyebrow="Fingerprint log"
          title={rangeLabel}
        >
          {rows.length === 0 ? (
            <PortalEmptyState
              message="Nothing was recorded in this range. Pick another range above."
              title="No punches in this range"
            />
          ) : (
            <>
              {/* Phone: one card per day. */}
              <div className="divide-y divide-slate-100 md:hidden">
                {rows.map((row) => {
                  if (isNoRecordDay(row)) {
                    return (
                      <div className="px-4 py-3" key={row.rawDate}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-phx-md font-bold tabular-nums text-slate-500">{displayDate(row.rawDate)}</span>
                          <StatusBadge status={NO_RECORD_STATUS} />
                        </div>
                      </div>
                    );
                  }
                  const lateMin = lateMinutesOf(row.lateMinutes);
                  return (
                    <div className="px-4 py-3" key={row.rawDate}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-phx-md font-bold tabular-nums text-slate-900">{displayDate(row.rawDate)}</span>
                        <StatusBadge status={row.status} />
                      </div>
                      <dl className="mt-2.5 grid grid-cols-3 gap-2">
                        <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">In</dt>
                          <dd className="mt-0.5 text-phx-md font-bold tabular-nums text-slate-800">{row.firstPunch || "—"}</dd>
                        </div>
                        <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Out</dt>
                          <dd className="mt-0.5 text-phx-md font-bold tabular-nums text-slate-800">{row.lastPunch || "—"}</dd>
                        </div>
                        <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2">
                          <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Hours</dt>
                          <dd className="mt-0.5 text-phx-md font-bold tabular-nums text-slate-800">{workedHoursLabel(row.timeLong) || "—"}</dd>
                        </div>
                      </dl>
                      {lateMin > 0 && (
                        <p className="mt-2 text-phx-sm font-bold tabular-nums text-amber-700">{lateMin} min late</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Tablet and desktop: fixed layout and a colgroup, so the table fits its column at
                  every width — no min-width and no sideways scroll (the fits-the-screen rule). */}
              <div className="hidden md:block">
                <table className="w-full table-fixed text-left text-phx-md">
                  <colgroup>
                    <col className="w-[24%]" />
                    <col className="w-[22%]" />
                    <col className="w-[14%]" />
                    <col className="w-[16%]" />
                    <col className="w-[24%]" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="px-3 py-2.5">Date</th>
                      <th className="px-3 py-2.5">In · Out</th>
                      <th className="px-3 py-2.5">Hours</th>
                      <th className="px-3 py-2.5">Late</th>
                      <th className="px-3 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((row) => {
                      if (isNoRecordDay(row)) {
                        return (
                          <tr className="bg-white" key={row.rawDate}>
                            <td className="px-3 py-2.5 font-bold tabular-nums text-slate-500">{displayDate(row.rawDate)}</td>
                            <td className="px-3 py-2.5 text-slate-400">—</td>
                            <td className="px-3 py-2.5 text-slate-400">—</td>
                            <td className="px-3 py-2.5 text-slate-400">—</td>
                            <td className="px-3 py-2.5"><StatusBadge status={NO_RECORD_STATUS} /></td>
                          </tr>
                        );
                      }
                      const lateMin = lateMinutesOf(row.lateMinutes);
                      return (
                        <tr className="bg-white transition hover:bg-orange-50/30" key={row.rawDate}>
                          <td className="px-3 py-2.5 font-bold tabular-nums text-slate-900">{displayDate(row.rawDate)}</td>
                          <td className="px-3 py-2.5 tabular-nums text-slate-700">
                            {row.firstPunch || row.lastPunch ? (
                              <span className="flex flex-wrap items-center gap-x-1">
                                <Clock className="h-3 w-3 shrink-0 text-slate-400" />
                                {row.firstPunch || "—"}
                                <span className="text-slate-400">·</span>
                                {row.lastPunch || "—"}
                              </span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums text-slate-700">{workedHoursLabel(row.timeLong) || "—"}</td>
                          <td className="px-3 py-2.5 tabular-nums">
                            {lateMin > 0 ? (
                              <span className="font-bold text-amber-700">{lateMin} min</span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2.5"><StatusBadge status={row.status} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </PortalSection>
      </div>
    </div>
  );
}
