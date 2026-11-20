"use client";

import { useState, useTransition } from "react";
import { Clock, Download, RefreshCw } from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import {
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingPanel,
  LandingRailLine,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
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
import { phxLabelClassName } from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


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

// ─── Status word ──────────────────────────────────────────────────────────────
//
// The landing kit's status rule: a day's status is a coloured word, never a filled pill.

function statusInk(status: string) {
  if (status === "Complete") return "text-emerald-700";
  if (status === "Exception") return "text-slate-600";
  if (status === "Late" || status === "Early leave" || status === "Short day") return "text-amber-700";
  if (status === NO_RECORD_STATUS) return "text-slate-500";
  return "text-rose-700";
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`break-words text-phx-xs font-bold uppercase tracking-[0.08em] ${statusInk(status)}`}>{status}</span>
  );
}

/** One figure on the page's navy board: a colour swatch beside the label, the count white and tabular. */
function FingerprintFigure({ label, swatch, value }: { label: string; swatch?: string; value: number }) {
  return (
    <div className={`min-w-0 px-3 py-2.5 ${LANDING_NAVY_TILE}`}>
      <p className="flex items-center gap-1.5">
        {swatch ? <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 ${swatch}`} /> : null}
        <span className="min-w-0 break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-white/60">{label}</span>
      </p>
      <div className="mt-1.5">
        <LandingFigure onNavy>{value}</LandingFigure>
      </div>
    </div>
  );
}

function lateMinutesOf(value: string | null | undefined) {
  const minutes = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(minutes) ? minutes : 0;
}

// ─── Shared chrome ────────────────────────────────────────────────────────────

const CARD = `border border-slate-200 bg-white ${adminSoftDepthClassName}`;

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
        <LandingPanel bodyClassName="p-3 sm:p-4" title="Whose report">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className={`min-w-0 break-words text-phx-md font-semibold ${LANDING_INK}`} dir="auto">
              {selectedTarget?.isSelf
                ? "Your own attendance"
                : `${selectedTarget?.label}${selectedTarget?.sublabel ? ` · ${selectedTarget.sublabel}` : ""}`}
            </p>
            <SearchableSelect
              className="w-full sm:w-72"
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
        </LandingPanel>
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
                    landingActionClassName(active ? "solid" : "outline", "min-h-10 leading-tight sm:min-h-10 sm:px-4"),
                    isPending && !active ? "cursor-not-allowed opacity-50" : "",
                  ].join(" ")}
                >
                  {isPending && active ? <RefreshCw aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
                  {label}
                </button>
              );
            })}
          </div>

          <a
            className={landingActionClassName("outline", "min-h-10 px-4 sm:min-h-10")}
            href={exportHref}
            data-no-print
          >
            <Download aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Download Excel
          </a>
        </div>

        {activeFilter === "custom" && (
          <div className="mt-3 border-t border-slate-200 pt-3">
            <label className="block max-w-xs">
              <span className={phxLabelClassName}>Month</span>
              <SearchableSelect
                className="w-full"
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
          <div className="-mx-3 -mb-3 mt-3 border-t border-slate-200 sm:-mx-4 sm:-mb-4">
            <LandingRailLine rail="bg-rose-600">{fetchError}</LandingRailLine>
          </div>
        )}
      </div>

      {/* ── Results (dims while a new range loads) ───────────────────────── */}
      <div
        aria-busy={isPending}
        className={`space-y-4 transition-opacity duration-200 motion-reduce:transition-none ${isPending ? "opacity-60" : "opacity-100"}`}
      >
        <LandingNavyBoard label="Key figures">
          <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
            <FingerprintFigure label="Days recorded" value={summary.totalRows} />
            <FingerprintFigure label="Complete" swatch="bg-emerald-400" value={summary.completeDays} />
            <FingerprintFigure swatch="bg-amber-400" label="Late / early" value={summary.lateOrEarlyDays ?? summary.lateDays} />
            <FingerprintFigure label="Short / absent" swatch="bg-rose-400" value={summary.shortDays + summary.absentDays} />
          </div>
        </LandingNavyBoard>

        <LandingPanel
          right={<LandingMeta items={[rangeLabel, `${rows.length} ${rows.length === 1 ? "day" : "days"}`]} />}
          title="Fingerprint log"
        >
          {rows.length === 0 ? (
            <PortalEmptyState
              message="Nothing was recorded in this range. Pick another range above."
              title="No punches in this range"
            />
          ) : (
            <>
              {/* Phone: one card per day. */}
              <div className="divide-y divide-slate-200 md:hidden">
                {rows.map((row) => {
                  if (isNoRecordDay(row)) {
                    return (
                      <div className="px-3 py-3 sm:px-4" key={row.rawDate}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-phx-md font-bold tabular-nums text-slate-500">{displayDate(row.rawDate)}</span>
                          <StatusBadge status={NO_RECORD_STATUS} />
                        </div>
                      </div>
                    );
                  }
                  const lateMin = lateMinutesOf(row.lateMinutes);
                  return (
                    <div className="px-3 py-3 sm:px-4" key={row.rawDate}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{displayDate(row.rawDate)}</span>
                        <StatusBadge status={row.status} />
                      </div>
                      <dl className="mt-2.5 grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200">
                        <div className="min-w-0 px-2 py-1.5">
                          <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">In</dt>
                          <dd className={`mt-0.5 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{row.firstPunch || "—"}</dd>
                        </div>
                        <div className="min-w-0 px-2 py-1.5">
                          <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Out</dt>
                          <dd className={`mt-0.5 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{row.lastPunch || "—"}</dd>
                        </div>
                        <div className="min-w-0 px-2 py-1.5">
                          <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Hours</dt>
                          <dd className={`mt-0.5 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{workedHoursLabel(row.timeLong) || "—"}</dd>
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
                  <thead className="border-b border-slate-200 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                    <tr>
                      <th className="px-3 py-2.5">Date</th>
                      <th className="px-3 py-2.5">In · Out</th>
                      <th className="px-3 py-2.5">Hours</th>
                      <th className="px-3 py-2.5">Late</th>
                      <th className="px-3 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
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
                        <tr className="bg-white transition-colors hover:bg-slate-50 motion-reduce:transition-none" key={row.rawDate}>
                          <td className={`px-3 py-2.5 font-bold tabular-nums ${LANDING_INK}`}>{displayDate(row.rawDate)}</td>
                          <td className="px-3 py-2.5 tabular-nums text-slate-700">
                            {row.firstPunch || row.lastPunch ? (
                              <span className="flex flex-wrap items-center gap-x-1">
                                <Clock aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-400" />
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
        </LandingPanel>
      </div>
    </div>
  );
}
