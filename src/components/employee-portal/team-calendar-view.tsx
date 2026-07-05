"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import type {
  FieldWorkforceCellStatus,
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeSummary,
} from "@/lib/field-workforce-compliance/types";
import { cn } from "@/lib/utils";

type TeamCalendarViewProps = {
  employees: FieldWorkforceEmployeeSummary[];
  lineName: string | null;
  month: number;
  monthLabel: string | null;
  year: number;
};

function weekday(dateIso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${dateIso}T00:00:00Z`));
}

function statusLabel(status: FieldWorkforceCellStatus, visitCount?: number) {
  if (status === "VISITS") return String(visitCount ?? 0);
  if (status === "BLANK") return "-";
  return status;
}

/** Same status palette as the admin Field Workforce Compliance timeline. */
function statusCellClass(cell: FieldWorkforceDayCell) {
  const base = {
    AV: "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100",
    BLANK: "border-slate-200 bg-white text-slate-400 hover:bg-slate-50",
    CP: "border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100",
    F: "border-slate-200 bg-slate-100 text-slate-500 hover:bg-slate-200",
    N: "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100",
    UNKNOWN: "border-red-400 bg-red-50 text-red-800 hover:bg-red-100",
    VISITS: "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
  }[cell.status];
  return cn(
    base,
    cell.isPublicHoliday ? "ring-2 ring-amber-300 ring-offset-1" : "",
    cell.isPreHire ? "opacity-45 grayscale" : "",
  );
}

function LegendChip({ children, className, label }: { children: string; className: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
      <span className={cn("inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-[11px] font-black", className)}>
        {children}
      </span>
      {label}
    </div>
  );
}

function TimelineLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      <LegendChip className="border-rose-300 bg-rose-50 text-rose-800" label="No activity">N</LegendChip>
      <LegendChip className="border-sky-300 bg-sky-50 text-sky-800" label="Vacation">AV</LegendChip>
      <LegendChip className="border-violet-300 bg-violet-50 text-violet-800" label="Campaign / meeting">CP</LegendChip>
      <LegendChip className="border-emerald-300 bg-emerald-50 text-emerald-800" label="Visits (click to open)">5</LegendChip>
      <LegendChip className="border-slate-200 bg-slate-100 text-slate-500" label="Friday">F</LegendChip>
      <LegendChip className="border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-300" label="Holiday">H</LegendChip>
    </div>
  );
}

function TeamCalendarDayCell({ cell }: { cell: FieldWorkforceDayCell }) {
  const baseClass = cn(
    "relative flex h-10 w-full items-center justify-center rounded-lg border text-xs font-black",
    statusCellClass(cell),
  );
  const content = (
    <>
      {statusLabel(cell.status, cell.visitCount)}
      {cell.isPublicHoliday ? (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-amber-400" />
      ) : null}
    </>
  );
  // Numeric-visit days deep-link to the portal day drill-down; other days are static.
  if (cell.status === "VISITS") {
    return (
      <Link
        aria-label={`${cell.employeeName} ${cell.dateIso}: ${cell.explanation} (open visits)`}
        className={cn(baseClass, "transition hover:ring-2 hover:ring-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-300")}
        href={`/employee-portals/team-calendar/visits/${encodeURIComponent(cell.hrId)}/${cell.dateIso}`}
        title={`${cell.explanation} — open the day's visits`}
      >
        {content}
      </Link>
    );
  }
  return (
    <div aria-label={`${cell.employeeName} ${cell.dateIso}: ${cell.explanation}`} className={baseClass} title={cell.explanation}>
      {content}
    </div>
  );
}

function RepMonthTimeline({ employee }: { employee: FieldWorkforceEmployeeSummary }) {
  const monthColumns = { gridTemplateColumns: `repeat(${employee.timeline.length}, minmax(0, 1fr))` };
  const hierarchy = [employee.teamName, employee.areaName, employee.managerName]
    .filter(Boolean)
    .join(" / ");
  return (
    <Card className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-950">{employee.employeeName}</p>
          <p className="mt-1 font-mono text-xs font-bold text-slate-500">
            {employee.hrId}
            {hierarchy ? ` · ${hierarchy}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-bold">
          <span className="text-emerald-700">{employee.totalVisits} visits</span>
          <span className="text-slate-500">{employee.compliancePercent}% compliance</span>
        </div>
      </div>
      {/* Full month fits the width — no horizontal scroll. */}
      <div className="p-3">
        <div className="grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <div
              className={cn(
                "rounded-md py-1 text-center text-[9px] font-black uppercase tracking-tight text-slate-500",
                cell.isFriday ? "bg-slate-100" : "",
                cell.isPublicHoliday ? "bg-amber-50 text-amber-700" : "",
              )}
              key={`${cell.dateIso}-header`}
            >
              <span className="block text-[11px] leading-tight text-slate-900">{cell.dayNumber}</span>
              <span>{weekday(cell.dateIso)}</span>
            </div>
          ))}
        </div>
        <div className="mt-1 grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <TeamCalendarDayCell cell={cell} key={cell.dateIso} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function shiftMonth(month: number, year: number, delta: number): { month: number; year: number } {
  const zeroBased = month - 1 + delta;
  const nextYear = year + Math.floor(zeroBased / 12);
  const nextMonth = ((zeroBased % 12) + 12) % 12;
  return { month: nextMonth + 1, year: nextYear };
}

function monthHref(month: number, year: number) {
  return `/employee-portals/team-calendar?month=${month}&year=${year}`;
}

export function TeamCalendarView({ employees, lineName, month, monthLabel, year }: TeamCalendarViewProps) {
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState("All");

  const teamOptions = useMemo(
    () =>
      [...new Set(employees.map((employee) => employee.teamName).filter((value): value is string => Boolean(value)))].sort(
        (left, right) => left.localeCompare(right),
      ),
    [employees],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return employees.filter((employee) => {
      if (team !== "All" && employee.teamName !== team) return false;
      if (!needle) return true;
      return `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle);
    });
  }, [employees, query, team]);

  const previous = shiftMonth(month, year, -1);
  const next = shiftMonth(month, year, 1);
  const heading = monthLabel ? `${monthLabel} ${year}` : `${String(month).padStart(2, "0")}/${year}`;

  return (
    <div className="space-y-4">
      <Card className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-black text-slate-950">Team Calendar — {heading}</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              {lineName ? `${lineName} line` : "Your line"} · each rep&apos;s field-visit month. Click a green
              numeric day to open that day&apos;s visits.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Link
              aria-label="Previous month"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700"
              href={monthHref(previous.month, previous.year)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <span className="min-w-[112px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-center text-xs font-black text-slate-700">
              {heading}
            </span>
            <Link
              aria-label="Next month"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700"
              href={monthHref(next.month, next.year)}
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px]">
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search rep name or HR ID"
            value={query}
          />
          {teamOptions.length > 0 ? (
            <select
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              onChange={(event) => setTeam(event.target.value)}
              value={team}
            >
              <option value="All">All teams</option>
              {teamOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          ) : null}
        </div>
      </Card>

      <TimelineLegend />
      <p className="text-xs font-bold text-slate-500">Showing {filtered.length} of {employees.length} reps</p>

      {filtered.length === 0 ? (
        <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No rep matches the current filter for {heading}.
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((employee) => (
            <RepMonthTimeline employee={employee} key={employee.hrId} />
          ))}
        </div>
      )}
    </div>
  );
}
