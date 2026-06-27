"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { PaginationControls } from "@/components/ui/pagination-controls";
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

function planTone(item: PlanningCalendarPlanItem) {
  if (item.conflictWarning) {
    return "border-red-200 bg-red-50 text-red-800";
  }
  if (item.activityTitle === "Coaching") {
    return "border-violet-200 bg-violet-50 text-violet-800";
  }
  if (item.activityTitle === "Double Visit") {
    return "border-blue-200 bg-blue-50 text-blue-800";
  }
  if (item.activityTitle === "Training") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  return "border-slate-200 bg-white text-slate-800";
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
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
      employee: item.employeeName,
      id: item.id,
      medicalRep: item.medicalRepName || item.medicalRepHrId || "-",
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
            <h2 className="mt-2 text-xl font-black text-slate-950 sm:text-2xl">{monthLabel(year, month)}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
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
          <Metric icon={<CalendarDays className="h-5 w-5" />} label="Plan entries" value={summary.planCount} />
          <Metric icon={<Users className="h-5 w-5" />} label="Planning owners" value={summary.submittedOwnerCount} />
          <Metric icon={<ShieldAlert className="h-5 w-5" />} label="Same-line warnings" tone="red" value={summary.conflictCount} />
          <Metric icon={<Sparkles className="h-5 w-5" />} label="National vacations" tone="green" value={summary.holidayCount} />
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
        <div className="overflow-hidden border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {weekdays.map((weekday) => (
              <div className="px-2 py-2 text-center text-[10px] font-black uppercase tracking-[0.14em] text-slate-500" key={weekday}>
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {weeks.flat().map((day, index) => {
              const date = day.date;
              const dayItems = date ? itemsByDay.get(date) ?? [] : [];
              const dayPlans = dayItems.filter(isPlanItem);
              const dayHolidays = dayItems.filter((item) => item.source === "holiday");
              const dayConflicts = date ? conflictForDay(conflicts, date) : [];
              const isSelected = date === selectedDate;
              const isToday = date === today;
              return (
                <button
                  className={`min-h-[64px] border-b border-r border-slate-100 p-1.5 text-left transition sm:min-h-[138px] ${
                    day.inMonth ? "bg-white" : "bg-slate-50"
                  } ${isSelected ? "ring-2 ring-inset ring-orange-500" : "hover:bg-orange-50/40"}`}
                  disabled={!date}
                  key={date ?? `empty-${index}`}
                  onClick={() => date && setSelectedDate(date)}
                  type="button"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`flex h-6 w-6 items-center justify-center border text-xs font-black ${
                        isToday ? "border-orange-600 bg-orange-600 text-white" : "border-transparent text-slate-700"
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

                  <div className="mt-1 hidden space-y-1 sm:block">
                    {dayHolidays.slice(0, 1).map((holiday) => (
                      <div className="truncate border border-emerald-200 bg-emerald-50 px-1.5 py-1 text-[10px] font-black text-emerald-800" key={holiday.id}>
                        {holiday.title}
                      </div>
                    ))}
                    {dayPlans.slice(0, 3).map((item) => (
                      <div className={`truncate border px-1.5 py-1 text-[10px] font-bold ${planTone(item)}`} key={item.id}>
                        {item.title}
                      </div>
                    ))}
                    {dayItems.length > 4 ? (
                      <div className="px-1 text-[10px] font-black text-slate-500">+{dayItems.length - 4} more</div>
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
              <h3 className="mt-1 text-base font-black text-slate-950 sm:text-lg">{dayLabel(selectedDate)}</h3>
            </div>
            <span className="border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-600">
              {selectedDetailRows.length} visible row{selectedDetailRows.length === 1 ? "" : "s"}
            </span>
          </div>
          <PlanningCalendarDetailsTable resetKey={selectedDate} rows={selectedDetailRows} />
        </section>
      </section>
    </div>
  );
}

function Metric({
  icon,
  label,
  tone = "slate",
  value,
}: {
  icon: ReactNode;
  label: string;
  tone?: "green" | "red" | "slate";
  value: number;
}) {
  const toneClass =
    tone === "red"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "green"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-slate-200 bg-slate-50 text-slate-800";
  return (
    <div className={`border p-3 ${toneClass}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[11px] font-black uppercase tracking-[0.14em]">{label}</span>
      </div>
      <p className="mt-2 text-lg font-bold sm:text-2xl">{value}</p>
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

const PLANNING_DETAILS_PAGE_SIZE = 25;

function PlanningCalendarDetailsTable({ resetKey, rows }: { resetKey: string; rows: PlanningCalendarDetailRow[] }) {
  const [page, setPage] = useState(0);

  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setPage(0);
  }

  const pageRows = rows.slice(
    page * PLANNING_DETAILS_PAGE_SIZE,
    (page + 1) * PLANNING_DETAILS_PAGE_SIZE,
  );

  return (
    <div className="p-4">
      <div className="hidden overflow-x-auto border border-slate-200 bg-white md:block">
        <table className="w-full min-w-[1180px] border-collapse text-left text-xs">
          <thead>
            <tr className="bg-slate-950">
              {["Date", "Employee", "Activity", "Region / Location", "Area", "Medical Rep", "Time", "Plan Status", "Conflict Warning", "Notes"].map((column) => (
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
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-10 text-center text-sm font-semibold text-slate-400" colSpan={10}>
                  No submitted planning activity, national vacation, or conflict warning for this day.
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr className={`transition-colors hover:bg-orange-50/40 ${detailToneClass(row.tone)}`} key={row.id}>
                  <td className="border-r border-slate-100 px-3 py-2.5 font-mono text-[11px] font-semibold text-slate-500">{row.date}</td>
                  <td className="max-w-[180px] truncate border-r border-slate-100 px-3 py-2.5 font-black text-slate-900">{row.employee}</td>
                  <td className="max-w-[170px] truncate border-r border-slate-100 px-3 py-2.5 font-semibold">{row.activity}</td>
                  <td className="max-w-[190px] truncate border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.regionLocation}</td>
                  <td className="max-w-[150px] truncate border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.area}</td>
                  <td className="max-w-[170px] truncate border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.medicalRep}</td>
                  <td className="max-w-[100px] truncate border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-600">{row.time}</td>
                  <td className="border-r border-slate-100 px-3 py-2.5">
                    <span className={`inline-flex max-w-[150px] truncate border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${statusToneClass(row.tone)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="max-w-[260px] border-r border-slate-100 px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-red-800">
                    <span className="line-clamp-2">{row.conflictWarning}</span>
                  </td>
                  <td className="max-w-[260px] px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-slate-500">
                    <span className="line-clamp-2">{row.notes}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 border border-slate-200 bg-white p-3 md:hidden">
        {rows.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm font-semibold text-slate-400">
            No submitted planning activity, national vacation, or conflict warning for this day.
          </p>
        ) : (
          pageRows.map((row) => (
            <div className={`border border-slate-200 p-3 ${detailToneClass(row.tone)}`} key={`${row.id}-mobile`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-[11px] font-semibold text-slate-500">{row.date}</p>
                  <p className="mt-1 truncate font-black text-slate-900">{row.employee}</p>
                  <p className="mt-0.5 truncate text-xs font-semibold">{row.activity}</p>
                </div>
                <span className={`inline-flex shrink-0 truncate border px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] ${statusToneClass(row.tone)}`}>
                  {row.status}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <p className="text-slate-600">
                  Region: <span className="font-bold text-slate-900">{row.regionLocation}</span>
                </p>
                <p className="text-slate-600">
                  Area: <span className="font-bold text-slate-900">{row.area}</span>
                </p>
                <p className="text-slate-600">
                  Rep: <span className="font-bold text-slate-900">{row.medicalRep}</span>
                </p>
                <p className="text-slate-600">
                  Time: <span className="font-bold text-slate-900">{row.time}</span>
                </p>
              </div>
              {row.conflictWarning ? (
                <p className="mt-2 text-[11px] font-semibold leading-relaxed text-red-800">{row.conflictWarning}</p>
              ) : null}
              {row.notes ? (
                <p className="mt-2 text-[11px] font-semibold leading-relaxed text-slate-500">{row.notes}</p>
              ) : null}
            </div>
          ))
        )}
      </div>

      <PaginationControls
        onPageChange={setPage}
        page={page}
        pageSize={PLANNING_DETAILS_PAGE_SIZE}
        total={rows.length}
      />
    </div>
  );
}
