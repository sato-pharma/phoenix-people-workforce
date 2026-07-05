"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  FieldWorkforceCellStatus,
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeSummary,
} from "@/lib/field-workforce-compliance/types";
import { cn } from "@/lib/utils";

const ALL_FILTER = "All";

function uniqueSortedValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Mirrors NsmTeamCalendarGroup from the server module (structural; no server import). */
type TeamCalendarGroup = {
  managerHrId: string | null;
  managerName: string | null;
  members: FieldWorkforceEmployeeSummary[];
};

type TeamCalendarViewProps = {
  employeeCount: number;
  groups: TeamCalendarGroup[];
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

/** One employee's month grid — used INSIDE a ManagerBlock, so it carries no border of its
 * own (the block's single outer border is the only border for the whole DSM + team unit). */
function RepMonthRow({ employee, isFirst }: { employee: FieldWorkforceEmployeeSummary; isFirst: boolean }) {
  const monthColumns = { gridTemplateColumns: `repeat(${employee.timeline.length}, minmax(0, 1fr))` };
  const hierarchy = [employee.teamName, employee.areaName, employee.managerName]
    .filter(Boolean)
    .join(" / ");
  return (
    <div className={cn("bg-white px-4 py-3", isFirst ? "" : "border-t border-slate-100")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
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
      <div className="mt-3">
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
    </div>
  );
}

/**
 * One DSM (or vacant-seat placeholder) and his whole team as ONE visually separate block: a
 * single black border wraps the manager row + every rep's row, with no border between them
 * inside — the block itself, not each person, is the bordered unit.
 */
function managerBlockLabel(group: TeamCalendarGroup): string {
  // A real manager has a real hrId; a vacant-seat placeholder (managerHrId is null) already
  // carries its own descriptive label ("Cairo — Vacant DSM seat") and must not be prefixed
  // with "Manager ·", which would misleadingly imply someone is actually managing the team.
  if (group.managerHrId != null) return `Manager · ${group.managerName ?? ""}`;
  return group.managerName ?? "Other";
}

function ManagerBlock({ group }: { group: TeamCalendarGroup }) {
  return (
    <div className="overflow-hidden rounded-xl border-2 border-black">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-black px-4 py-2.5">
        <span className="text-xs font-black uppercase tracking-wide text-white">
          {managerBlockLabel(group)}
        </span>
        <span className="whitespace-nowrap text-[11px] font-bold text-slate-300">{group.members.length} shown</span>
      </div>
      {group.members.map((employee, index) => (
        <RepMonthRow employee={employee} isFirst={index === 0} key={employee.hrId} />
      ))}
    </div>
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

export function TeamCalendarView({ employeeCount, groups, lineName, month, monthLabel, year }: TeamCalendarViewProps) {
  const [query, setQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState(ALL_FILTER);
  const [regionFilter, setRegionFilter] = useState(ALL_FILTER);
  const [areaFilter, setAreaFilter] = useState(ALL_FILTER);

  const allMembers = useMemo(() => groups.flatMap((group) => group.members), [groups]);
  const teamOptions = useMemo(() => uniqueSortedValues(allMembers.map((employee) => employee.teamName)), [allMembers]);
  const regionOptions = useMemo(() => uniqueSortedValues(allMembers.map((employee) => employee.regionName)), [allMembers]);
  const areaOptions = useMemo(() => uniqueSortedValues(allMembers.map((employee) => employee.areaName)), [allMembers]);

  const needle = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (!needle && teamFilter === ALL_FILTER && regionFilter === ALL_FILTER && areaFilter === ALL_FILTER) return groups;
    return groups
      .map((group) => ({
        ...group,
        members: group.members.filter((employee) => {
          if (teamFilter !== ALL_FILTER && employee.teamName !== teamFilter) return false;
          if (regionFilter !== ALL_FILTER && employee.regionName !== regionFilter) return false;
          if (areaFilter !== ALL_FILTER && employee.areaName !== areaFilter) return false;
          if (needle && !`${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle)) return false;
          return true;
        }),
      }))
      .filter((group) => group.members.length > 0);
  }, [areaFilter, groups, needle, regionFilter, teamFilter]);

  const shownCount = useMemo(
    () => visibleGroups.reduce((sum, group) => sum + group.members.length, 0),
    [visibleGroups],
  );

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
              {lineName ? `${lineName} line` : "Your line"} · grouped by manager, each manager followed by
              their team. Click a green numeric day to open that day&apos;s visits.
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
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 xl:col-span-1"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search rep name or HR ID"
            value={query}
          />
          {teamOptions.length > 0 ? (
            <SearchableSelect
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={teamFilter}
              onChange={(event) => setTeamFilter(event.target.value)}
            >
              <option value={ALL_FILTER}>All teams</option>
              {teamOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </SearchableSelect>
          ) : null}
          {regionOptions.length > 0 ? (
            <SearchableSelect
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={regionFilter}
              onChange={(event) => setRegionFilter(event.target.value)}
            >
              <option value={ALL_FILTER}>All regions</option>
              {regionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </SearchableSelect>
          ) : null}
          {areaOptions.length > 0 ? (
            <SearchableSelect
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={areaFilter}
              onChange={(event) => setAreaFilter(event.target.value)}
            >
              <option value={ALL_FILTER}>All areas</option>
              {areaOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </SearchableSelect>
          ) : null}
        </div>
      </Card>

      <TimelineLegend />
      <p className="text-xs font-bold text-slate-500">Showing {shownCount} of {employeeCount} people</p>

      {visibleGroups.length === 0 ? (
        <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
          No one matches the current filter for {heading}.
        </Card>
      ) : (
        <div>
          {visibleGroups.map((group, groupIndex) => (
            <div key={group.managerHrId ?? `unassigned-${groupIndex}`}>
              <ManagerBlock group={group} />
              {/* Straight line between one DSM's block and the next — not after the last one. */}
              {groupIndex < visibleGroups.length - 1 ? <div className="my-5 h-px bg-slate-400" /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
