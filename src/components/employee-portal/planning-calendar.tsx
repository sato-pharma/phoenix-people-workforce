"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Sparkles,
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
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const allValue = "__all__";

const planStatusLabels: Record<string, string> = {
  ceo_approved: "CEO approved",
  final_approved: "Final approved",
  hr_acknowledged: "HR acknowledged",
  manager_approved: "Manager approved",
  submitted: "Submitted",
};

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
  { border: "border-l-orange-500", chip: "bg-orange-100 text-orange-700", dot: "bg-orange-500" },
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
    <div className={`rounded-sm border p-4 ${tone === "info" ? "border-sky-100 bg-sky-50/60" : "border-slate-200 bg-slate-50/60"}`}>
      <p className="text-3xl font-black text-slate-950">{value}</p>
      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
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
    <div className="flex items-center gap-3 rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 shadow-sm">
      <TriangleAlert className="h-4 w-4 shrink-0" />
      <span>
        Planning calendar results are capped at {workspace.headerLimit} headers and {workspace.itemLimit} plan rows. Loaded {workspace.loadedHeaderCount} headers and {workspace.loadedItemCount} rows; narrow the month before using this view for a full audit.
      </span>
    </div>
  ) : null;

  return (
    <div className="space-y-5">
      {!workspace.schemaReady ? (
        <div className="flex items-center gap-3 rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 shadow-sm">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          Planning calendar data is not ready. National vacations are still shown.
        </div>
      ) : null}
      {cappedResultsBanner}

      {/* ── Header + Metrics ── */}
      <section className="overflow-hidden rounded-sm bg-white shadow-lg ring-1 ring-slate-200/60">
        <div className="bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-white/80 ring-1 ring-white/20">
                  <Sparkles className="h-3.5 w-3.5" />
                  Shared Planning Calendar
                </span>
                {summary.conflictCount > 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-400/20 px-3 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-sky-100 ring-1 ring-sky-300/30">
                    <Users className="h-3.5 w-3.5" />
                    {summary.conflictCount} chain {summary.conflictCount === 1 ? "visit" : "visits"}
                  </span>
                ) : null}
              </div>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-white">{monthLabel(year, month)}</h2>
              <p className="mt-1 text-sm font-semibold text-slate-300">
                Submitted plan activity, national vacations, and chain visits
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canExport ? (
                <a
                  className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-sm bg-white/10 px-3.5 text-xs font-black uppercase tracking-[0.1em] text-white/80 ring-1 ring-white/20 transition hover:bg-white/20"
                  href={`/api/weekly-plans/calendar/export?year=${year}&month=${month}`}
                  title="Download the detailed plans per user for this month as a styled Excel workbook"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export XLSX
                </a>
              ) : null}
              <div className="inline-flex rounded-sm border border-white/20 bg-white/10 p-0.5">
                {(["month", "week", "list"] as const).map((mode) => (
                  <button
                    className={`h-9 rounded-sm px-3.5 text-xs font-black uppercase tracking-[0.1em] transition-colors ${
                      viewMode === mode ? "bg-slate-900 text-white" : "text-white/70 hover:bg-white/15"
                    }`}
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    type="button"
                  >
                    {mode === "month" ? "Month" : mode === "week" ? "Week" : "List"}
                  </button>
                ))}
              </div>
              <button
                aria-label="Previous month"
                className="inline-flex h-9 w-9 items-center justify-center rounded-sm bg-white/10 text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-40"
                disabled={isPending}
                onClick={() => shiftMonth(-1)}
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                className="h-9 rounded-sm bg-orange-500 px-4 text-sm font-black text-white shadow-md transition hover:bg-orange-400 disabled:opacity-50"
                disabled={isPending}
                onClick={goToday}
                type="button"
              >
                Today
              </button>
              <button
                aria-label="Next month"
                className="inline-flex h-9 w-9 items-center justify-center rounded-sm bg-white/10 text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-40"
                disabled={isPending}
                onClick={() => shiftMonth(1)}
                type="button"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <PlanningMetric label="Plan entries" value={summary.planCount} />
          <PlanningMetric label="Planning owners" value={summary.submittedOwnerCount} />
          <PlanningMetric label="Chain visits" tone={summary.conflictCount > 0 ? "info" : "neutral"} value={summary.conflictCount} />
          <PlanningMetric label="National vacations" value={summary.holidayCount} />
        </div>
      </section>

      {message ? (
        <div className="flex items-center gap-3 rounded-sm border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800 shadow-sm">
          <TriangleAlert className="h-4 w-4 shrink-0" />
          {message}
        </div>
      ) : null}

      {/* ── Filters ── */}
      <section className="overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-slate-200/60">
        <div className="border-b border-slate-100 px-5 py-3">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Filter &amp; Search</p>
        </div>
        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(180px,1fr)_minmax(160px,220px)_minmax(160px,220px)_auto_auto] lg:items-end">
          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full border-0 bg-slate-100 pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-orange-300"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Employee, area, rep"
                value={query}
              />
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Activity</span>
            <SearchableSelect
              className="w-full px-3 ring-1 ring-transparent"
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
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Region</span>
            <SearchableSelect
              className="w-full px-3 ring-1 ring-transparent"
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
            className={`inline-flex h-10 items-center gap-2 rounded-sm px-3 text-sm font-black ring-1 transition ${
              conflictsOnly
                ? "bg-sky-50 text-sky-700 ring-sky-200 hover:bg-sky-100"
                : "bg-slate-100 text-slate-700 ring-slate-200/60 hover:bg-slate-200"
            }`}
            onClick={() => setConflictsOnly((value) => !value)}
            type="button"
          >
            <Users className="h-4 w-4" />
            Chain visits
          </button>
          <button
            className="h-10 rounded-sm bg-slate-100 px-3 text-sm font-black text-slate-600 ring-1 ring-slate-200/60 transition hover:bg-slate-200"
            onClick={resetFilters}
            type="button"
          >
            Reset
          </button>
        </div>
      </section>

      {conflicts.length > 0 ? (
        <section className="overflow-hidden rounded-sm border-l-4 border-l-sky-500 bg-white shadow-md ring-1 ring-slate-200/60">
          <div className="border-b border-slate-100 px-5 py-3">
            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-sky-700">
              {conflicts.length} Chain Visit{conflicts.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {conflicts.slice(0, 8).map((conflict) => (
              <button
                className="flex w-full flex-col gap-1 px-5 py-3 text-left transition hover:bg-orange-50/40"
                key={conflict.id}
                onClick={() => setSelectedDate(conflict.date)}
                type="button"
              >
                <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-wide text-sky-700">{dayLabel(conflict.date)}</span>
                <span className="text-sm font-semibold text-slate-800">{conflict.warning}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-5">
        {viewMode === "list" ? (
          <PlanningCalendarAgenda agendaDays={agendaDays} onSelectDate={setSelectedDate} />
        ) : viewMode === "week" ? (
          <div className="space-y-3">
            <div className={`flex flex-wrap items-center justify-between gap-2 rounded-sm border border-slate-200 bg-slate-50 px-4 py-2.5 ${adminSoftDepthClassName}`}>
              <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Week of</span>
              <span className="whitespace-nowrap text-sm font-black text-slate-900">{weekRangeLabel}</span>
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
        <div className="overflow-hidden rounded-sm bg-white shadow-lg ring-1 ring-slate-200/60">
          {/* FRIDAY is the only narrow column. Friday is off for everyone
              (isFieldWorkforceFriday, unconditional), but SATURDAY is a full working day
              for the Medical Rep / District Manager population this calendar plans for —
              their weekend is Friday-only (isFieldWorkforceFridayOnlyTitle), and the week
              runs Sat-Wed full days. Saturday therefore carries real plan chips and must
              get an equal 1fr share like Sun-Thu; only Friday shrinks. Keep this template
              identical on the header row and the day grid below or the columns misalign. */}
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)] border-b-2 border-orange-500 bg-slate-900">
            {weekdays.map((weekday) => (
              <div className="px-2 py-2.5 text-center text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-300" key={weekday}>
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)] divide-x divide-y divide-slate-100">
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
                  className={`min-h-[86px] bg-white p-2 text-left align-top transition-colors sm:min-h-[150px] ${
                    day.inMonth ? "text-slate-900 hover:bg-orange-50/50" : "bg-slate-50/40 text-slate-300 hover:bg-orange-50/20"
                  } ${isSelected ? "ring-2 ring-inset ring-orange-400" : ""}`}
                  disabled={!date}
                  key={date ?? `empty-${index}`}
                  onClick={() => date && setSelectedDate(date)}
                  type="button"
                >
                  <span className="flex items-center justify-between gap-1">
                    <span
                      className={`flex h-6 w-6 items-center justify-center text-xs font-black ${
                        isToday ? "rounded-full bg-orange-500 text-white" : "text-slate-700"
                      }`}
                    >
                      {date ? Number(date.slice(8, 10)) : ""}
                    </span>
                    {dayConflicts.length > 0 ? (
                      <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-phx-2xs font-black text-sky-700">
                        {dayConflicts.length}
                      </span>
                    ) : null}
                  </span>

                  <span className="mt-1.5 block space-y-1">
                    {dayHolidays.map((holiday) => (
                      <span
                        className="block whitespace-nowrap rounded bg-emerald-100 px-1.5 py-0.5 text-phx-2xs font-normal text-emerald-700"
                        key={holiday.id}
                      >
                        {holiday.title}
                      </span>
                    ))}
                    {dayRegions.map((region) => (
                      <span className="block" key={region.key || "no-region"}>
                        <span className="block bg-slate-900 px-1.5 py-0.5 text-phx-3xs font-semibold uppercase tracking-wider text-slate-300">{region.label}</span>
                        <span className="mt-0.5 block space-y-1">
                          {/* Each person once per region; their AM and PM read "AM · PM" (planningTilePeople). */}
                          {planningTilePeople(region.items).map(({ items: personItems, key, slots }) => {
                            const item = personItems[0];
                            const hue = employeeHueFor(dayHues, item.employeeHrId);
                            return (
                              <span
                                className={`block whitespace-nowrap rounded px-1.5 py-0.5 text-phx-2xs font-normal leading-tight ${planChipTone(item, hue)}`}
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

        <section className="overflow-hidden rounded-sm bg-white shadow-lg ring-1 ring-slate-200/60">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
            <div>
              <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Selected day</p>
              <h3 className="mt-1 text-lg font-black text-slate-950">{dayLabel(selectedDate)}</h3>
            </div>
            <span className="rounded-full bg-phx-paper px-4 py-1.5 text-xs font-black text-phx-ink-soft">
              {selectedDetailRows.length} visible row{selectedDetailRows.length === 1 ? "" : "s"}
            </span>
          </div>
          <PlanningCalendarDetailsTable hues={selectedDayHues} rows={selectedDetailRows} />
        </section>
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
      <div className="overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-slate-200/60">
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
// a slate-900 day header bar plus readable item rows (colored dot, title, meta
// chips, status). When `showEmpty` is set, days with no items still render with a
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
    <div className="overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-slate-200/60">
      <button
        className="flex w-full items-center justify-between gap-2 bg-slate-900 px-4 py-2.5 text-left transition-colors hover:bg-slate-800"
        onClick={() => onSelectDate(date)}
        type="button"
      >
        <span className="whitespace-nowrap text-sm font-black text-white">{dayLabel(date)}</span>
        <span className="whitespace-nowrap text-phx-xs font-bold text-slate-300">
          {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
        </span>
      </button>
      {dayItems.length === 0 ? (
        showEmpty ? (
          <p className="px-4 py-3 text-xs font-bold text-slate-400">No activities</p>
        ) : null
      ) : (
        <div className="divide-y divide-slate-100">
          {dayItems.map((item) => {
            if (!isPlanItem(item)) {
              return (
                <div className="flex items-center gap-2 px-4 py-3" key={item.id}>
                  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                  <span className="whitespace-nowrap text-sm font-black text-slate-900">{item.title}</span>
                  <span className="ml-auto inline-flex items-center whitespace-nowrap rounded-full bg-phx-ok-bg px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-phx-ok">
                    National vacation
                  </span>
                </div>
              );
            }
            const meta = [item.employeeDisplayName || item.employeeName, item.region, item.area, item.medicalRepDisplayName || item.medicalRepName, item.time].filter(
              (value) => value && value !== "-",
            ) as string[];
            return (
              <div className="px-4 py-3" key={item.id}>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${employeeHueFor(dayHues, item.employeeHrId).dot}`}
                  />
                  <span className="whitespace-nowrap text-sm font-black text-slate-900">{item.title}</span>
                  <span className="ml-auto inline-flex items-center whitespace-nowrap rounded-full bg-phx-paper px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-phx-ink-soft">
                    {planStatusLabels[item.status] ?? item.status}
                  </span>
                </div>
                {meta.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                    {meta.map((value, index) => (
                      <span
                        className="inline-flex items-center whitespace-nowrap rounded-sm bg-slate-50 px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600"
                        key={`${item.id}-meta-${index}`}
                      >
                        {value}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.conflictWarning ? (
                  <p className="mt-1.5 pl-[18px] text-xs font-bold text-sky-700">{item.conflictWarning}</p>
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
  if (tone === "conflict") return "bg-sky-50/60 text-sky-900";
  if (tone === "holiday") return "bg-emerald-50/60 text-emerald-900";
  return "bg-white text-slate-800";
}

function statusToneClass(tone: PlanningCalendarDetailRow["tone"]) {
  if (tone === "conflict") return "border-sky-200 bg-sky-100 text-sky-800";
  if (tone === "holiday") return "border-emerald-200 bg-emerald-100 text-emerald-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
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
    <div className="p-4">
      {rows.length === 0 ? (
        <PortalEmptyState
          message="Submitted planning activity, national vacation, and chain visits for the selected day will appear here."
          title="No detail rows for this day"
        />
      ) : (
        <div className={`border border-slate-200 bg-white lg:hidden ${adminSoftDepthClassName}`}>
          {sections.map((section) => (
            <div key={`${section.key}-mobile`}>
              <p
                className={`flex items-center justify-between gap-2 px-4 py-2 text-phx-xs font-black uppercase tracking-[0.14em] ${
                  section.tone === "holiday" ? "bg-emerald-50 text-emerald-800" : "bg-slate-900 text-white"
                }`}
              >
                <span>{section.label}</span>
                <span className={section.tone === "holiday" ? "text-emerald-700" : "text-slate-300"}>{section.count}</span>
              </p>
              {section.areas.map((area) => (
                <div key={`${section.key}-${area.key}-mobile`}>
                  {area.label ? (
                    <p className="border-b border-slate-200 bg-slate-100 px-4 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-600">
                      {area.label}
                    </p>
                  ) : null}
                  <div className="divide-y divide-slate-100">
                    {area.rows.map((row) => (
                      <PortalRecordCard
                        accent={detailAccent(row.tone)}
                        key={`${row.id}-mobile`}
                        meta={row.employee}
                        status={
                          <span className={`inline-flex border px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] ${statusToneClass(row.tone)}`}>
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
                          <p className="mt-2 border border-sky-100 bg-sky-50 px-2.5 py-2 text-xs font-semibold leading-5 text-sky-800">
                            {row.conflictWarning}
                          </p>
                        ) : null}
                        {row.notes !== "-" ? (
                          <p className="mt-2 border border-slate-100 bg-white px-2.5 py-2 text-xs font-semibold leading-5 text-slate-600">
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
      <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
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
            <tr className="border-b-2 border-orange-500 bg-slate-950">
              {["Employee", "Activity", "Medical Rep", "Time", "Plan Status", "Chain Visit"].map((column) => (
                <th
                  className="border-r border-slate-800 px-3 py-3 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-300 last:border-r-0"
                  key={column}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sections.flatMap((section) => [
              <tr
                className={section.tone === "holiday" ? "bg-emerald-50" : "bg-slate-900"}
                key={`${section.key}-header`}
              >
                <td
                  className={`px-3 py-2 text-phx-xs font-black uppercase tracking-[0.14em] ${
                    section.tone === "holiday" ? "text-emerald-800" : "text-white"
                  }`}
                  colSpan={6}
                >
                  {section.label}
                  <span className={`ml-2 font-bold ${section.tone === "holiday" ? "text-emerald-700" : "text-slate-300"}`}>
                    {section.count} row{section.count === 1 ? "" : "s"}
                  </span>
                </td>
              </tr>,
              ...section.areas.flatMap((area) => [
                ...(area.label
                  ? [
                      <tr className="bg-slate-100" key={`${section.key}-${area.key}-header`}>
                        <td className="px-3 py-1.5 pl-6 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-600" colSpan={6}>
                          {area.label}
                        </td>
                      </tr>,
                    ]
                  : []),
                ...area.rows.map((row) => (
                <tr className={`transition-colors hover:bg-orange-50/40 ${detailToneClass(row.tone)}`} key={row.id}>
                  <td className="break-words border-r border-slate-100 px-3 py-2.5 font-black text-slate-900">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`inline-block h-2 w-2 shrink-0 ${employeeHueFor(hues, row.employeeHrId).dot}`} />
                      {row.employee}
                    </span>
                  </td>
                  <td className="break-words border-r border-slate-100 px-3 py-2.5 font-semibold">{row.activity}</td>
                  <td className="break-words border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{cellText(row.medicalRep)}</td>
                  <td className="break-words border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.time}</td>
                  <td className="border-r border-slate-100 px-3 py-2.5">
                    <span className={`inline-block max-w-full break-words border px-2 py-0.5 text-phx-2xs font-black uppercase leading-snug tracking-[0.1em] ${statusToneClass(row.tone)}`}>
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
