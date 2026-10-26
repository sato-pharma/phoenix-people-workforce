"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeSummary,
} from "@/lib/field-workforce-compliance/types";
import {
  isManagerOwnVisitsOnlyDay,
  isPortalRideAlongCoachingDay,
  portalDaySplit,
  portalOwnVisitCount,
} from "@/lib/employee-portal/team-calendar-cell";
import { emptyVisitCountSplit, mergeVisitCountSplits } from "@/lib/crm/visit-count-buckets";
import {
  buildTeamCalendarWeeks,
  clampWeekIndex,
  type TeamCalendarWeek,
  weekIndexForDate,
} from "@/lib/employee-portal/team-calendar-weeks";
import { complianceLabel } from "@/lib/field-workforce-compliance/compliance-label";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminControlDepthClassName, adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

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
  /**
   * Today in CAIRO, from the server. The week stepper opens on the week holding it, which is the
   * week a manager wants nine times out of ten. It comes from the server deliberately: deriving it
   * from `new Date()` in the browser would read the VIEWER's zone (AGENTS.md §4 reports every time
   * in Africa/Cairo) and would differ between the server render and the client, which is a
   * hydration mismatch on top of a wrong answer.
   */
  todayIso: string | null;
  year: number;
};

// DATE-ONLY (a calendar day, a `date` column), which `new Date` parses as UTC midnight. UTC here is
// CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not an
// instant — do not "fix" this one to Cairo.
function weekday(dateIso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${dateIso}T00:00:00Z`));
}

function statusLabel(cell: FieldWorkforceDayCell) {
  if (cell.status === "N" && cell.attendanceCrossCheck === "punch_no_visits") return "P";
  // A pure ride-along (double-visit) day shows a "DV" coaching marker instead of a visit count —
  // otherwise a manager's row would repeat the numbers of the reps they rode along with. Own
  // visits still show as their own number.
  if (cell.status === "VISITS") return isPortalRideAlongCoachingDay(cell) ? "DV" : String(portalOwnVisitCount(cell));
  if (cell.status === "BLANK") return "-";
  return cell.status;
}

/** Same status palette as the admin Field Workforce Compliance timeline. A "VISITS" day
 * additionally shades by visitPeriod: AM-only and PM-only get their own distinct colors to
 * flag a half-day visit pattern; a mixed/untagged day keeps the default emerald. An "N" day
 * with a same-day fingerprint punch (mainly Head Office staff who don't generate CRM visits)
 * shades teal instead of the alarming rose — punched in, not no activity. */
function statusCellClass(cell: FieldWorkforceDayCell) {
  // A day whose only work is the manager's own Phoenix CRM visits is a worked day, never the alarming "No activity".
  if (isManagerOwnVisitsOnlyDay(cell)) {
    return cn("border-emerald-300 bg-emerald-50 text-emerald-800", cell.isPublicHoliday ? "ring-2 ring-amber-300 ring-offset-1" : "");
  }
  const visitsClass = isPortalRideAlongCoachingDay(cell)
    ? // Ride-along / coaching ("DV") day — distinct fuchsia so it never reads as a rep's own visits.
      "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800 hover:bg-fuchsia-100"
    : cell.visitPeriod === "AM"
      ? "border-cyan-300 bg-cyan-50 text-cyan-800 hover:bg-cyan-100"
      : cell.visitPeriod === "PM"
        ? "border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
        : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100";
  const nClass = cell.attendanceCrossCheck === "punch_no_visits"
    ? "border-teal-300 bg-teal-50 text-teal-800 hover:bg-teal-100"
    : "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100";
  const base = {
    AV: "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100",
    BLANK: "border-slate-200 bg-white text-slate-400 hover:bg-slate-50",
    CP: "border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100",
    F: "border-slate-200 bg-slate-100 text-slate-500 hover:bg-slate-200",
    N: nClass,
    UNKNOWN: "border-red-400 bg-red-50 text-red-800 hover:bg-red-100",
    VISITS: visitsClass,
  }[cell.status];
  return cn(
    base,
    cell.isPublicHoliday ? "ring-2 ring-amber-300 ring-offset-1" : "",
    cell.isPreHire ? "opacity-45 grayscale" : "",
  );
}

/** The pharmacy figure's own ink, in every square (owner, 2026-10-23: "in a different color, and separate"). */
const PHARMACY_FIGURE_INK = "bg-violet-600 text-white";

/**
 * The square's figures, AM, then PM, then Pharmacies — each printed apart, never added, and only the ones the day has
 * (owner, 2026-10-23: "make the square … 2 for AM, 9 for PM, and 5 for pharmacies … same for district managers").
 */
function SplitFigures({ split }: { split: { am: number; pm: number; pharmacies: number } }) {
  return (
    <span className="flex w-full flex-col items-stretch gap-px text-center text-phx-3xs leading-tight">
      {split.am > 0 ? <span title={`AM ${split.am}`}>{split.am}</span> : null}
      {split.pm > 0 ? <span title={`PM ${split.pm}`}>{split.pm}</span> : null}
      {split.pharmacies > 0 ? (
        <span className={PHARMACY_FIGURE_INK} title={`Pharmacies ${split.pharmacies}`}>
          {split.pharmacies}
        </span>
      ) : null}
    </span>
  );
}

function LegendChip({ children, className, label }: { children: string; className: string; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
      <span className={cn("inline-flex h-7 min-w-7 items-center justify-center border px-1.5 text-phx-xs font-black", className)}>
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
      <LegendChip className="border-violet-300 bg-violet-50 text-violet-800" label="Campaign / meeting (click to open)">CP</LegendChip>
      <LegendChip className="border-emerald-300 bg-emerald-50 text-emerald-800" label="Visits, full/mixed day (click to open)">5</LegendChip>
      <LegendChip className="border-cyan-300 bg-cyan-50 text-cyan-800" label="Visits, AM only (click to open)">5</LegendChip>
      <LegendChip className="border-indigo-300 bg-indigo-50 text-indigo-800" label="Visits, PM only (click to open)">5</LegendChip>
      <LegendChip className="border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800" label="Double-visit / coaching day — manager rode along, figures are the visits joined (click to open)">DV</LegendChip>
      <LegendChip className="border-slate-300 bg-white text-slate-800" label="A day's figures stack AM, then PM, then Pharmacies — never added">2·9</LegendChip>
      <LegendChip className={PHARMACY_FIGURE_INK} label="Pharmacies, counted apart">5</LegendChip>
      <LegendChip className="border-teal-300 bg-teal-50 text-teal-800" label="Punched in (fingerprint), no CRM activity — click to open">P</LegendChip>
      <LegendChip className="border-slate-200 bg-slate-100 text-slate-500" label="Friday">F</LegendChip>
      <LegendChip className="border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-300" label="Holiday">H</LegendChip>
    </div>
  );
}

function TeamCalendarDayCell({ cell }: { cell: FieldWorkforceDayCell }) {
  // A ride-along/coaching day's classifier explanation ("Worked day because N numeric visits…")
  // reflects the double-credited total, which would be misleading here — describe it as coaching.
  const split = portalDaySplit(cell);
  const splitLine = split ? ` AM ${split.am} · PM ${split.pm} · Pharmacies ${split.pharmacies}.` : "";
  const explanation = isManagerOwnVisitsOnlyDay(cell)
    ? `The manager's own single visits, logged in Phoenix CRM — the day's details are on the Phoenix CRM calendar.${splitLine}`
    : isPortalRideAlongCoachingDay(cell)
      ? `Double-visit / coaching day — rode along on the team's visits (no own primary visits logged).${splitLine}`
      : `${cell.explanation}${splitLine}`;
  const baseClass = cn(
    "relative flex min-h-10 w-full items-center justify-center border text-xs font-black",
    split ? "py-0.5" : "",
    statusCellClass(cell),
  );
  const content = (
    <>
      {split ? <SplitFigures split={split} /> : statusLabel(cell)}
      {cell.isPublicHoliday ? (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-amber-400" />
      ) : null}
    </>
  );
  // Numeric-visit days, campaign days, ride-along coaching days, AND fingerprint-punched "N" days
  // deep-link to the portal day drill-down (all are real recorded activity, just categorized/
  // sourced differently); other days are static.
  if (cell.status === "VISITS" || cell.status === "CP" || cell.attendanceCrossCheck === "punch_no_visits") {
    return (
      <Link
        aria-label={`${cell.employeeName} ${cell.dateIso}: ${explanation} (open visits)`}
        className={cn(baseClass, "transition hover:ring-2 hover:ring-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-300")}
        href={`/employee-portals/team-calendar/visits/${encodeURIComponent(cell.hrId)}/${cell.dateIso}`}
        title={`${explanation} — open the day's visits`}
      >
        {content}
      </Link>
    );
  }
  return (
    <div aria-label={`${cell.employeeName} ${cell.dateIso}: ${explanation}`} className={baseClass} title={explanation}>
      {content}
    </div>
  );
}

/** One employee's month grid — used INSIDE a ManagerBlock, so it carries no border of its
 * own (the block's single outer border is the only border for the whole DSM + team unit). */
function RepMonthRow({
  employee,
  isFirst,
  week,
}: {
  employee: FieldWorkforceEmployeeSummary;
  isFirst: boolean;
  week: TeamCalendarWeek | null;
}) {
  // 🔴 THE COLUMNS DIVIDE THE WIDTH; THEY NEVER SET A FLOOR.
  //
  // This was `minmax(2.5rem, 1fr)` — a 1,240px hard minimum for a 31-day month, sitting inside an
  // `overflow-x-auto`. No `min-w-` search ever finds that, because it is written as a grid template,
  // and it overflowed a DESKTOP content box too, not only a phone: on a 375px screen a manager saw
  // about three days and had to drag sideways through the other twenty-eight, once per person, for
  // every person on his team. AGENTS.md §4: a scroller over a minimum width IS the bug, not the fix.
  //
  // `minmax(0, 1fr)` lets the 31 columns share whatever width there is — about 34px each in the
  // portal's desktop content box, enough for a day number and its weekday. Below `lg` that
  // arithmetic can never work at any font size, so small screens get ONE WEEK at a time instead
  // (the owner's ruling, 2026-09-29), which is what `week` carries.
  const monthColumns = { gridTemplateColumns: `repeat(${employee.timeline.length}, minmax(0, 1fr))` };
  const weekColumns = { gridTemplateColumns: "repeat(7, minmax(0, 1fr))" };
  // Sliced by DATE, never by index: two people in one month can legitimately carry timelines of
  // different lengths (a mid-month joiner, a pre-hire run-in), so an index range taken from one
  // person's array would quietly show the wrong days for the next.
  const weekCells = week
    ? employee.timeline.filter((cell) => cell.dateIso >= week.startDateIso && cell.dateIso <= week.endDateIso)
    : [];
  const hierarchy = [employee.teamName, employee.areaName, employee.managerName]
    .filter(Boolean)
    .join(" / ");
  // Show each person's OWN (primary-agent) visits — a ride-along (double-visit) day is a coaching
  // day, tallied separately as "DV days" — so a manager's row never sums the reps' visits into a
  // doubled total. For a rep with no ride-alongs this equals their full visit total, unchanged.
  const ownVisits = employee.timeline.reduce(
    (sum, cell) => sum + (cell.status === "VISITS" && !cell.ignored ? portalOwnVisitCount(cell) : 0),
    0,
  );
  // His month AM · PM · Pharmacies apart: his own calls in the mirror plus, for a manager, his own Phoenix CRM single
  // visits. Ride-along days stay out of it — they are the reps' visits, already on the reps' rows.
  const monthSplit = employee.timeline.reduce((sum, cell) => {
    if (cell.ignored) return sum;
    if (cell.status === "VISITS" && cell.ownVisitSplit) mergeVisitCountSplits(sum, cell.ownVisitSplit);
    if (cell.managerOwnSplit) mergeVisitCountSplits(sum, cell.managerOwnSplit);
    return sum;
  }, emptyVisitCountSplit());
  const hasMonthSplit = employee.timeline.some((cell) => cell.ownVisitSplit || cell.managerOwnSplit);
  const coachingDays = employee.timeline.filter((cell) => !cell.ignored && isPortalRideAlongCoachingDay(cell)).length;
  return (
    <div className={cn("bg-white px-4 py-3", isFirst ? "" : "border-t border-slate-100")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-950">{employee.employeeName}</p>
          {/* Names, never codes: the HR id stays out of the subtitle; the search still matches it. */}
          {hierarchy ? <p className="mt-1 text-xs font-bold text-slate-500">{hierarchy}</p> : null}
        </div>
        <div className="flex items-center gap-3 text-phx-xs font-bold">
          {hasMonthSplit ? (
            <span className="text-emerald-700">
              AM {monthSplit.am} · PM {monthSplit.pm} · <span className="text-violet-700">Pharmacies {monthSplit.pharmacies}</span>
            </span>
          ) : (
            <span className="text-emerald-700">{ownVisits} visits</span>
          )}
          {coachingDays > 0 ? <span className="text-fuchsia-700">{coachingDays} DV days</span> : null}
          <span className="text-slate-500">
            {employee.compliancePercent === null ? complianceLabel(employee) : `${complianceLabel(employee)} compliance`}
          </span>
        </div>
      </div>

      {/* ── One week, below lg (the owner's ruling for the phone) ────────────── */}
      {/* The days keep their real weekday columns: `gridColumnStart` pushes an opening partial week
          to the right, or the 1st of the month would sit under "Sat" whatever day it actually was —
          and a manager checking who worked Sunday would be reading the wrong column. */}
      <div className="mt-3 lg:hidden">
        <div className="grid gap-1" style={weekColumns}>
          {weekCells.map((cell, index) => (
            <div
              className={cn(
                "rounded-md py-1 text-center text-phx-3xs font-black uppercase tracking-tight text-slate-500",
                cell.isFriday ? "bg-slate-100" : "",
                cell.isPublicHoliday ? "bg-amber-50 text-amber-700" : "",
              )}
              key={`${cell.dateIso}-week-header`}
              style={index === 0 && week ? { gridColumnStart: week.startColumn } : undefined}
            >
              <span className="block text-phx-xs leading-tight text-slate-900">{cell.dayNumber}</span>
              <span>{weekday(cell.dateIso)}</span>
            </div>
          ))}
        </div>
        <div className="mt-1 grid gap-1" style={weekColumns}>
          {weekCells.map((cell, index) => (
            <div
              key={`${cell.dateIso}-week-cell`}
              style={index === 0 && week ? { gridColumnStart: week.startColumn } : undefined}
            >
              <TeamCalendarDayCell cell={cell} />
            </div>
          ))}
        </div>
      </div>

      {/* ── The whole month, lg and up — no scroller, columns divide the width ── */}
      <div className="mt-3 hidden lg:block">
        <div className="grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <div
              className={cn(
                "rounded-md py-1 text-center text-phx-3xs font-black uppercase tracking-tight text-slate-500",
                cell.isFriday ? "bg-slate-100" : "",
                cell.isPublicHoliday ? "bg-amber-50 text-amber-700" : "",
              )}
              key={`${cell.dateIso}-header`}
            >
              <span className="block text-phx-xs leading-tight text-slate-900">{cell.dayNumber}</span>
              {/* 🔴 MEASURED, not guessed. With `minmax(0, 1fr)` the day CELLS fit at any width —
                  measured clean down to 560px — but the header row does not, because a three-letter
                  weekday cannot shrink: it overflowed by 8px at 560, 3px at 700, 1px at 760 and only
                  reached zero at **800px**. A 31-column month therefore had a real 800px floor
                  hiding in the header text alone, which a content box at the `lg` breakpoint is not
                  guaranteed to clear. Two letters measure clean from **600px**, so the abbreviation
                  shortens between `lg` and `xl` and returns in full above it. Fitting by shortening
                  a label is the rule's own remedy — never a sideways scroll, and never smaller type
                  (AGENTS.md §4). */}
              <span className="xl:hidden">{weekday(cell.dateIso).slice(0, 2)}</span>
              <span className="hidden xl:inline">{weekday(cell.dateIso)}</span>
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

function ManagerBlock({ group, week }: { group: TeamCalendarGroup; week: TeamCalendarWeek | null }) {
  return (
    <div className="overflow-hidden rounded-xl border-2 border-black">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-black px-4 py-2.5">
        <span className="text-xs font-black uppercase tracking-wide text-white">
          {managerBlockLabel(group)}
        </span>
        <span className="whitespace-nowrap text-phx-xs font-bold text-slate-300">{group.members.length} shown</span>
      </div>
      {group.members.map((employee, index) => (
        <RepMonthRow employee={employee} isFirst={index === 0} key={employee.hrId} week={week} />
      ))}
    </div>
  );
}

/**
 * The week stepper, below `lg` only.
 *
 * ONE stepper for the whole page, not one per person. Per-row arrows would let two reps in the same
 * team sit on different weeks, which makes the board impossible to read down a column — the entire
 * value of this view is comparing the same day across a team.
 */
function WeekStepper({
  onChange,
  weekIndex,
  weeks,
}: {
  onChange: (next: number) => void;
  weekIndex: number;
  weeks: TeamCalendarWeek[];
}) {
  if (weeks.length === 0) return null;
  const current = weeks[weekIndex];
  return (
    <div className={`flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 lg:hidden ${adminSoftDepthClassName}`}>
      <button
        aria-label="Previous week"
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
        disabled={weekIndex === 0}
        onClick={() => onChange(weekIndex - 1)}
        type="button"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="min-w-0 text-center">
        <p className="text-sm font-black text-slate-950">{current?.label}</p>
        <p className="mt-0.5 text-phx-xs font-bold text-slate-500">
          Week {weekIndex + 1} of {weeks.length} · the whole month shows on a bigger screen
        </p>
      </div>
      <button
        aria-label="Next week"
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700 disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
        disabled={weekIndex >= weeks.length - 1}
        onClick={() => onChange(weekIndex + 1)}
        type="button"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
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

export function TeamCalendarView({
  employeeCount,
  groups,
  lineName,
  month,
  monthLabel,
  todayIso,
  year,
}: TeamCalendarViewProps) {
  const [query, setQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState(ALL_FILTER);
  const [regionFilter, setRegionFilter] = useState(ALL_FILTER);
  const [areaFilter, setAreaFilter] = useState(ALL_FILTER);

  const weeks = useMemo(() => buildTeamCalendarWeeks(year, month), [month, year]);
  // Opens on the week holding today when today falls inside the month being viewed, and on the
  // first week otherwise — a manager looking back at August wants its start, not its last week.
  const [weekIndex, setWeekIndex] = useState(() =>
    todayIso ? weekIndexForDate(weeks, todayIso) : 0,
  );
  // A month change is a full navigation (the arrows are <Link>s), so the state starts fresh each
  // time. This clamp is the belt: it also covers a 4-week month reached from a 5-week one if that
  // ever stops being a navigation.
  const safeWeekIndex = clampWeekIndex(weeks, weekIndex);
  const currentWeek = weeks[safeWeekIndex] ?? null;

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
      <Card className={`rounded-xl border border-slate-200 bg-white p-4 ${adminPanelDepthClassName}`}>
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
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700 ${adminControlDepthClassName}`}
              href={monthHref(previous.month, previous.year)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <span className={`min-w-[112px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-center text-xs font-black text-slate-700 ${adminSoftDepthClassName}`}>
              {heading}
            </span>
            <Link
              aria-label="Next month"
              className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-orange-300 hover:text-orange-700 ${adminControlDepthClassName}`}
              href={monthHref(next.month, next.year)}
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <input
            className={`${phxFieldClassName} xl:col-span-1`}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search rep name"
            value={query}
          />
          {teamOptions.length > 0 ? (
            <SearchableSelect
              className="px-3"
              value={teamFilter}
              onChange={(event) => setTeamFilter(event.target.value)}
            >
              <option value={ALL_FILTER}>All teams</option>
              {teamOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </SearchableSelect>
          ) : null}
          {regionOptions.length > 0 ? (
            <SearchableSelect
              className="px-3"
              value={regionFilter}
              onChange={(event) => setRegionFilter(event.target.value)}
            >
              <option value={ALL_FILTER}>All regions</option>
              {regionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </SearchableSelect>
          ) : null}
          {areaOptions.length > 0 ? (
            <SearchableSelect
              className="px-3"
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

      <WeekStepper onChange={setWeekIndex} weekIndex={safeWeekIndex} weeks={weeks} />

      {visibleGroups.length === 0 ? (
        <Card className={`rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 ${adminPanelDepthClassName}`}>
          No one matches the current filter for {heading}.
        </Card>
      ) : (
        <div>
          {visibleGroups.map((group, groupIndex) => (
            <div key={group.managerHrId ?? `unassigned-${groupIndex}`}>
              <ManagerBlock group={group} week={currentWeek} />
              {/* Straight line between one DSM's block and the next — not after the last one. */}
              {groupIndex < visibleGroups.length - 1 ? <div className="my-5 h-px bg-slate-400" /> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
