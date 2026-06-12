"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import {
  CalendarCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Fingerprint,
  Plane,
  Search,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  privateCalendarItemOccursOn,
  privateCalendarSourceLabels,
  privateCalendarSources,
  type PrivateCalendarItem,
  type PrivateCalendarSource,
  type PrivateCalendarWorkspace,
} from "@/lib/private-calendar/logic";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const allValue = "__all__";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
  }).format(new Date(`${value}T00:00:00Z`));
}

function monthDateIso(year: number, month: number, preferredDay = 1) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(preferredDay, 1), lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function sourceIcon(source: PrivateCalendarSource) {
  if (source === "attendance") return <Fingerprint className="h-4 w-4" />;
  if (source === "vacation") return <Plane className="h-4 w-4" />;
  if (source === "excuse") return <Clock className="h-4 w-4" />;
  if (source === "plan") return <CalendarCheck className="h-4 w-4" />;
  return <ShieldCheck className="h-4 w-4" />;
}

function sourceTone(source: PrivateCalendarSource, severity?: string) {
  if (severity === "danger") return "border-red-200 bg-red-50 text-red-800";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-800";
  if (source === "attendance") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (source === "vacation") return "border-blue-200 bg-blue-50 text-blue-800";
  if (source === "excuse") return "border-amber-200 bg-amber-50 text-amber-800";
  if (source === "plan") return "border-violet-200 bg-violet-50 text-violet-800";
  return "border-teal-200 bg-teal-50 text-teal-800";
}

function itemSearchText(item: PrivateCalendarItem) {
  return [
    item.title,
    item.status,
    item.time,
    item.description,
    item.employeeHrId,
    item.employeeName,
    item.detailLines.join(" "),
  ].join(" ").toLowerCase();
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function groupBySource(items: PrivateCalendarItem[]) {
  const groups = new Map<PrivateCalendarSource, PrivateCalendarItem[]>();
  for (const source of privateCalendarSources) groups.set(source, []);
  for (const item of items) {
    groups.set(item.source, [...(groups.get(item.source) ?? []), item]);
  }
  return privateCalendarSources
    .map((source) => ({ items: groups.get(source) ?? [], source }))
    .filter((group) => group.items.length > 0);
}

export function PrivateCalendar({ initialWorkspace }: { initialWorkspace: PrivateCalendarWorkspace }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [sourceFilter, setSourceFilter] = useState<string>(allValue);
  const [statusFilter, setStatusFilter] = useState<string>(allValue);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const { items, month, selectedEmployee, sourceReadiness, summary, visibleEmployees, weeks, year } = workspace;
  const today = todayIso();

  const statusOptions = useMemo(() => uniqueSorted(items.map((item) => item.status)), [items]);

  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return items.filter((item) => {
      if (sourceFilter !== allValue && item.source !== sourceFilter) return false;
      if (statusFilter !== allValue && item.status !== statusFilter) return false;
      if (search && !itemSearchText(item).includes(search)) return false;
      return true;
    });
  }, [items, query, sourceFilter, statusFilter]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, PrivateCalendarItem[]>();
    for (const week of weeks) {
      for (const day of week) {
        const date = day.date;
        if (!date) continue;
        const dayItems = filteredItems.filter((item) => privateCalendarItemOccursOn(item, date));
        if (dayItems.length) map.set(date, dayItems);
      }
    }
    return map;
  }, [filteredItems, weeks]);

  const selectedItems = useMemo(
    () => filteredItems.filter((item) => privateCalendarItemOccursOn(item, selectedDate)),
    [filteredItems, selectedDate],
  );
  const selectedGroups = useMemo(() => groupBySource(selectedItems), [selectedItems]);

  async function loadWorkspace(nextYear: number, nextMonth: number, employeeHrId: string, nextSelectedDate: string) {
    const params = new URLSearchParams({
      employeeHrId,
      month: String(nextMonth),
      year: String(nextYear),
    });
    const response = await fetch(`/api/private-calendar?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.message ?? "Unable to load private calendar.");
    setWorkspace(payload.data);
    setSelectedDate(nextSelectedDate);
  }

  function shiftMonth(delta: number) {
    const base = new Date(Date.UTC(year, month - 1 + delta, 1));
    const nextYear = base.getUTCFullYear();
    const nextMonth = base.getUTCMonth() + 1;
    const preferredDay = Number(selectedDate.slice(8, 10)) || 1;
    const nextSelectedDate = monthDateIso(nextYear, nextMonth, preferredDay);
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(nextYear, nextMonth, selectedEmployee.hrId, nextSelectedDate);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function goToday() {
    const now = new Date();
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(now.getUTCFullYear(), now.getUTCMonth() + 1, selectedEmployee.hrId, todayIso());
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function changeEmployee(employeeHrId: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(year, month, employeeHrId, selectedDate);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function resetFilters() {
    setSourceFilter(allValue);
    setStatusFilter(allValue);
    setQuery("");
  }

  return (
    <div className="space-y-5">
      {!workspace.schemaReady ? (
        <div className="border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
          Some private calendar sources are temporarily unavailable.
        </div>
      ) : null}

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-4 border-b border-slate-200 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-slate-700">
                <UserRound className="h-3.5 w-3.5" />
                Private Calendar
              </span>
              {workspace.access.isGlobalViewer ? (
                <span className="inline-flex items-center gap-1 border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-blue-700">
                  Global view
                </span>
              ) : null}
            </div>
            <h2 className="mt-2 text-2xl font-black text-slate-950">{monthLabel(year, month)}</h2>
            <p className="mt-1 text-sm font-semibold text-slate-600">
              {selectedEmployee.fullName} <span className="font-mono text-xs text-slate-400">{selectedEmployee.hrId}</span>
            </p>
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

        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
          <Metric icon={<Fingerprint className="h-5 w-5" />} label="Attendance" ready={sourceReadiness.attendance} value={summary.attendance} />
          <Metric icon={<Plane className="h-5 w-5" />} label="Vacations" ready={sourceReadiness.vacation} value={summary.vacation} />
          <Metric icon={<Clock className="h-5 w-5" />} label="Excuses" ready={sourceReadiness.excuse} value={summary.excuse} />
          <Metric icon={<CalendarCheck className="h-5 w-5" />} label="Plans" ready={sourceReadiness.plan} value={summary.plan} />
          <Metric icon={<ShieldCheck className="h-5 w-5" />} label="National" ready={sourceReadiness.holiday} value={summary.holiday} />
        </div>
      </section>

      {message ? (
        <div className="border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">{message}</div>
      ) : null}

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-3 p-4 lg:grid-cols-[minmax(220px,1fr)_minmax(180px,240px)_minmax(160px,200px)_minmax(160px,220px)_auto] lg:items-end">
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search month"
                value={query}
              />
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
            <select
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300 disabled:bg-slate-50"
              disabled={!workspace.access.canSelectEmployee || isPending}
              onChange={(event) => changeEmployee(event.target.value)}
              value={selectedEmployee.hrId}
            >
              {visibleEmployees.map((employee) => (
                <option key={employee.hrId} value={employee.hrId}>
                  {employee.fullName} ({employee.hrId})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Source</span>
            <select
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300"
              onChange={(event) => setSourceFilter(event.target.value)}
              value={sourceFilter}
            >
              <option value={allValue}>All sources</option>
              {privateCalendarSources.map((source) => (
                <option key={source} value={source}>{privateCalendarSourceLabels[source]}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Status</span>
            <select
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300"
              onChange={(event) => setStatusFilter(event.target.value)}
              value={statusFilter}
            >
              <option value={allValue}>All statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
          <Button disabled={isPending} onClick={resetFilters} variant="secondary">
            Reset
          </Button>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {weekdays.map((weekday) => (
              <div key={weekday} className="px-2 py-2 text-center text-[11px] font-black uppercase tracking-[0.12em] text-slate-500">
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {weeks.flatMap((week) => week).map((day, index) => {
              const date = day.date;
              const dayItems = date ? itemsByDay.get(date) ?? [] : [];
              const selected = date === selectedDate;
              const isToday = date === today;
              return (
                <button
                  className={[
                    "min-h-32 border-b border-r border-slate-100 bg-white p-2 text-left align-top transition hover:bg-orange-50/40 disabled:cursor-default",
                    day.inMonth ? "text-slate-900" : "bg-slate-50/60 text-slate-400",
                    selected ? "ring-2 ring-inset ring-orange-400" : "",
                  ].join(" ")}
                  disabled={!date}
                  key={`${date ?? "blank"}-${index}`}
                  onClick={() => date && setSelectedDate(date)}
                  type="button"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={["text-sm font-black", isToday ? "text-orange-600" : ""].join(" ")}>
                      {date ? Number(date.slice(8, 10)) : ""}
                    </span>
                    {dayItems.length > 0 ? (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-600">{dayItems.length}</span>
                    ) : null}
                  </span>
                  <span className="mt-2 block space-y-1">
                    {dayItems.slice(0, 4).map((item) => (
                      <span
                        className={["block truncate border px-1.5 py-1 text-[11px] font-bold", sourceTone(item.source, item.severity)].join(" ")}
                        key={item.id}
                        title={item.title}
                      >
                        {item.title}
                      </span>
                    ))}
                    {dayItems.length > 4 ? (
                      <span className="block border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-bold text-slate-500">
                        + {dayItems.length - 4} more
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-4">
            <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
              <CalendarDays className="h-4 w-4" />
              Selected Day
            </div>
            <h3 className="mt-2 text-xl font-black text-slate-950">{dayLabel(selectedDate)}</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">{selectedItems.length} item{selectedItems.length === 1 ? "" : "s"}</p>
          </div>
          <div className="max-h-[620px] overflow-y-auto p-4">
            {selectedGroups.length === 0 ? (
              <div className="border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm font-semibold text-slate-500">
                No private calendar items for this day.
              </div>
            ) : (
              <div className="space-y-5">
                {selectedGroups.map((group) => (
                  <section key={group.source}>
                    <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                      {sourceIcon(group.source)}
                      {privateCalendarSourceLabels[group.source]}
                    </div>
                    <div className="space-y-2">
                      {group.items.map((item) => (
                        <DetailItem item={item} key={item.id} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Metric({ icon, label, ready, value }: { icon: ReactNode; label: string; ready: boolean; value: number }) {
  return (
    <div className="border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-slate-500">{icon}</span>
        <span className={["text-[10px] font-black uppercase tracking-[0.14em]", ready ? "text-emerald-600" : "text-amber-600"].join(" ")}>
          {ready ? "Ready" : "Unavailable"}
        </span>
      </div>
      <p className="mt-3 text-2xl font-black text-slate-950">{value}</p>
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
    </div>
  );
}

function DetailItem({ item }: { item: PrivateCalendarItem }) {
  return (
    <article className={["border p-3", sourceTone(item.source, item.severity)].join(" ")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-black">{item.title}</h4>
          {item.time ? <p className="mt-1 text-xs font-bold opacity-80">{item.time}</p> : null}
        </div>
        {item.status ? (
          <span className="shrink-0 border border-current px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] opacity-80">
            {item.status}
          </span>
        ) : null}
      </div>
      {item.detailLines.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs font-semibold opacity-90">
          {item.detailLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      {item.description ? <p className="mt-3 text-xs font-semibold opacity-80">{item.description}</p> : null}
    </article>
  );
}
