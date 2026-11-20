"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  TriangleAlert,
  Users,
} from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
} from "@/components/employee-portal/portal-primitives";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import {
  groupPlanItemsByRegion,
  planningTilePeople,
  planningGroupKey,
  type PlanningCalendarConflict,
  type PlanningCalendarItem,
  type PlanningCalendarPlanItem,
  type PlanningCalendarWorkspace,
} from "@/lib/weekly-planning/calendar";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxFieldClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LANDING_ROW_LINK,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingPanel,
  LandingTitle,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";


const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const allValue = "__all__";

const planStatusLabels: Record<string, string> = {
  ceo_approved: "CEO approved",
  final_approved: "Final approved",
  hr_acknowledged: "HR acknowledged",
  manager_approved: "Manager approved",
  submitted: "Submitted",
};

// A plan status as coloured text — the landing kit's status rule (no filled pill). Every status this
// calendar shows is submitted or further along: sky while a manager or the CEO still holds it, green once
// it is final.
function planStatusInk(status: string) {
  if (status === "final_approved" || status === "hr_acknowledged") return "text-emerald-700";
  return "text-sky-700";
}

/** The status word's shape — small tracked capitals that wrap inside a narrow column. */
const statusWordClassName = "break-words text-phx-xs font-bold uppercase tracking-[0.08em]";

function todayIso() {
  return currentCairoDateOnlyIso();
}

// monthLabel and dayLabel below all render DATE-ONLY values (a month off a synthetic `Date.UTC`, and a
// plan day's `activity_date`), which `new Date` parses as UTC midnight. UTC here is CORRECT and must
// stay: it is what stops the calendar day being shifted by a zone offset. None of these is an instant —
// do not "fix" them to Cairo.
function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function monthDateIso(year: number, month: number, preferredDay = 1) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(preferredDay, 1), lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
  }).format(new Date(`${value}T00:00:00Z`));
}

function isPlanItem(item: PlanningCalendarItem): item is PlanningCalendarPlanItem {
  return item.source === "plan";
}

function itemOccursOn(item: PlanningCalendarItem, date: string) {
  return date >= item.startDate && date <= item.endDate;
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function planSearchText(item: PlanningCalendarPlanItem) {
  return [
    item.employeeDisplayName,
    item.employeeHrId,
    item.activityTitle,
    item.region,
    item.area,
    item.medicalRepDisplayName || item.medicalRepName,
    item.lineName,
    item.status,
  ]
    .join(" ")
    .toLowerCase();
}

// Per-day employee color coding — same recipe as the Private Calendar's
// per-source colors (border-l-500 accent, bg-100/text-700 chip, bg-500 dot),
// just keyed by employee instead of by data source. Colors are assigned by
// order of first appearance WITHIN a single day's item list, never by hashing
// the HR ID — a hash can (and did) collide two unrelated employees onto the
// same bucket. Sky marks a chain visit (a neutral co-visit note, not an alarm)
// and emerald national vacations, matching how this calendar reserves those two
// colors for those two meanings.
type EmployeeHue = { border: string; chip: string; dot: string };

const employeeHues: EmployeeHue[] = [
  { border: "border-l-amber-500", chip: "bg-amber-100 text-amber-700", dot: "bg-amber-500" },
  { border: "border-l-blue-500", chip: "bg-blue-100 text-blue-700", dot: "bg-blue-500" },
  { border: "border-l-pink-500", chip: "bg-pink-100 text-pink-700", dot: "bg-pink-500" },
  { border: "border-l-violet-500", chip: "bg-violet-100 text-violet-700", dot: "bg-violet-500" },
  { border: "border-l-teal-500", chip: "bg-teal-100 text-teal-700", dot: "bg-teal-500" },
  { border: "border-l-indigo-500", chip: "bg-indigo-100 text-indigo-700", dot: "bg-indigo-500" },
  { border: "border-l-fuchsia-500", chip: "bg-fuchsia-100 text-fuchsia-700", dot: "bg-fuchsia-500" },
  { border: "border-l-sky-500", chip: "bg-sky-100 text-sky-700", dot: "bg-sky-500" },
  { border: "border-l-purple-500", chip: "bg-purple-100 text-purple-700", dot: "bg-purple-500" },
  { border: "border-l-cyan-500", chip: "bg-cyan-100 text-cyan-700", dot: "bg-cyan-500" },
];

function employeeHueKey(employeeHrId: string) {
  return employeeHrId.trim().toUpperCase() || "unassigned";
}

// Builds a same-day color map: the first distinct employee seen gets palette
// slot 0, the second gets slot 1, and so on, so two different employees can
// never end up with the same color on the same day (only wraps, extremely
// unlikely to matter in practice, once a single day has more distinct
// employees than the palette has colors).
function assignDailyEmployeeHues(dayItems: PlanningCalendarPlanItem[]) {
  const map = new Map<string, EmployeeHue>();
  let cursor = 0;
  for (const item of dayItems) {
    const key = employeeHueKey(item.employeeHrId);
    if (map.has(key)) continue;
    map.set(key, employeeHues[cursor % employeeHues.length]);
    cursor += 1;
  }
  return map;
}

function employeeHueFor(map: Map<string, EmployeeHue>, employeeHrId: string) {
  return map.get(employeeHueKey(employeeHrId)) ?? employeeHues[0];
}

function planChipTone(item: PlanningCalendarPlanItem, hue: EmployeeHue) {
  // A chain-visit day keeps the person's own colour; a thin sky ring marks the co-visit without the
  // alarm of a red fill (owner, 2026-10-24: show it as a chain visit, not a warning). conflictWarning
  // keeps its internal name but now carries a neutral "Chain visit" note, never a clash.
  return item.conflictWarning ? `${hue.chip} ring-1 ring-inset ring-sky-400` : hue.chip;
}

function PlanningMetric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "info";
  value: number;
}) {
  return (
    // A tile on the navy board: one step lighter than the board; chain visits read sky once there are any.
    <div className={`min-w-0 px-3 py-2.5 ${LANDING_NAVY_TILE}`}>
      <LandingFigure onNavy tone={tone === "info" ? "text-sky-300" : undefined}>
        {value}
      </LandingFigure>
      <p className="mt-1 break-words text-phx-xs font-bold uppercase tracking-[0.12em] text-white/60">{label}</p>
    </div>
  );
}

/** A condition line — capped, not ready, could not load — with its tone on a 4px rail, never a tinted box. */
function PlanningNotice({ children, tone }: { children: ReactNode; tone: "amber" | "red" }) {
  const rail = tone === "red" ? "bg-rose-600" : "bg-amber-500";
  const ink = tone === "red" ? "text-rose-700" : "text-amber-700";
  return (
    <div className={`flex min-w-0 items-start gap-3 border border-slate-200 bg-white px-3 py-2.5 ${adminSoftDepthClassName}`}>
      <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${rail}`} />
      <TriangleAlert aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${ink}`} />
      <div className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-slate-700">{children}</div>
    </div>
  );
}

function conflictForDay(conflicts: PlanningCalendarConflict[], date: string) {
  return conflicts.filter((conflict) => conflict.date === date);
}

type PlanningCalendarDetailRow = {
  activity: string;
  area: string;
  conflictWarning: string;
  date: string;
  employee: string;
  employeeHrId: string;
  // What the details group by (region, then area inside it); the shown Region / Area text can list more.
  groupArea: string | null;
  groupRegion: string | null;
  id: string;
  medicalRep: string;
  notes: string;
  regionLocation: string;
  status: string;
  time: string;
  tone: "conflict" | "holiday" | "plan";
};

export function PlanningCalendar({
  initialWorkspace,
  canExport = false,
}: {
  initialWorkspace: PlanningCalendarWorkspace;
  // Renders the "Export XLSX" button when true. Computed server-side per page from the
  // viewer's role (SFE Manager / Super Admin only); the download route enforces the same
  // check, so this prop only governs button visibility, never access.
  canExport?: boolean;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [activityFilter, setActivityFilter] = useState(allValue);
  const [regionFilter, setRegionFilter] = useState(allValue);
  const [query, setQuery] = useState("");
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [viewMode, setViewModeState] = useState<"month" | "week" | "list">("month");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Track whether the user has manually chosen a view. Once they have, the
  // mobile-default effect must never override their choice.
  const userPickedView = useRef(false);
  const setViewMode = (mode: "month" | "week" | "list") => {
    userPickedView.current = true;
    setViewModeState(mode);
  };

  // Mobile-first default: on small screens, prefer the readable List view.
  // SSR/initial state stays "month" (no hydration mismatch); after mount we
  // defer the switch to a rAF callback (not the synchronous effect body) and
  // only adjust if the user hasn't toggled yet.
  useEffect(() => {
    if (userPickedView.current) return;
    if (typeof window === "undefined" || window.innerWidth >= 640) return;
    const id = window.requestAnimationFrame(() => {
      if (!userPickedView.current) setViewModeState("list");
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  const { conflicts, items, month, summary, weeks, year } = workspace;
  const today = todayIso();

  const planItems = useMemo(() => items.filter(isPlanItem), [items]);
  const holidayItems = useMemo(() => items.filter((item) => item.source === "holiday"), [items]);
  const activityOptions = useMemo(() => uniqueSorted(planItems.map((item) => item.activityTitle)), [planItems]);
  // One option per region however it was typed ("Delta 1" and "Delta (1)" are one region), matching the
  // region groups the tile and the details draw.
  const regionOptions = useMemo(
    () => groupPlanItemsByRegion(planItems).filter((region) => region.key).map(({ key, label }) => ({ key, label })),
    [planItems],
  );

  const filteredPlanItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return planItems.filter((item) => {
      if (activityFilter !== allValue && item.activityTitle !== activityFilter) return false;
      if (regionFilter !== allValue && planningGroupKey(item.region) !== regionFilter) return false;
      if (conflictsOnly && !item.conflictWarning) return false;
      if (search && !planSearchText(item).includes(search)) return false;
      return true;
    });
  }, [activityFilter, conflictsOnly, planItems, query, regionFilter]);

  const visibleItems = useMemo(
    () => [...holidayItems, ...filteredPlanItems].sort((left, right) => `${left.startDate}-${left.title}`.localeCompare(`${right.startDate}-${right.title}`)),
    [filteredPlanItems, holidayItems],
  );

  const itemsByDay = useMemo(() => {
    const map = new Map<string, PlanningCalendarItem[]>();
    for (const week of weeks) {
      for (const day of week) {
        const date = day.date;
        if (!date) continue;
        const dayItems = visibleItems.filter((item) => itemOccursOn(item, date));
        if (dayItems.length) map.set(date, dayItems);
      }
    }
    return map;
  }, [visibleItems, weeks]);

  // Agenda (List view): every in-month day that has items, sorted, each fully
  // readable. This is the antidote to the cramped month grid.
  const agendaDays = useMemo(() => {
    const dates = Array.from(itemsByDay.keys())
      .filter((date) => Number(date.slice(5, 7)) === month)
      .sort();
    return dates.map((date) => ({ date, dayItems: itemsByDay.get(date) ?? [] }));
  }, [itemsByDay, month]);

  // Week view: the 7 dates of the week (Sunday start) containing selectedDate.
  // Empty days are included so the week is always complete and readable.
  const weekDays = useMemo(() => {
    const base = new Date(`${selectedDate}T00:00:00Z`);
    const weekStart = new Date(base);
    weekStart.setUTCDate(base.getUTCDate() - base.getUTCDay());
    return Array.from({ length: 7 }, (_, offset) => {
      const day = new Date(weekStart);
      day.setUTCDate(weekStart.getUTCDate() + offset);
      const date = day.toISOString().slice(0, 10);
      return { date, dayItems: itemsByDay.get(date) ?? [] };
    });
  }, [itemsByDay, selectedDate]);

  const weekRangeLabel = useMemo(() => {
    if (weekDays.length === 0) return "";
    // DATE-ONLY (the week's day keys, "YYYY-MM-DD"), parsed as UTC midnight — same reason as
    // monthLabel/dayLabel above: UTC is what stops the calendar day being shifted by a zone offset.
    const fmt = (value: string) =>
      new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(
        new Date(`${value}T00:00:00Z`),
      );
    return `${fmt(weekDays[0].date)} – ${fmt(weekDays[weekDays.length - 1].date)}`;
  }, [weekDays]);

  const selectedItems = useMemo(
    () => visibleItems.filter((item) => itemOccursOn(item, selectedDate)),
    [selectedDate, visibleItems],
  );
  const selectedHolidays = selectedItems.filter((item) => item.source === "holiday");
  const selectedPlans = selectedItems.filter(isPlanItem);
  const selectedDayHues = useMemo(() => assignDailyEmployeeHues(selectedPlans), [selectedPlans]);
  // A chain visit is shown on each person's own row, in the Chain Visit column — never as an extra
  // row that repeats them (owner, 2026-10-24: "you see the duplication in rasha and nermine").
  const selectedDetailRows: PlanningCalendarDetailRow[] = [
    ...selectedHolidays.map((holiday) => ({
      activity: holiday.title,
      area: "-",
      conflictWarning: "-",
      date: selectedDate,
      employee: "Company calendar",
      employeeHrId: "",
      groupArea: null,
      groupRegion: null,
      id: holiday.id,
      medicalRep: "-",
      notes: holiday.description || "-",
      regionLocation: "National vacation",
      status: "Holiday",
      time: "Full day",
      tone: "holiday" as const,
    })),
    ...selectedPlans.map((item) => ({
      activity: item.activityTitle,
      area: item.area || "-",
      conflictWarning: item.conflictWarning || "-",
      date: item.startDate,
      employee: item.employeeDisplayName || item.employeeName,
      employeeHrId: item.employeeHrId,
      groupArea: item.area,
      groupRegion: item.region,
      id: item.id,
      medicalRep: item.medicalRepDisplayName || item.medicalRepName || item.medicalRepHrId || "-",
      notes: item.notes || "-",
      regionLocation: item.region || "-",
      status: planStatusLabels[item.status] ?? item.status,
      time: item.time || "Full day",
      tone: "plan" as const,
    })),
  ];

  async function loadMonth(nextYear: number, nextMonth: number, nextSelectedDate: string) {
    const response = await fetch(`/api/weekly-plans/calendar?year=${nextYear}&month=${nextMonth}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.message ?? "Unable to load planning calendar.");
    setWorkspace(payload.data);
    setSelectedDate(nextSelectedDate);
  }

  function shiftMonth(delta: number) {
    const base = new Date(Date.UTC(year, month - 1 + delta, 1));
    const preferredDay = Number(selectedDate.slice(8, 10)) || 1;
    setMessage(null);
    startTransition(async () => {
      try {
        const nextYear = base.getUTCFullYear();
        const nextMonth = base.getUTCMonth() + 1;
        await loadMonth(nextYear, nextMonth, monthDateIso(nextYear, nextMonth, preferredDay));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load planning calendar.");
      }
    });
  }

  function goToday() {
    const { year: todayYear, month: todayMonth } = currentCairoDateParts();
    setSelectedDate(todayIso());
    setMessage(null);
    startTransition(async () => {
      try {
        await loadMonth(todayYear, todayMonth, todayIso());
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load planning calendar.");
      }
    });
  }

  function resetFilters() {
    setActivityFilter(allValue);
    setRegionFilter(allValue);
    setQuery("");
    setConflictsOnly(false);
  }

  const cappedResultsBanner = workspace.hasMoreHeaders || workspace.hasMoreItems ? (
    <PlanningNotice tone="amber">
      Planning calendar results are capped at {workspace.headerLimit} headers and {workspace.itemLimit} plan rows. Loaded {workspace.loadedHeaderCount} headers and {workspace.loadedItemCount} rows; narrow the month before using this view for a full audit.
    </PlanningNotice>
  ) : null;

  return (
    <div className="space-y-5">
      {!workspace.schemaReady ? (
        <PlanningNotice tone="amber">Planning calendar data is not ready. National vacations are still shown.</PlanningNotice>
      ) : null}
      {cappedResultsBanner}

      {/* ── Header — the month on white. The dark gradient band it replaces was the page's hero; the
          figures now stand on the page's one navy board, below. ── */}
      <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <div className="px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <LandingTitle>Shared Planning Calendar</LandingTitle>
                {summary.conflictCount > 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.1em] text-sky-700">
                    <Users aria-hidden="true" className="h-3.5 w-3.5" />
                    {summary.conflictCount} chain {summary.conflictCount === 1 ? "visit" : "visits"}
                  </span>
                ) : null}
              </div>
              <h2 className={`break-words text-2xl font-bold leading-none tracking-[-0.02em] sm:text-3xl ${LANDING_INK}`}>{monthLabel(year, month)}</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canExport ? (
                <a
                  className={landingActionClassName("outline")}
                  href={`/api/weekly-plans/calendar/export?year=${year}&month=${month}`}
                  title="Download the detailed plans per user for this month as a styled Excel workbook"
                >
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  Export XLSX
                </a>
              ) : null}
              <div className="inline-flex border border-[#08111f]">
                {(["month", "week", "list"] as const).map((mode) => (
                  <button
                    aria-pressed={viewMode === mode}
                    className={[
                      "min-h-10 px-3.5 text-phx-xs font-bold uppercase tracking-[0.1em] transition-colors motion-reduce:transition-none sm:min-h-8",
                      LANDING_FOCUS,
                      viewMode === mode ? "bg-[#08111f] text-white" : "bg-white text-[#08111f] hover:bg-slate-50",
                    ].join(" ")}
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    type="button"
                  >
                    {mode === "month" ? "Month" : mode === "week" ? "Week" : "List"}
                  </button>
                ))}
              </div>
              <div className="inline-flex items-center gap-2">
                <button
                  aria-label="Previous month"
                  className={landingActionClassName("outline", "w-10 px-0 sm:w-8")}
                  disabled={isPending}
                  onClick={() => shiftMonth(-1)}
                  type="button"
                >
                  <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                </button>
                <button
                  className={landingActionClassName("solid")}
                  disabled={isPending}
                  onClick={goToday}
                  type="button"
                >
                  Today
                </button>
                <button
                  aria-label="Next month"
                  className={landingActionClassName("outline", "w-10 px-0 sm:w-8")}
                  disabled={isPending}
                  onClick={() => shiftMonth(1)}
                  type="button"
                >
                  <ChevronRight aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <LandingNavyBoard label="Key figures" right={<LandingMeta items={[monthLabel(year, month)]} onNavy />}>
        <div className="grid grid-cols-2 gap-px xl:grid-cols-4">
          <PlanningMetric label="Plan entries" value={summary.planCount} />
          <PlanningMetric label="Planning owners" value={summary.submittedOwnerCount} />
          <PlanningMetric label="Chain visits" tone={summary.conflictCount > 0 ? "info" : "neutral"} value={summary.conflictCount} />
          <PlanningMetric label="National vacations" value={summary.holidayCount} />
        </div>
      </LandingNavyBoard>

      {message ? <PlanningNotice tone="red">{message}</PlanningNotice> : null}

      {/* ── Filters ── */}
      <LandingPanel title="Filter & Search">
        <div className="grid gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(180px,1fr)_minmax(160px,220px)_minmax(160px,220px)_auto_auto] lg:items-end">
          <label className="block">
            <span className={phxLabelClassName}>Search</span>
            <span className="relative block">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className={cn(phxFieldClassName, "pl-9")}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Employee, area, rep"
                value={query}
              />
            </span>
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Activity</span>
            <SearchableSelect
              className={phxSelectClassName}
              onChange={(event) => setActivityFilter(event.target.value)}
              value={activityFilter}
            >
              <option value={allValue}>All activities</option>
              {activityOptions.map((activity) => (
                <option key={activity} value={activity}>
                  {activity}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block">
            <span className={phxLabelClassName}>Region</span>
            <SearchableSelect
              className={phxSelectClassName}
              onChange={(event) => setRegionFilter(event.target.value)}
              value={regionFilter}
            >
              <option value={allValue}>All regions</option>
              {regionOptions.map((region) => (
                <option key={region.key} value={region.key}>
                  {region.label}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <button
            aria-pressed={conflictsOnly}
            className={landingActionClassName(conflictsOnly ? "solid" : "outline", "min-h-10 sm:min-h-10")}
            onClick={() => setConflictsOnly((value) => !value)}
            type="button"
          >
            <Users aria-hidden="true" className="h-4 w-4" />
            Chain visits
          </button>
          <button
            className={landingActionClassName("outline", "min-h-10 sm:min-h-10")}
            onClick={resetFilters}
            type="button"
          >
            Reset
          </button>
        </div>
      </LandingPanel>

      {conflicts.length > 0 ? (
        <LandingPanel title={<>{conflicts.length} Chain Visit{conflicts.length === 1 ? "" : "s"}</>}>
          <div className="divide-y divide-slate-200">
            {conflicts.slice(0, 8).map((conflict) => (
              <button
                className={`flex w-full min-w-0 gap-3 px-3 py-3 text-left sm:px-4 ${LANDING_ROW_LINK}`}
                key={conflict.id}
                onClick={() => setSelectedDate(conflict.date)}
                type="button"
              >
                <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-sky-500" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="break-words text-phx-xs font-bold uppercase tracking-[0.08em] text-sky-700">{dayLabel(conflict.date)}</span>
                  <span className={`break-words text-sm font-semibold ${LANDING_INK}`}>{conflict.warning}</span>
                </span>
              </button>
            ))}
          </div>
        </LandingPanel>
      ) : null}

      <section className="space-y-5">
        {viewMode === "list" ? (
          <PlanningCalendarAgenda agendaDays={agendaDays} onSelectDate={setSelectedDate} />
        ) : viewMode === "week" ? (
          <div className="space-y-3">
            <div className={`flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}>
              <LandingTitle>Week of</LandingTitle>
              <span className={`break-words text-sm font-bold tabular-nums ${LANDING_INK}`}>{weekRangeLabel}</span>
            </div>
            {weekDays.map(({ date, dayItems }) => (
              <AgendaDayBlock
                date={date}
                dayItems={dayItems}
                key={date}
                onSelectDate={setSelectedDate}
                showEmpty
              />
            ))}
          </div>
        ) : (
        <>
        <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          {/* FRIDAY is the only narrow column. Friday is off for everyone
              (isFieldWorkforceFriday, unconditional), but SATURDAY is a full working day
              for the Medical Rep / District Manager population this calendar plans for —
              their weekend is Friday-only (isFieldWorkforceFridayOnlyTitle), and the week
              runs Sat-Wed full days. Saturday therefore carries real plan chips and must
              get an equal 1fr share like Sun-Thu; only Friday shrinks. Keep this template
              identical on the header row and the day grid below or the columns misalign.
              Below md Friday narrows to 32px so the grid fits a 280px phone. */}
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_32px_minmax(0,1fr)] border-b border-slate-200 bg-white md:grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)]">
            {weekdays.map((weekday) => (
              <div className={`px-0.5 py-2.5 text-center text-phx-xs font-bold uppercase tracking-[0.06em] md:px-2 md:tracking-[0.12em] ${LANDING_INK}`} key={weekday}>
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_32px_minmax(0,1fr)] divide-x divide-y divide-slate-200 md:grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)]">
            {weeks.flat().map((day, index) => {
              const date = day.date;
              const dayItems = date ? itemsByDay.get(date) ?? [] : [];
              // National Vacation plan items are excluded from the month-grid chip list:
              // the holiday overlay below already shows the day is a national vacation for
              // everyone, so a redundant per-person chip reads as "still doing something
              // that day" instead of correctly disappearing into the holiday. The plan row
              // itself is untouched (still visible in List/Week views and the Daily
              // Timeline) — this only hides it from the compact month grid.
              const dayPlans = dayItems.filter(isPlanItem).filter((item) => item.activityTitle !== "National Vacation");
              const dayHolidays = dayItems.filter((item) => item.source === "holiday");
              const dayConflicts = date ? conflictForDay(conflicts, date) : [];
              const dayHues = assignDailyEmployeeHues(dayPlans);
              const dayRegions = groupPlanItemsByRegion(dayPlans);
              const isSelected = date === selectedDate;
              const isToday = date === today;
              return (
                <button
                  aria-pressed={isSelected}
                  className={`relative flex min-h-[60px] flex-col items-stretch justify-start p-1 text-left align-top transition-colors motion-reduce:transition-none md:min-h-[150px] md:p-2 ${LANDING_FOCUS} ${
                    day.inMonth ? "bg-white text-slate-900 hover:bg-slate-50" : "bg-slate-50/60 text-slate-300 hover:bg-slate-100"
                  } ${isSelected ? "ring-2 ring-inset ring-[#08111f]" : ""}`}
                  disabled={!date}
                  key={date ?? `empty-${index}`}
                  onClick={() => date && setSelectedDate(date)}
                  type="button"
                >
                  {/* Today: a 2px navy rule along the top of the cell — the day number stays unfilled. */}
                  {isToday ? <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-[#08111f]" /> : null}
                  <span className="flex items-center justify-between gap-1">
                    <span
                      className={`flex h-6 min-w-6 items-center justify-center text-xs tabular-nums ${isToday ? "font-black" : "font-bold"} ${
                        day.inMonth ? LANDING_INK : ""
                      }`}
                    >
                      {date ? Number(date.slice(8, 10)) : ""}
                    </span>
                    {dayConflicts.length > 0 ? (
                      <span className="text-phx-xs font-bold tabular-nums text-sky-700">
                        {dayConflicts.length}
                      </span>
                    ) : null}
                  </span>

                  {/* PHONE: a day column is ~40px wide, too narrow for a name. Below md the cell is a compact
                      square — a green mark for a national vacation and the count of people planned — and the
                      day reads in full in the Selected day details under the grid. */}
                  {dayHolidays.length > 0 || dayPlans.length > 0 ? (
                    <span className="mt-1 flex flex-wrap items-center gap-1 md:hidden">
                      {dayHolidays.length > 0 ? <span aria-hidden="true" className="h-1.5 w-3 bg-emerald-500" /> : null}
                      {dayPlans.length > 0 ? (
                        <span className={`text-phx-xs font-bold tabular-nums ${LANDING_INK}`}>{dayRegions.reduce((total, region) => total + planningTilePeople(region.items).length, 0)}</span>
                      ) : null}
                    </span>
                  ) : null}

                  <span className="mt-1.5 hidden space-y-1 md:block">
                    {dayHolidays.map((holiday) => (
                      <span
                        className="block break-words border-l-2 border-l-emerald-500 pl-1.5 text-phx-sm font-normal leading-tight text-emerald-700 [overflow-wrap:anywhere]"
                        key={holiday.id}
                      >
                        {holiday.title}
                      </span>
                    ))}
                    {dayRegions.map((region) => (
                      <span className="block" key={region.key || "no-region"}>
                        <span className={`block break-words border-b border-slate-200 pb-0.5 text-phx-xs font-bold uppercase tracking-[0.08em] [overflow-wrap:anywhere] ${LANDING_INK}`}>{region.label}</span>
                        <span className="mt-0.5 block space-y-1">
                          {/* Each person once per region; their AM and PM read "AM · PM" (planningTilePeople). */}
                          {planningTilePeople(region.items).map(({ items: personItems, key, slots }) => {
                            const item = personItems[0];
                            const hue = employeeHueFor(dayHues, item.employeeHrId);
                            return (
                              <span
                                className={`block break-words px-1.5 py-0.5 text-phx-sm font-normal leading-tight [overflow-wrap:anywhere] ${planChipTone(item, hue)}`}
                                key={key}
                                title={personItems.map((personItem) => personItem.title).join("\n")}
                              >
                                {item.employeeDisplayName}
                                {slots ? <span className="opacity-70"> · {slots}</span> : null}
                              </span>
                            );
                          })}
                        </span>
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <LandingPanel
          right={<LandingMeta items={[`${selectedDetailRows.length} visible row${selectedDetailRows.length === 1 ? "" : "s"}`]} />}
          title="Selected day"
        >
          <h3 className={`break-words border-b border-slate-200 px-3 py-2.5 text-lg font-bold sm:px-4 ${LANDING_INK}`}>{dayLabel(selectedDate)}</h3>
          <PlanningCalendarDetailsTable hues={selectedDayHues} rows={selectedDetailRows} />
        </LandingPanel>
        </>
        )}
      </section>
    </div>
  );
}

function PlanningCalendarAgenda({
  agendaDays,
  onSelectDate,
}: {
  agendaDays: { date: string; dayItems: PlanningCalendarItem[] }[];
  onSelectDate: (date: string) => void;
}) {
  if (agendaDays.length === 0) {
    return (
      <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <PortalEmptyState title="No planned activities" message="There are no planned activities for this month." />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {agendaDays.map(({ date, dayItems }) => (
        <AgendaDayBlock date={date} dayItems={dayItems} key={date} onSelectDate={onSelectDate} />
      ))}
    </div>
  );
}

// Shared day-block markup used by both the List (agenda) view and the Week view:
// a white day header (the whole row selects the day) plus readable item rows
// (the person's colour, title, meta, status as a coloured word). When `showEmpty` is set, days with no items still render with a
// subtle "No activities" line so the week stays complete.
function AgendaDayBlock({
  date,
  dayItems,
  onSelectDate,
  showEmpty = false,
}: {
  date: string;
  dayItems: PlanningCalendarItem[];
  onSelectDate: (date: string) => void;
  showEmpty?: boolean;
}) {
  const dayHues = assignDailyEmployeeHues(dayItems.filter(isPlanItem));
  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <button
        className={`flex w-full flex-wrap items-center justify-between gap-x-2 gap-y-0.5 border-b border-slate-200 px-3 py-2.5 text-left sm:px-4 ${LANDING_ROW_LINK}`}
        onClick={() => onSelectDate(date)}
        type="button"
      >
        <span className={`flex min-w-0 items-center gap-2 break-words text-sm font-bold ${LANDING_INK}`}>
          <span aria-hidden="true" className="h-0.5 w-3 shrink-0 bg-[#F05A1A]" />
          {dayLabel(date)}
        </span>
        <span className="text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums text-slate-500">
          {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
        </span>
      </button>
      {dayItems.length === 0 ? (
        showEmpty ? (
          <p className="px-3 py-3 text-xs font-bold text-slate-500 sm:px-4">No activities</p>
        ) : null
      ) : (
        <div className="divide-y divide-slate-200">
          {dayItems.map((item) => {
            if (!isPlanItem(item)) {
              return (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 sm:px-4" key={item.id}>
                  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 bg-emerald-500" />
                  <span className={`min-w-0 break-words text-sm font-bold ${LANDING_INK}`}>{item.title}</span>
                  <span className={`ml-auto text-emerald-700 ${statusWordClassName}`}>
                    National vacation
                  </span>
                </div>
              );
            }
            const meta = [item.employeeDisplayName || item.employeeName, item.region, item.area, item.medicalRepDisplayName || item.medicalRepName, item.time].filter(
              (value) => value && value !== "-",
            ) as string[];
            return (
              <div className="px-3 py-3 sm:px-4" key={item.id}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-2.5 w-2.5 shrink-0 ${employeeHueFor(dayHues, item.employeeHrId).dot}`}
                  />
                  <span className={`min-w-0 break-words text-sm font-bold ${LANDING_INK}`}>{item.title}</span>
                  <span className={`ml-auto ${statusWordClassName} ${planStatusInk(item.status)}`}>
                    {planStatusLabels[item.status] ?? item.status}
                  </span>
                </div>
                {meta.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 pl-[18px] text-phx-xs font-semibold text-slate-600">
                    {meta.map((value, index) => (
                      <span
                        className="flex min-w-0 items-center gap-2 break-words"
                        key={`${item.id}-meta-${index}`}
                      >
                        {index > 0 ? <span aria-hidden="true" className="text-slate-300">·</span> : null}
                        {value}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.conflictWarning ? (
                  <p className="mt-1.5 break-words pl-[18px] text-xs font-bold text-sky-700">{item.conflictWarning}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function detailToneClass(tone: PlanningCalendarDetailRow["tone"]) {
  if (tone === "conflict") return "bg-white text-sky-900";
  if (tone === "holiday") return "bg-white text-emerald-900";
  return "bg-white text-slate-800";
}

// The row's status as a coloured word — never a bordered pill.
function statusToneClass(tone: PlanningCalendarDetailRow["tone"]) {
  if (tone === "conflict") return "text-sky-700";
  if (tone === "holiday") return "text-emerald-700";
  return "text-slate-700";
}

function detailAccent(tone: PlanningCalendarDetailRow["tone"]) {
  if (tone === "conflict") return "sky";
  if (tone === "holiday") return "emerald";
  return "slate";
}

// The selected day's rows in the order the details draw them (owner, 2026-10-24: "group them by region
// the area"): national vacations first as their own block, then each region with its areas inside it.
// A chain visit sits in its area ahead of that area's plans.
type DetailRowSection = {
  areas: { key: string; label: string; rows: PlanningCalendarDetailRow[] }[];
  count: number;
  key: string;
  label: string;
  tone: "holiday" | "region";
};

function detailRowSections(rows: PlanningCalendarDetailRow[]): DetailRowSection[] {
  const holidays = rows.filter((row) => row.tone === "holiday");
  const sections: DetailRowSection[] = holidays.length
    ? [{ areas: [{ key: "holiday", label: "", rows: holidays }], count: holidays.length, key: "national-vacation", label: "National vacation", tone: "holiday" }]
    : [];
  const regions = groupPlanItemsByRegion(
    rows.filter((row) => row.tone !== "holiday").map((row) => ({ area: row.groupArea, region: row.groupRegion, row })),
  );
  for (const region of regions) {
    sections.push({
      areas: region.areas.map((area) => ({ key: area.key || "no-area", label: area.label, rows: area.items.map((entry) => entry.row) })),
      count: region.items.length,
      key: `region-${region.key || "none"}`,
      label: region.label,
      tone: "region",
    });
  }
  return sections;
}

// A row with nothing to say in a cell reads "—", not the "-" the rows are built with.
function cellText(value: string) {
  return value === "-" ? "—" : value;
}

function PlanningCalendarDetailsTable({
  hues,
  rows,
}: {
  hues: Map<string, EmployeeHue>;
  rows: PlanningCalendarDetailRow[];
}) {
  const sections = detailRowSections(rows);
  return (
    <div>
      {rows.length === 0 ? (
        <PortalEmptyState
          message="Submitted planning activity, national vacation, and chain visits for the selected day will appear here."
          title="No detail rows for this day"
        />
      ) : (
        <div className="lg:hidden">
          {sections.map((section) => (
            <div key={`${section.key}-mobile`}>
              <p
                className={`flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] sm:px-4 ${
                  section.tone === "holiday" ? "text-emerald-700" : LANDING_INK
                }`}
              >
                <span className="min-w-0 break-words">{section.label}</span>
                <span className="tabular-nums text-slate-500">{section.count}</span>
              </p>
              {section.areas.map((area) => (
                <div key={`${section.key}-${area.key}-mobile`}>
                  {area.label ? (
                    <p className="break-words border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-600 sm:px-4">
                      {area.label}
                    </p>
                  ) : null}
                  <div className="divide-y divide-slate-200 border-b border-slate-200">
                    {area.rows.map((row) => (
                      <PortalRecordCard
                        accent={detailAccent(row.tone)}
                        key={`${row.id}-mobile`}
                        meta={row.employee}
                        status={
                          <span className={`${statusWordClassName} ${statusToneClass(row.tone)}`}>
                            {row.status}
                          </span>
                        }
                        title={row.activity}
                      >
                        <PortalRecordFields
                          fields={[
                            ...(row.medicalRep !== "-" ? [{ label: "Medical rep", value: row.medicalRep }] : []),
                            { label: "Time", value: row.time },
                          ]}
                        />
                        {row.conflictWarning !== "-" ? (
                          <p className="mt-2 break-words border-l-2 border-l-sky-500 pl-2.5 text-xs font-semibold leading-5 text-sky-800">
                            {row.conflictWarning}
                          </p>
                        ) : null}
                        {row.notes !== "-" ? (
                          <p className="mt-2 break-words border-l-2 border-l-slate-300 pl-2.5 text-xs font-semibold leading-5 text-slate-600" dir="auto">
                            {row.notes}
                          </p>
                        ) : null}
                      </PortalRecordCard>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div>
        <PortalDesktopTable
          breakpoint="lg"
          className="text-xs"
          cols={
            <colgroup>
              <col className="w-[20%]" />
              <col className="w-[20%]" />
              <col className="w-[16%]" />
              <col className="w-[10%]" />
              <col className="w-[14%]" />
              <col className="w-[20%]" />
            </colgroup>
          }
        >
          <thead>
            <tr className="border-b border-slate-200 bg-white">
              {["Employee", "Activity", "Medical Rep", "Time", "Plan Status", "Chain Visit"].map((column) => (
                <th
                  className={`border-r border-slate-200 px-3 py-3 text-phx-xs font-bold uppercase tracking-[0.12em] last:border-r-0 ${LANDING_INK}`}
                  key={column}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {sections.flatMap((section) => [
              <tr
                className="bg-white"
                key={`${section.key}-header`}
              >
                <td
                  className={`border-l-2 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] ${
                    section.tone === "holiday" ? "border-l-emerald-500 text-emerald-700" : `border-l-[#08111f] ${LANDING_INK}`
                  }`}
                  colSpan={6}
                >
                  {section.label}
                  <span className="ml-2 font-bold tabular-nums text-slate-500">
                    {section.count} row{section.count === 1 ? "" : "s"}
                  </span>
                </td>
              </tr>,
              ...section.areas.flatMap((area) => [
                ...(area.label
                  ? [
                      <tr className="bg-slate-50" key={`${section.key}-${area.key}-header`}>
                        <td className="px-3 py-1.5 pl-6 text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-600" colSpan={6}>
                          {area.label}
                        </td>
                      </tr>,
                    ]
                  : []),
                ...area.rows.map((row) => (
                <tr className={`transition-colors hover:bg-slate-50 motion-reduce:transition-none ${detailToneClass(row.tone)}`} key={row.id}>
                  <td className={`break-words border-r border-slate-200 px-3 py-2.5 font-bold ${LANDING_INK}`}>
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 ${employeeHueFor(hues, row.employeeHrId).dot}`} />
                      {row.employee}
                    </span>
                  </td>
                  <td className="break-words border-r border-slate-200 px-3 py-2.5 font-semibold">{row.activity}</td>
                  <td className="break-words border-r border-slate-200 px-3 py-2.5 font-semibold text-slate-600">{cellText(row.medicalRep)}</td>
                  <td className="break-words border-r border-slate-200 px-3 py-2.5 font-semibold text-slate-600">{row.time}</td>
                  <td className="border-r border-slate-200 px-3 py-2.5">
                    <span className={`inline-block max-w-full leading-snug ${statusWordClassName} ${statusToneClass(row.tone)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="break-words px-3 py-2.5 text-phx-xs font-semibold leading-relaxed text-sky-800">{cellText(row.conflictWarning)}</td>
                </tr>
                )),
              ]),
            ])}
          </tbody>
        </PortalDesktopTable>
      </div>
    </div>
  );
}
