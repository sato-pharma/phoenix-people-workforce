"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  HeadOfficeAttendanceCalendarResult,
  HeadOfficeDayCell,
  HeadOfficeDayStatus,
} from "@/lib/field-workforce-compliance/head-office-attendance";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type ApiResponse = {
  data?: HeadOfficeAttendanceCalendarResult;
  error?: string;
  message?: string;
  success: boolean;
};

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// DATE-ONLY (a calendar day, a `date` column), which `new Date` parses as UTC midnight. UTC here is
// CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not an
// instant — do not "fix" this one to Cairo.
function weekday(dateIso: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${dateIso}T00:00:00Z`));
}

function shiftMonth(month: number, year: number, delta: number): { month: number; year: number } {
  const zeroBased = month - 1 + delta;
  const nextYear = year + Math.floor(zeroBased / 12);
  const nextMonth = ((zeroBased % 12) + 12) % 12;
  return { month: nextMonth + 1, year: nextYear };
}

const STATUS_CLASS: Record<HeadOfficeDayStatus, string> = {
  blank: "border-slate-200 bg-white text-slate-400",
  exception: "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100",
  holiday: "border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-300",
  missing: "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100",
  present: "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
  weekly_off: "border-slate-200 bg-slate-100 text-slate-500",
};

const STATUS_LETTER: Record<HeadOfficeDayStatus, string> = {
  blank: "-",
  exception: "E",
  holiday: "H",
  missing: "M",
  present: "P",
  weekly_off: "O",
};

function cellTooltip(cell: HeadOfficeDayCell): string {
  if (cell.status === "present") {
    const range = cell.firstPunchTime && cell.lastPunchTime ? `${cell.firstPunchTime}–${cell.lastPunchTime}` : cell.firstPunchTime ?? "";
    return `Punched in${range ? ` (${range})` : ""} — click to open the attendance passport`;
  }
  if (cell.status === "missing") return "Expected working day, no fingerprint punch recorded — click to open the attendance passport";
  if (cell.status === "exception") return "Approved leave / attendance exception this day";
  if (cell.status === "holiday") return cell.holidayName ? `Public holiday: ${cell.holidayName}` : "Public holiday";
  if (cell.status === "weekly_off") return "Weekly off";
  return "Not yet occurred";
}

function HeadOfficeDayCellView({ cell, hrId }: { cell: HeadOfficeDayCell; hrId: string }) {
  const baseClass = cn(
    "relative flex h-10 w-full items-center justify-center rounded-lg border text-xs font-black",
    STATUS_CLASS[cell.status],
  );
  const tooltip = cellTooltip(cell);
  if (cell.status === "present" || cell.status === "missing") {
    return (
      <Link
        aria-label={`${hrId} ${cell.dateIso}: ${tooltip}`}
        className={cn(baseClass, "transition hover:ring-2 hover:ring-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-300")}
        href={`/admin/attendance/passport/${encodeURIComponent(hrId)}`}
        title={tooltip}
      >
        {STATUS_LETTER[cell.status]}
      </Link>
    );
  }
  return (
    <div aria-label={`${hrId} ${cell.dateIso}: ${tooltip}`} className={baseClass} title={tooltip}>
      {STATUS_LETTER[cell.status]}
    </div>
  );
}

function LegendChip({ children, className, label }: { children: string; className: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
      <span className={cn("inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-phx-xs font-black", className)}>
        {children}
      </span>
      {label}
    </div>
  );
}

function HeadOfficeLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      <LegendChip className={STATUS_CLASS.present} label="Punched in (click to open passport)">P</LegendChip>
      <LegendChip className={STATUS_CLASS.missing} label="Expected but no punch (click to open passport)">M</LegendChip>
      <LegendChip className={STATUS_CLASS.exception} label="Approved leave / exception">E</LegendChip>
      <LegendChip className={STATUS_CLASS.weekly_off} label="Weekly off">O</LegendChip>
      <LegendChip className={STATUS_CLASS.holiday} label="Public holiday">H</LegendChip>
    </div>
  );
}

function EmployeeAttendanceRow({ employee }: { employee: HeadOfficeAttendanceCalendarResult["employees"][number] }) {
  const monthColumns = { gridTemplateColumns: `repeat(${employee.timeline.length}, minmax(0, 1fr))` };
  return (
    <Card className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
        <div>
          <p className="text-sm font-black text-slate-950">{employee.employeeName}</p>
          <p className="mt-1 text-xs font-bold text-slate-500">
            {[employee.jobTitle, employee.departmentName || employee.lineName].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-3 text-phx-xs font-bold">
          <span className="text-emerald-700">{employee.presentDays} punched</span>
          <span className="text-rose-700">{employee.missingDays} missing</span>
        </div>
      </div>
      <div className="p-3">
        <div className="grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <div
              className={cn(
                "rounded-md py-1 text-center text-phx-3xs font-black uppercase tracking-tight text-slate-500",
                cell.status === "weekly_off" ? "bg-slate-100" : "",
                cell.status === "holiday" ? "bg-amber-50 text-amber-700" : "",
              )}
              key={`${cell.dateIso}-header`}
            >
              <span className="block text-phx-xs leading-tight text-slate-900">{cell.dayNumber}</span>
              <span>{weekday(cell.dateIso)}</span>
            </div>
          ))}
        </div>
        <div className="mt-1 grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <HeadOfficeDayCellView cell={cell} hrId={employee.hrId} key={cell.dateIso} />
          ))}
        </div>
      </div>
    </Card>
  );
}

/**
 * Office attendance for device-mapped, non-field-force employees ("Head Office" staff), built
 * from the physical fingerprint system rather than CRM visits. Fully self-contained (own
 * month/year state + fetch) since this population and data source are disjoint from the
 * visit-driven Field Workforce Compliance preview the rest of this workspace is built around.
 */
export function HeadOfficeAttendancePanel() {
  const today = new Date();
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [year, setYear] = useState(today.getFullYear());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HeadOfficeAttendanceCalendarResult | null>(null);

  useEffect(() => {
    let active = true;

    async function loadHeadOfficeAttendance() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/admin/field-workforce-compliance/head-office-attendance?month=${month}&year=${year}`);
        const payload = (await response.json()) as ApiResponse;
        if (!active) return;
        if (payload.success && payload.data) setResult(payload.data);
        else setError(payload.message ?? payload.error ?? "Head Office attendance could not be loaded.");
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Head Office attendance could not be loaded.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadHeadOfficeAttendance();
    return () => {
      active = false;
    };
  }, [month, year]);

  const employees = useMemo(() => result?.employees ?? [], [result]);
  const holidayCalendarReachable = result?.holidayCalendarReachable ?? true;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return employees;
    return employees.filter((employee) => `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle));
  }, [employees, query]);

  function goToMonth(delta: number) {
    const next = shiftMonth(month, year, delta);
    setMonth(next.month);
    setYear(next.year);
  }

  return (
    <div className="space-y-4">
      <Card className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-black text-slate-950">Head Office Attendance — {MONTH_LABELS[month - 1]} {year}</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Fingerprint-based office attendance for device-mapped staff outside the field force. Click a punched or
              missing day to open that employee&apos;s attendance passport.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              aria-label="Previous month"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700"
              onClick={() => goToMonth(-1)}
              type="button"
            >
              &lsaquo;
            </button>
            <span className="min-w-[140px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-center text-xs font-black text-slate-700">
              {MONTH_LABELS[month - 1]} {year}
            </span>
            <button
              aria-label="Next month"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700"
              onClick={() => goToMonth(1)}
              type="button"
            >
              &rsaquo;
            </button>
          </div>
        </div>
        <input
          className={`${phxFieldClassName} mt-3 sm:max-w-xs`}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search employee or HR ID"
          value={query}
        />
      </Card>

      <HeadOfficeLegend />

      {holidayCalendarReachable ? null : (
        <Card className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          The public holiday calendar could not be read for this month. Company and fixed-date public holidays still apply,
          but the moving Islamic and Coptic holidays — both Eids, Islamic New Year, the Prophet&apos;s Birthday and Coptic
          Easter — are missing, so such a day shows below as a missing day rather than a holiday.
        </Card>
      )}

      {loading ? (
        <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">Loading Head Office attendance…</Card>
      ) : error ? (
        <Card className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm font-semibold text-rose-700">{error}</Card>
      ) : filtered.length === 0 ? (
        <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No device-mapped Head Office employees matched this month{query ? " and search" : ""}. Employees are enrolled via
          Attendance &rarr; Device/User Mapping.
        </Card>
      ) : (
        <>
          <p className="text-xs font-bold text-slate-500">Showing {filtered.length} of {employees.length} people</p>
          <div className="space-y-3">
            {filtered.map((employee) => (
              <EmployeeAttendanceRow employee={employee} key={employee.hrId} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
