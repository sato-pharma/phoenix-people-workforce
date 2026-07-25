"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { PlanningCalendarItem, PlanningCalendarPlanItem, PlanningCalendarWorkspace } from "@/lib/weekly-planning/calendar";

const allValue = "__all__";
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthDateIso(year: number, month: number, day = 1) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const validDay = Math.min(Math.max(day, 1), lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(validDay).padStart(2, "0")}`;
}

function lastDayInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
  }).format(new Date(`${value}T00:00:00Z`));
}

function itemOccursOn(item: PlanningCalendarItem, date: string) {
  return item.startDate <= date && date <= item.endDate;
}

function isPlanItem(item: PlanningCalendarItem): item is PlanningCalendarPlanItem {
  return item.source === "plan";
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function planTitle(item: PlanningCalendarPlanItem) {
  return item.activityTitle || item.title || "Plan";
}

function setSizeWithoutBlank(input: Set<string>) {
  return input.has("") ? input.size - 1 : input.size;
}

export function PrivateCalendarsFilterMap({
  initialWorkspace,
  todayIso: todayIsoProp,
}: {
  initialWorkspace: PlanningCalendarWorkspace;
  /** Today's date as YYYY-MM-DD, computed once on the server to prevent SSR/hydration mismatch. */
  todayIso: string;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selectedDate, setSelectedDate] = useState(todayIsoProp);
  const [nameFilter, setNameFilter] = useState(allValue);
  const [regionFilter, setRegionFilter] = useState(allValue);
  const [lineFilter, setLineFilter] = useState(allValue);
  const [titleFilter, setTitleFilter] = useState(allValue);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const { conflicts, items, month, weeks, year } = workspace;

  const monthStart = useMemo(() => monthDateIso(year, month, 1), [month, year]);
  const monthEnd = useMemo(() => monthDateIso(year, month, lastDayInMonth(year, month)), [month, year]);

  function resetFilters(resetState = true) {
    if (resetState) {
      setNameFilter(allValue);
      setRegionFilter(allValue);
      setLineFilter(allValue);
      setTitleFilter(allValue);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStartDate(monthStart);
    setEndDate(monthEnd);
    setSelectedDate(monthStart);
    resetFilters(false);
    setMessage(null);
  }, [month, monthStart, monthEnd]);

  const visibleItems = useMemo(() => {
    const from = startDate || monthStart;
    const to = endDate || monthEnd;

    return items.filter((item) => {
      if (item.startDate > to || item.endDate < from) return false;

      if (nameFilter !== allValue) {
        if (!isPlanItem(item) || item.employeeName !== nameFilter) return false;
      }

      if (regionFilter !== allValue) {
        if (!isPlanItem(item) || (item.region ?? "") !== regionFilter) return false;
      }

      if (lineFilter !== allValue) {
        if (!isPlanItem(item) || (item.lineName ?? "") !== lineFilter) return false;
      }

      if (titleFilter !== allValue && item.title !== titleFilter) return false;
      return true;
    });
  }, [endDate, items, lineFilter, monthEnd, monthStart, nameFilter, regionFilter, startDate, titleFilter]);

  const nameOptions = useMemo(() => uniqueSorted(items.filter(isPlanItem).map((item) => item.employeeName)), [items]);
  const regionOptions = useMemo(() => uniqueSorted(items.filter(isPlanItem).map((item) => item.region)), [items]);
  const lineOptions = useMemo(() => uniqueSorted(items.filter(isPlanItem).map((item) => item.lineName)), [items]);
  const titleOptions = useMemo(() => uniqueSorted(items.map((item) => item.title)), [items]);

  const planItems = useMemo(() => visibleItems.filter(isPlanItem), [visibleItems]);
  const uniqueLineNames = useMemo(() => new Set(planItems.map((item) => item.lineName ?? "")), [planItems]);
  const uniqueRegionNames = useMemo(() => new Set(planItems.map((item) => item.region ?? "")), [planItems]);

  const filteredConflicts = useMemo(() => {
    const selectedNames = new Set(nameFilter === allValue ? [] : [nameFilter]);
    const selectedRegions = new Set(regionFilter === allValue ? [] : [regionFilter]);
    const selectedLines = new Set(lineFilter === allValue ? [] : [lineFilter]);

    return conflicts.filter((conflict) => {
      if (conflict.date < (startDate || monthStart) || conflict.date > (endDate || monthEnd)) return false;
      if (selectedNames.size > 0 && !conflict.employeeNames.some((name) => selectedNames.has(name))) return false;
      if (selectedRegions.size > 0 && !conflict.regionNames.some((region) => selectedRegions.has(region))) return false;
      if (selectedLines.size > 0 && !selectedLines.has(conflict.lineName)) return false;
      return true;
    });
  }, [conflicts, endDate, lineFilter, monthEnd, monthStart, nameFilter, regionFilter, startDate]);

  const conflictCount = filteredConflicts.length;

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

  const today = todayIsoProp;

  const hasActiveFilter =
    nameFilter !== allValue ||
    regionFilter !== allValue ||
    lineFilter !== allValue ||
    titleFilter !== allValue ||
    startDate !== monthStart ||
    endDate !== monthEnd;

  async function loadMonth(nextYear: number, nextMonth: number, nextSelectedDate: string) {
    const response = await fetch(`/api/weekly-plans/calendar?year=${nextYear}&month=${nextMonth}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      throw new Error(payload.message ?? "Unable to load planning calendar.");
    }

    setWorkspace(payload.data);
    setSelectedDate(nextSelectedDate);
    setStartDate(monthDateIso(nextYear, nextMonth, 1));
    setEndDate(monthDateIso(nextYear, nextMonth, lastDayInMonth(nextYear, nextMonth)));
    setMessage(null);
  }

  function shiftMonth(delta: number) {
    const base = new Date(Date.UTC(year, month - 1 + delta, 1));
    const nextYear = base.getUTCFullYear();
    const nextMonth = base.getUTCMonth() + 1;
    const preferredDay = Number(selectedDate.slice(8, 10)) || 1;

    startTransition(async () => {
      try {
        await loadMonth(nextYear, nextMonth, monthDateIso(nextYear, nextMonth, preferredDay));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load planning calendar.");
      }
    });
  }

  function goToday() {
    const now = new Date();
    const todayMonth = now.getUTCMonth() + 1;
    const todayYear = now.getUTCFullYear();

    startTransition(async () => {
      try {
        await loadMonth(todayYear, todayMonth, now.toISOString().slice(0, 10));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load planning calendar.");
      }
    });
  }

  const metricCards = useMemo(
    () => [
      { icon: <CalendarDays className="h-4 w-4" />, label: "Matched rows", value: visibleItems.length },
      { icon: <CalendarDays className="h-4 w-4" />, label: "Matched plan owners", value: new Set(planItems.map((item) => item.employeeHrId)).size },
      { icon: <CalendarDays className="h-4 w-4" />, label: "Visible regions", value: setSizeWithoutBlank(uniqueRegionNames) },
      { icon: <CalendarDays className="h-4 w-4" />, label: "Visible lines", value: setSizeWithoutBlank(uniqueLineNames) },
      { icon: <CalendarDays className="h-4 w-4" />, label: "Warnings", value: conflictCount },
    ],
    [conflictCount, planItems, uniqueLineNames, uniqueRegionNames, visibleItems],
  );

  return (
    <div className="space-y-5">
      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-4 border-b border-slate-200 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 border border-orange-200 bg-orange-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-orange-700">
                <CalendarDays className="h-3.5 w-3.5" />
                Shared planning map
              </span>
              {conflictCount > 0 ? (
                <span className="inline-flex items-center gap-1 border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-red-700">
                  {conflictCount} warning{conflictCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
            <h2 className="mt-2 text-2xl font-black text-slate-950">{monthLabel(year, month)}</h2>
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

        <div className="grid gap-3 p-4 lg:grid-cols-3 xl:grid-cols-6">
          <Metric icon={<CalendarDays className="h-4 w-4" />} label="Current month" value={monthLabel(year, month)} />
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Start date</span>
            <input
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              max={endDate || monthEnd}
              min={monthStart}
              onChange={(event) => setStartDate(event.target.value || monthStart)}
              type="date"
              value={startDate}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">End date</span>
            <input
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              min={startDate || monthStart}
              max={monthEnd}
              onChange={(event) => setEndDate(event.target.value || monthEnd)}
              type="date"
              value={endDate}
            />
          </label>
          <Metric icon={<CalendarDays className="h-4 w-4" />} label="Selected period" value={`${startDate} to ${endDate}`} />
          <button
            className="inline-flex h-10 items-center justify-center border border-slate-200 bg-slate-50 px-3 text-sm font-black text-slate-700"
            onClick={() => {
              setNameFilter(allValue);
              setRegionFilter(allValue);
              setLineFilter(allValue);
              setTitleFilter(allValue);
              setStartDate(monthStart);
              setEndDate(monthEnd);
              setMessage(null);
            }}
            type="button"
          >
            Reset
          </button>
        </div>
      </section>

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-3 border-b border-slate-200 p-4 lg:grid-cols-5 xl:grid-cols-10">
          <label className="block lg:col-span-2 xl:col-span-2">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Name</span>
            <SearchableSelect
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              onChange={(event) => setNameFilter(event.target.value)}
              value={nameFilter}
            >
              <option value={allValue}>All names</option>
              {nameOptions.map((name) => (
                <option key={`name-${name}`} value={name}>
                  {name}
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
                <option key={`region-${region}`} value={region}>
                  {region}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Line</span>
            <SearchableSelect
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              onChange={(event) => setLineFilter(event.target.value)}
              value={lineFilter}
            >
              <option value={allValue}>All lines</option>
              {lineOptions.map((lineName) => (
                <option key={`line-${lineName}`} value={lineName}>
                  {lineName}
                </option>
              ))}
            </SearchableSelect>
          </label>
          <label className="block lg:col-span-2 xl:col-span-2">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Title</span>
            <SearchableSelect
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              onChange={(event) => setTitleFilter(event.target.value)}
              value={titleFilter}
            >
              <option value={allValue}>All titles</option>
              {titleOptions.map((title) => (
                <option key={`title-${title}`} value={title}>
                  {title}
                </option>
              ))}
            </SearchableSelect>
          </label>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
          {metricCards.map((metric) => (
            <Metric key={`${metric.label}-${metric.value}`} icon={metric.icon} label={metric.label} value={metric.value} />
          ))}
        </div>

        {!hasActiveFilter ? (
          <div className="border-t border-slate-100 px-4 py-3 text-sm font-semibold text-slate-500">
            Apply any filter to narrow the map to one person, region, line, title, or date period.
          </div>
        ) : null}

        {message ? <div className="border-y border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{message}</div> : null}

        <div className="overflow-hidden border-t border-slate-200 bg-white p-4">
          {visibleItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm font-semibold text-slate-500">
              No entries for this filter set and selected period.
            </div>
          ) : (
            <div className="overflow-hidden border border-slate-200 bg-white">
              <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
                {weekdays.map((weekday) => (
                  <div
                    className="px-2 py-2 text-center text-[10px] font-black uppercase tracking-[0.14em] text-slate-500"
                    key={weekday}
                  >
                    {weekday}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7">
                {weeks.flat().map((day, index) => {
                  const date = day.date;
                  const dayItems = date ? itemsByDay.get(date) ?? [] : [];
                  const isSelected = date === selectedDate;
                  const isToday = date === today;

                  return (
                    <button
                      className={`min-h-[96px] border-b border-r border-slate-100 p-1.5 text-left transition sm:min-h-[130px] ${
                        day.inMonth ? "bg-white" : "bg-slate-50"
                      } ${isSelected ? "ring-2 ring-inset ring-orange-500" : "hover:bg-orange-50/40"}`}
                      disabled={!date}
                      key={date ?? `empty-${index}`}
                      onClick={() => date && setSelectedDate(date)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className={`flex h-6 w-6 items-center justify-center text-xs font-black ${
                            isToday ? "rounded-full bg-orange-500 text-white" : "border border-transparent text-slate-700"
                          }`}
                        >
                          {date ? Number(date.slice(8, 10)) : ""}
                        </span>
                        {dayItems.length > 0 ? (
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-500">{dayItems.length}</span>
                        ) : null}
                      </div>

                      <div className="mt-1 space-y-1">
                        {dayItems.slice(0, 4).map((item) => {
                          const tone =
                            isPlanItem(item) && item.conflictWarning
                              ? "bg-red-50 text-red-800 border-red-200"
                              : isPlanItem(item)
                                ? "bg-blue-50 text-blue-800 border-blue-200"
                                : "bg-emerald-50 text-emerald-800 border-emerald-200";
                          const title = isPlanItem(item) ? planTitle(item) : item.title;
                          const label = [
                            isPlanItem(item) && item.employeeName ? item.employeeName : null,
                            isPlanItem(item) ? item.region : null,
                            isPlanItem(item) ? item.lineName : null,
                          ].filter(Boolean).join("� ") || title;

                          return (
                            <p
                              className={`truncate rounded border px-1.5 py-1 text-[10px] font-bold ${tone}`}
                              key={item.id}
                              title={`${title} � ${label}`}
                            >
                              {label}
                            </p>
                          );
                        })}
                        {dayItems.length > 4 ? <span className="text-[10px] font-black text-slate-500">+{dayItems.length - 4} more</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Selected day</p>
            <h3 className="mt-1 text-lg font-black text-slate-950">{dayLabel(selectedDate)}</h3>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">{selectedItems.length} item{selectedItems.length === 1 ? "" : "s"}</span>
        </div>

        {selectedItems.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm font-semibold text-slate-500">No matched entries for this day.</div>
        ) : (
          <div className="grid gap-3 p-4 lg:grid-cols-2 xl:grid-cols-3">
            {selectedItems.map((item) => (
              <article className="rounded-lg border border-slate-200 bg-slate-50 p-3" key={item.id}>
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                  {item.source === "plan" ? <span className="text-blue-700">Plan</span> : <span className="text-emerald-700">Holiday</span>}
                  <span>{isPlanItem(item) ? (item.time ?? "Full day") : "Full day"}</span>
                </div>
                <p className="text-sm font-black text-slate-900">{isPlanItem(item) ? planTitle(item) : item.title}</p>
                <p className="mt-1 text-xs font-semibold text-slate-600">
                  {isPlanItem(item) ? [item.employeeName, item.region, item.lineName].filter(Boolean).join(" � ") : item.title}
                </p>
                <p className="mt-1 text-xs font-semibold text-slate-500">{item.title}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{icon}</div>
      <p className="mt-1.5 text-2xl font-black text-slate-950">{value}</p>
      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
    </div>
  );
}

