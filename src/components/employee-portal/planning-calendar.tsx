"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Filter,
  Search,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
} from "@/components/employee-portal/portal-primitives";
import type {
  PlanningCalendarConflict,
  PlanningCalendarItem,
  PlanningCalendarPlanItem,
  PlanningCalendarWorkspace,
} from "@/lib/weekly-planning/calendar";
import { SearchableSelect } from "@/components/ui/searchable-select";


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
  return new Date().toISOString().slice(0, 10);
}

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
    item.employeeName,
    item.employeeHrId,
    item.activityTitle,
    item.region,
    item.area,
    item.medicalRepName,
    item.lineName,
    item.status,
  ]
    .join(" ")
    .toLowerCase();
}

// Left-accent-bar tone per activity type, used by the month-grid pills. Kept as a
// single className string (border-l accent + tint + text) so the color coding stays
// aligned with the same activity semantics used in the List/Week agenda dots.
function planTone(item: PlanningCalendarPlanItem) {
  if (item.conflictWarning) {
    return "border-red-500 bg-red-100 text-red-900";
  }
  if (item.activityTitle === "Coaching") {
    return "border-violet-500 bg-violet-100 text-violet-900";
  }
  if (item.activityTitle === "Double Visit") {
    return "border-blue-500 bg-blue-100 text-blue-900";
  }
  if (item.activityTitle === "Training") {
    return "border-amber-500 bg-amber-100 text-amber-900";
  }
  return "border-slate-400 bg-slate-100 text-slate-900";
}

const statCardTones = {
  emerald: { badge: "bg-emerald-600", border: "border-emerald-500", tint: "bg-emerald-50", value: "text-emerald-700" },
  orange: { badge: "bg-orange-600", border: "border-orange-500", tint: "bg-orange-50", value: "text-orange-700" },
  rose: { badge: "bg-rose-600", border: "border-rose-500", tint: "bg-rose-50", value: "text-rose-700" },
  slate: { badge: "bg-slate-800", border: "border-slate-500", tint: "bg-slate-100", value: "text-slate-900" },
} as const;

function PlanningStatCard({
  accent,
  icon: Icon,
  label,
  value,
}: {
  accent: keyof typeof statCardTones;
  icon: LucideIcon;
  label: string;
  value: ReactNode;
}) {
  const tone = statCardTones[accent];
  return (
    <div className={`flex items-center gap-3 border-l-4 px-4 py-3.5 shadow-sm ${tone.border} ${tone.tint}`}>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center text-white shadow-sm ${tone.badge}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
        <p className={`text-2xl font-black leading-none ${tone.value}`}>{value}</p>
      </div>
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
}: {
  initialWorkspace: PlanningCalendarWorkspace;
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
  const regionOptions = useMemo(() => uniqueSorted(planItems.map((item) => item.region)), [planItems]);

  const filteredPlanItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return planItems.filter((item) => {
      if (activityFilter !== allValue && item.activityTitle !== activityFilter) return false;
      if (regionFilter !== allValue && item.region !== regionFilter) return false;
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
  const selectedConflicts = conflictForDay(conflicts, selectedDate);
  const selectedDetailRows: PlanningCalendarDetailRow[] = [
    ...selectedConflicts.map((conflict) => ({
      activity: "Conflict warning",
      area: conflict.areaNames.join(", ") || "-",
      conflictWarning: conflict.warning,
      date: conflict.date,
      employee: conflict.employeeNames.join(", ") || "-",
      id: conflict.id,
      medicalRep: conflict.medicalRepName || conflict.medicalRepHrId || "-",
      notes: conflict.lineName ? `Line: ${conflict.lineName}` : "-",
      regionLocation: conflict.regionNames.join(", ") || conflict.lineName || "-",
      status: "Conflict",
      time: "Full day",
      tone: "conflict" as const,
    })),
    ...selectedHolidays.map((holiday) => ({
      activity: holiday.title,
      area: "-",
      conflictWarning: "-",
      date: selectedDate,
      employee: "Company calendar",
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
      id: item.id,
      medicalRep: item.medicalRepDisplayName || item.medicalRepName || item.medicalRepHrId || "-",
      notes: item.notes || "-",
      regionLocation: item.region || item.lineName || "-",
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
    const now = new Date();
    setSelectedDate(todayIso());
    setMessage(null);
    startTransition(async () => {
      try {
        await loadMonth(now.getUTCFullYear(), now.getUTCMonth() + 1, todayIso());
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
    <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Planning calendar results are capped at {workspace.headerLimit} headers and {workspace.itemLimit} plan rows. Loaded {workspace.loadedHeaderCount} headers and {workspace.loadedItemCount} rows; narrow the month before using this view for a full audit.
      </span>
    </div>
  ) : null;

  return (
    <div className="space-y-5">
      {!workspace.schemaReady ? (
        <div className="border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
          Planning calendar data is not ready. National vacations are still shown.
        </div>
      ) : null}
      {cappedResultsBanner}

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-4 border-b border-slate-200 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 border border-orange-200 bg-orange-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-orange-700">
                <Sparkles className="h-3.5 w-3.5" />
                Shared Planning Calendar
              </span>
              {summary.conflictCount > 0 ? (
                <span className="inline-flex items-center gap-1 border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-red-700">
                  <TriangleAlert className="h-3.5 w-3.5" />
                  {summary.conflictCount} warnings
                </span>
              ) : null}
            </div>
            <h2 className="mt-2 text-2xl font-black text-slate-950">{monthLabel(year, month)}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex border border-slate-200 bg-slate-100 p-0.5">
              {(["month", "week", "list"] as const).map((mode) => (
                <button
                  className={`h-9 px-3.5 text-xs font-black uppercase tracking-[0.1em] transition-colors ${
                    viewMode === mode ? "bg-orange-500 text-white shadow-sm" : "text-slate-600 hover:bg-white"
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
              className="inline-flex h-10 w-10 items-center justify-center border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              disabled={isPending}
              onClick={() => shiftMonth(-1)}
              type="button"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <Button disabled={isPending} onClick={goToday} variant="secondary">
              Today
            </Button>
            <button
              aria-label="Next month"
              className="inline-flex h-10 w-10 items-center justify-center border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              disabled={isPending}
              onClick={() => shiftMonth(1)}
              type="button"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <PlanningStatCard accent="orange" icon={CalendarDays} label="Plan entries" value={summary.planCount} />
          <PlanningStatCard accent="slate" icon={Users} label="Planning owners" value={summary.submittedOwnerCount} />
          <PlanningStatCard accent="rose" icon={ShieldAlert} label="Same-line warnings" value={summary.conflictCount} />
          <PlanningStatCard accent="emerald" icon={Sparkles} label="National vacations" value={summary.holidayCount} />
        </div>
      </section>

      {message ? (
        <div className="border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">{message}</div>
      ) : null}

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-3 p-4 lg:grid-cols-[minmax(180px,1fr)_minmax(160px,220px)_minmax(160px,220px)_auto_auto] lg:items-end">
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full border border-slate-200 bg-white px-3 pl-9 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Employee, area, rep"
                value={query}
              />
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Activity</span>
            <SearchableSelect
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
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
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Region</span>
            <SearchableSelect
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              onChange={(event) => setRegionFilter(event.target.value)}
              value={regionFilter}
            >
              <option value={allValue}>All regions</option>
              {regionOptions.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <button
            className={`inline-flex h-10 items-center justify-center gap-2 border px-3 text-sm font-black ${
              conflictsOnly
                ? "border-red-300 bg-red-50 text-red-800"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
            onClick={() => setConflictsOnly((value) => !value)}
            type="button"
          >
            <TriangleAlert className="h-4 w-4" />
            Conflicts
          </button>
          <Button onClick={resetFilters} variant="secondary">
            <Filter className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
      </section>

      {conflicts.length > 0 ? (
        <section className="space-y-2 border border-red-200 bg-red-50 p-4 text-red-900">
          <div className="flex items-center gap-2 text-sm font-black">
            <TriangleAlert className="h-4 w-4" />
            Same-line Medical Rep warnings
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {conflicts.slice(0, 4).map((conflict) => (
              <button
                className="border border-red-200 bg-white/80 p-3 text-left text-xs font-semibold text-red-900 hover:bg-white"
                key={conflict.id}
                onClick={() => setSelectedDate(conflict.date)}
                type="button"
              >
                <p className="font-black">{dayLabel(conflict.date)}</p>
                <p className="mt-1">{conflict.warning}</p>
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
            <div className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-4 py-2.5">
              <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Week of</span>
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
        <div className="overflow-hidden border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-7 border-b-2 border-orange-500 bg-slate-900">
            {weekdays.map((weekday) => (
              <div className="px-2 py-2.5 text-center text-[10px] font-black uppercase tracking-[0.14em] text-slate-300" key={weekday}>
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {weeks.flat().map((day, index) => {
              const date = day.date;
              const dayItems = date ? itemsByDay.get(date) ?? [] : [];
              // National Vacation plan items are excluded from the month-grid block list:
              // the holiday overlay below already shows the day is a national vacation for
              // everyone, so a redundant per-person block reads as "still doing something
              // that day" instead of correctly disappearing into the holiday. The plan row
              // itself is untouched (still visible in List/Week views and the Selected-day
              // detail table) — this only hides it from the compact month grid.
              const dayPlans = dayItems.filter(isPlanItem).filter((item) => item.activityTitle !== "National Vacation");
              const dayHolidays = dayItems.filter((item) => item.source === "holiday");
              const dayConflicts = date ? conflictForDay(conflicts, date) : [];
              const isSelected = date === selectedDate;
              const isToday = date === today;
              return (
                <button
                  className={`min-h-[86px] border-b border-r border-slate-100 p-1.5 text-left transition sm:min-h-[150px] ${
                    isToday ? "bg-orange-50" : day.inMonth ? "bg-white" : "bg-slate-50"
                  } ${isSelected ? "ring-2 ring-inset ring-orange-500" : "hover:bg-orange-50/40"}`}
                  disabled={!date}
                  key={date ?? `empty-${index}`}
                  onClick={() => date && setSelectedDate(date)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`flex h-6 w-6 items-center justify-center border text-xs font-black transition-colors ${
                        isToday ? "border-orange-600 bg-orange-600 text-white shadow-sm" : "border-transparent text-slate-700"
                      }`}
                    >
                      {date ? Number(date.slice(8, 10)) : ""}
                    </span>
                    {dayConflicts.length > 0 ? (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center border border-red-200 bg-red-50 px-1 text-[10px] font-black text-red-700">
                        {dayConflicts.length}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-1.5 hidden space-y-1.5 sm:block">
                    {dayHolidays.slice(0, 1).map((holiday) => (
                      <div
                        className="border-l-4 border-emerald-500 bg-emerald-100 px-2 py-1 text-[10px] font-black text-emerald-900 shadow-sm"
                        key={holiday.id}
                      >
                        <p className="line-clamp-2 break-words leading-snug">{holiday.title}</p>
                      </div>
                    ))}
                    {dayPlans.slice(0, 3).map((item) => (
                      <div
                        className={`border-l-4 px-2 py-1 shadow-sm transition-shadow hover:shadow ${planTone(item)}`}
                        key={item.id}
                        title={item.title}
                      >
                        <p className="line-clamp-2 break-words text-[10px] font-black leading-snug">
                          {item.employeeDisplayName}
                        </p>
                      </div>
                    ))}
                    {dayHolidays.length + dayPlans.length > 4 ? (
                      <div className="border-l-4 border-slate-300 bg-slate-50 px-2 py-1 text-[10px] font-black text-slate-500">
                        +{dayHolidays.length + dayPlans.length - 4} more
                      </div>
                    ) : null}
                  </div>

                  <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
                    {dayHolidays.slice(0, 2).map((holiday) => (
                      <span className="h-2 w-2 border border-emerald-500 bg-emerald-500" key={holiday.id} />
                    ))}
                    {dayPlans.slice(0, 4).map((item) => (
                      <span className={`h-2 w-2 border ${item.conflictWarning ? "border-red-600 bg-red-600" : "border-indigo-500 bg-indigo-500"}`} key={item.id} />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <section className="border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Selected day</p>
              <h3 className="mt-1 text-lg font-black text-slate-950">{dayLabel(selectedDate)}</h3>
            </div>
            <span className="border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-600">
              {selectedDetailRows.length} visible row{selectedDetailRows.length === 1 ? "" : "s"}
            </span>
          </div>
          <PlanningCalendarDetailsTable rows={selectedDetailRows} />
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
      <div className="border border-slate-200 bg-white shadow-sm">
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
  return (
    <div className="overflow-hidden border border-slate-200 bg-white shadow-sm">
      <button
        className="flex w-full items-center justify-between gap-2 border-b-2 border-orange-500 bg-slate-900 px-4 py-2.5 text-left transition-colors hover:bg-slate-800"
        onClick={() => onSelectDate(date)}
        type="button"
      >
        <span className="whitespace-nowrap text-sm font-black text-white">{dayLabel(date)}</span>
        <span className="inline-flex whitespace-nowrap bg-orange-500 px-2 py-0.5 text-[11px] font-black text-white">
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
                  <span className="ml-auto inline-flex items-center whitespace-nowrap border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-800">
                    National vacation
                  </span>
                </div>
              );
            }
            const meta = [item.employeeDisplayName || item.employeeName, item.region || item.lineName, item.area, item.medicalRepDisplayName || item.medicalRepName, item.time].filter(
              (value) => value && value !== "-",
            ) as string[];
            return (
              <div className="px-4 py-3" key={item.id}>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${item.conflictWarning ? "bg-red-500" : "bg-indigo-500"}`}
                  />
                  <span className="whitespace-nowrap text-sm font-black text-slate-900">{item.title}</span>
                  <span className="ml-auto inline-flex items-center whitespace-nowrap border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-slate-600">
                    {planStatusLabels[item.status] ?? item.status}
                  </span>
                </div>
                {meta.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                    {meta.map((value, index) => (
                      <span
                        className="inline-flex items-center whitespace-nowrap rounded-sm bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600"
                        key={`${item.id}-meta-${index}`}
                      >
                        {value}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.conflictWarning ? (
                  <p className="mt-1.5 pl-[18px] text-xs font-bold text-red-600">{item.conflictWarning}</p>
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
  if (tone === "conflict") return "bg-red-50/60 text-red-900";
  if (tone === "holiday") return "bg-emerald-50/60 text-emerald-900";
  return "bg-white text-slate-800";
}

function statusToneClass(tone: PlanningCalendarDetailRow["tone"]) {
  if (tone === "conflict") return "border-red-200 bg-red-100 text-red-800";
  if (tone === "holiday") return "border-emerald-200 bg-emerald-100 text-emerald-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function detailAccent(tone: PlanningCalendarDetailRow["tone"]) {
  if (tone === "conflict") return "rose";
  if (tone === "holiday") return "emerald";
  return "slate";
}

function PlanningCalendarDetailsTable({ rows }: { rows: PlanningCalendarDetailRow[] }) {
  return (
    <div className="p-4">
      {rows.length === 0 ? (
        <PortalEmptyState
          message="Submitted planning activity, national vacation, and conflict warnings for the selected day will appear here."
          title="No detail rows for this day"
        />
      ) : (
        <div className="divide-y divide-slate-100 border border-slate-200 bg-white md:hidden">
          {rows.map((row) => (
            <PortalRecordCard
              accent={detailAccent(row.tone)}
              key={`${row.id}-mobile`}
              meta={`${row.date} · ${row.employee}`}
              status={
                <span className={`inline-flex border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${statusToneClass(row.tone)}`}>
                  {row.status}
                </span>
              }
              title={row.activity}
            >
              <PortalRecordFields
                fields={[
                  { label: "Location", value: row.regionLocation },
                  { label: "Area", value: row.area },
                  { label: "Medical rep", value: row.medicalRep },
                  { label: "Time", value: row.time },
                ]}
              />
              {row.conflictWarning ? (
                <p className="mt-2 rounded border border-red-100 bg-red-50 px-2.5 py-2 text-xs font-semibold leading-5 text-red-800">
                  {row.conflictWarning}
                </p>
              ) : null}
              {row.notes ? (
                <p className="mt-2 rounded border border-slate-100 bg-white px-2.5 py-2 text-xs font-semibold leading-5 text-slate-600">
                  {row.notes}
                </p>
              ) : null}
            </PortalRecordCard>
          ))}
        </div>
      )}
      <div className="border border-slate-200 bg-white">
        <PortalDesktopTable className="text-xs" minWidth="1120px">
          <thead>
            <tr className="border-b-2 border-orange-500 bg-slate-950">
              {["Date", "Employee", "Activity", "Region / Location", "Area", "Medical Rep", "Time", "Plan Status", "Conflict Warning"].map((column) => (
                <th
                  className="border-r border-slate-800 px-3 py-3 text-[10px] font-black uppercase tracking-[0.14em] text-slate-300 last:border-r-0"
                  key={column}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
                <tr className={`transition-colors hover:bg-orange-50/40 ${detailToneClass(row.tone)}`} key={row.id}>
                  <td className="border-r border-slate-100 px-3 py-2.5 font-mono text-[11px] font-semibold text-slate-500">{row.date}</td>
                  <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-black text-slate-900">{row.employee}</td>
                  <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-semibold">{row.activity}</td>
                  <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.regionLocation}</td>
                  <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.area}</td>
                  <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.medicalRep}</td>
                  <td className="whitespace-nowrap border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.time}</td>
                  <td className="border-r border-slate-100 px-3 py-2.5">
                    <span className={`inline-flex whitespace-nowrap border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${statusToneClass(row.tone)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="max-w-[260px] px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-red-800">
                    <span className="whitespace-nowrap">{row.conflictWarning}</span>
                  </td>
                </tr>
              ))}
          </tbody>
        </PortalDesktopTable>
      </div>
    </div>
  );
}
