"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileSearch,
  Fingerprint,
  ListFilter,
  Plane,
  Search,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  privateCalendarHrIdKey,
  privateCalendarItemOccursOn,
  privateCalendarSourceLabels,
  privateCalendarSources,
  type PrivateCalendarException,
  type PrivateCalendarItem,
  type PrivateCalendarSource,
  type PrivateCalendarViewMode,
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

function reportDateLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
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

function exceptionTone(severity: string) {
  if (severity === "danger") return "border-red-200 bg-red-50 text-red-800";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function itemSearchText(item: PrivateCalendarItem) {
  return [
    item.title,
    item.status,
    item.time,
    item.description,
    item.employeeHrId,
    item.employeeName,
    item.employeeDepartmentName,
    item.employeeLineName,
    item.managerName,
    item.sourceLabel,
    item.sourceRecordId,
    item.sourceSystem,
    item.sourceTable,
    item.approvalImpact,
    item.exceptionFlags.join(" "),
    item.detailLines.join(" "),
  ].join(" ").toLowerCase();
}

function exceptionSearchText(exception: PrivateCalendarException) {
  return [
    exception.title,
    exception.description,
    exception.employeeHrId,
    exception.employeeName,
    exception.code,
  ].join(" ").toLowerCase();
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function timelineRank(item: PrivateCalendarItem) {
  if (item.source === "holiday") return 0;
  if (item.source === "vacation") return 1;
  if (item.source === "excuse") return 2;
  if (item.source === "plan") return 3;
  return 4;
}

function sortTimelineItems(items: PrivateCalendarItem[]) {
  return [...items].sort((left, right) => {
    const rank = timelineRank(left) - timelineRank(right);
    if (rank !== 0) return rank;
    return `${left.time ?? ""}-${left.employeeName ?? ""}-${left.title}`.localeCompare(`${right.time ?? ""}-${right.employeeName ?? ""}-${right.title}`);
  });
}

type CalendarReportRow = {
  date: string;
  detail: string;
  employeeDepartmentName: string | null;
  employeeHrId: string | null;
  employeeJobTitle: string | null;
  employeeLineName: string | null;
  employeeName: string | null;
  id: string;
  severity: string;
  source: PrivateCalendarSource | "exception";
  sourceLabel: string;
  status: string | null;
  time: string | null;
  title: string;
};

function sourceReportLabel(source: CalendarReportRow["source"]) {
  return source === "exception" ? "Exception" : privateCalendarSourceLabels[source];
}

function sourceReportTone(source: CalendarReportRow["source"], severity?: string) {
  if (source === "exception") return exceptionTone(severity ?? "warning");
  return sourceTone(source, severity);
}

function reportDetail(item: PrivateCalendarItem) {
  const details = [
    ...item.detailLines,
    item.description,
    item.approvalImpact,
    item.sourceRecordId ? `Record: ${item.sourceRecordId}` : null,
  ].filter((value): value is string => Boolean(value));
  return details.join(" | ") || item.sourceLabel;
}

function buildCalendarReportRows(input: {
  employees: PrivateCalendarWorkspace["visibleEmployees"];
  exceptions: PrivateCalendarException[];
  items: PrivateCalendarItem[];
  weeks: PrivateCalendarWorkspace["weeks"];
}) {
  const monthDates = input.weeks
    .flatMap((week) => week)
    .filter((day) => day.date && day.inMonth)
    .map((day) => day.date as string);
  const employeeExceptionByDate = new Map<string, PrivateCalendarException[]>();
  const employeeByHrId = new Map(input.employees.map((employee) => [privateCalendarHrIdKey(employee.hrId), employee]));

  for (const exception of input.exceptions) {
    employeeExceptionByDate.set(exception.date, [...(employeeExceptionByDate.get(exception.date) ?? []), exception]);
  }

  const rows: CalendarReportRow[] = [];
  for (const date of monthDates) {
    const dayItems = input.items.filter((item) => privateCalendarItemOccursOn(item, date));
    for (const item of dayItems) {
      rows.push({
        date,
        detail: reportDetail(item),
        employeeDepartmentName: item.employeeDepartmentName,
        employeeHrId: item.employeeHrId,
        employeeJobTitle: item.employeeJobTitle,
        employeeLineName: item.employeeLineName,
        employeeName: item.employeeName,
        id: `${item.id}-${date}`,
        severity: item.severity,
        source: item.source,
        sourceLabel: item.sourceLabel,
        status: item.status,
        time: item.time,
        title: item.title,
      });
    }

    for (const exception of employeeExceptionByDate.get(date) ?? []) {
      const employee = exception.employeeHrId ? employeeByHrId.get(privateCalendarHrIdKey(exception.employeeHrId)) : null;
      rows.push({
        date,
        detail: exception.description,
        employeeDepartmentName: employee?.departmentName ?? null,
        employeeHrId: exception.employeeHrId,
        employeeJobTitle: employee?.jobTitle ?? null,
        employeeLineName: employee?.lineName ?? null,
        employeeName: exception.employeeName,
        id: exception.id,
        severity: exception.severity,
        source: "exception",
        sourceLabel: exception.code,
        status: exception.severity,
        time: null,
        title: exception.title,
      });
    }
  }

  return rows.sort((left, right) =>
    `${left.date}-${left.employeeName ?? ""}-${left.source}-${left.title}`.localeCompare(
      `${right.date}-${right.employeeName ?? ""}-${right.source}-${right.title}`,
    ),
  );
}

function chipTitle(item: PrivateCalendarItem, viewMode: PrivateCalendarViewMode) {
  if (viewMode === "team" && item.employeeName) return `${item.employeeName} - ${item.title}`;
  return item.title;
}

function employeeOptionLabel(employee: { fullName: string; hrId: string; jobTitle: string | null; lineName: string | null }) {
  return `${employee.fullName} (${employee.hrId})${employee.lineName ? ` - ${employee.lineName}` : ""}${employee.jobTitle ? ` - ${employee.jobTitle}` : ""}`;
}

export function PrivateCalendar({ initialWorkspace }: { initialWorkspace: PrivateCalendarWorkspace }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [sourceFilter, setSourceFilter] = useState<string>(allValue);
  const [statusFilter, setStatusFilter] = useState<string>(allValue);
  const [employeeFilter, setEmployeeFilter] = useState<string>(allValue);
  const [departmentFilter, setDepartmentFilter] = useState<string>(allValue);
  const [lineFilter, setLineFilter] = useState<string>(allValue);
  const [exceptionOnly, setExceptionOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const {
    exceptions,
    items,
    month,
    selectedEmployee,
    sourceReadiness,
    summary,
    teamSummary,
    viewMode,
    visibleEmployees,
    weeks,
    year,
  } = workspace;
  const today = todayIso();
  const isTeamView = viewMode === "team";

  const employeeByHrId = useMemo(
    () => new Map(visibleEmployees.map((employee) => [privateCalendarHrIdKey(employee.hrId), employee])),
    [visibleEmployees],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const statusOptions = useMemo(() => uniqueSorted(items.map((item) => item.status)), [items]);
  const departmentOptions = useMemo(() => uniqueSorted(visibleEmployees.map((employee) => employee.departmentName)), [visibleEmployees]);
  const lineOptions = useMemo(() => uniqueSorted(visibleEmployees.map((employee) => employee.lineName)), [visibleEmployees]);

  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return items.filter((item) => {
      const employee = item.employeeHrId ? employeeByHrId.get(privateCalendarHrIdKey(item.employeeHrId)) : null;
      if (sourceFilter !== allValue && item.source !== sourceFilter) return false;
      if (statusFilter !== allValue && item.status !== statusFilter) return false;
      if (employeeFilter !== allValue && item.employeeHrId && privateCalendarHrIdKey(item.employeeHrId) !== privateCalendarHrIdKey(employeeFilter)) return false;
      if (departmentFilter !== allValue && item.employeeHrId && employee?.departmentName !== departmentFilter) return false;
      if (lineFilter !== allValue && item.employeeHrId && employee?.lineName !== lineFilter) return false;
      if (exceptionOnly && item.exceptionFlags.length === 0) return false;
      if (search && !itemSearchText(item).includes(search)) return false;
      return true;
    });
  }, [departmentFilter, employeeByHrId, employeeFilter, exceptionOnly, items, lineFilter, query, sourceFilter, statusFilter]);

  const filteredExceptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    return exceptions.filter((exception) => {
      const employee = exception.employeeHrId ? employeeByHrId.get(privateCalendarHrIdKey(exception.employeeHrId)) : null;
      if (employeeFilter !== allValue && privateCalendarHrIdKey(exception.employeeHrId) !== privateCalendarHrIdKey(employeeFilter)) return false;
      if (departmentFilter !== allValue && employee?.departmentName !== departmentFilter) return false;
      if (lineFilter !== allValue && employee?.lineName !== lineFilter) return false;
      if (sourceFilter !== allValue) {
        const relatedSources = exception.relatedItemIds.map((id) => itemById.get(id)?.source).filter(Boolean);
        if (relatedSources.length === 0 && sourceFilter !== "attendance") return false;
        if (relatedSources.length > 0 && !relatedSources.includes(sourceFilter as PrivateCalendarSource)) return false;
      }
      if (search && !exceptionSearchText(exception).includes(search)) return false;
      return true;
    });
  }, [departmentFilter, employeeByHrId, employeeFilter, exceptions, itemById, lineFilter, query, sourceFilter]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, PrivateCalendarItem[]>();
    for (const week of weeks) {
      for (const day of week) {
        const date = day.date;
        if (!date) continue;
        const dayItems = filteredItems.filter((item) => privateCalendarItemOccursOn(item, date));
        const hasException = filteredExceptions.some((exception) => exception.date === date);
        if (exceptionOnly && !hasException) continue;
        if (dayItems.length) map.set(date, dayItems);
      }
    }
    return map;
  }, [exceptionOnly, filteredExceptions, filteredItems, weeks]);

  const exceptionsByDay = useMemo(() => {
    const map = new Map<string, PrivateCalendarException[]>();
    for (const exception of filteredExceptions) {
      map.set(exception.date, [...(map.get(exception.date) ?? []), exception]);
    }
    return map;
  }, [filteredExceptions]);

  const selectedItems = useMemo(
    () => filteredItems.filter((item) => privateCalendarItemOccursOn(item, selectedDate)),
    [filteredItems, selectedDate],
  );
  const selectedExceptions = useMemo(() => filteredExceptions.filter((exception) => exception.date === selectedDate), [filteredExceptions, selectedDate]);
  const timelineItems = useMemo(() => sortTimelineItems(selectedItems), [selectedItems]);
  const reportRows = useMemo(
    () => buildCalendarReportRows({ employees: visibleEmployees, exceptions: filteredExceptions, items: filteredItems, weeks }),
    [filteredExceptions, filteredItems, visibleEmployees, weeks],
  );
  const reportWarningCount = useMemo(
    () => reportRows.filter((row) => row.source === "exception" || row.severity === "danger" || row.severity === "warning").length,
    [reportRows],
  );

  async function loadWorkspace(
    nextYear: number,
    nextMonth: number,
    employeeHrId: string,
    nextSelectedDate: string,
    nextViewMode: PrivateCalendarViewMode = viewMode,
  ) {
    const params = new URLSearchParams({
      employeeHrId,
      month: String(nextMonth),
      view: nextViewMode,
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
    setEmployeeFilter(allValue);
    startTransition(async () => {
      try {
        await loadWorkspace(year, month, employeeHrId, selectedDate, "employee");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function changeViewMode(nextViewMode: PrivateCalendarViewMode) {
    setMessage(null);
    setEmployeeFilter(allValue);
    setDepartmentFilter(allValue);
    setLineFilter(allValue);
    startTransition(async () => {
      try {
        await loadWorkspace(year, month, selectedEmployee.hrId, selectedDate, nextViewMode);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function resetFilters() {
    setSourceFilter(allValue);
    setStatusFilter(allValue);
    setEmployeeFilter(allValue);
    setDepartmentFilter(allValue);
    setLineFilter(allValue);
    setExceptionOnly(false);
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
              {isTeamView ? (
                <span className="inline-flex items-center gap-1 border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-indigo-700">
                  <UsersRound className="h-3.5 w-3.5" />
                  Team mode
                </span>
              ) : null}
            </div>
            <h2 className="mt-2 text-2xl font-black text-slate-950">{monthLabel(year, month)}</h2>
            <p className="mt-1 text-sm font-semibold text-slate-600">
              {isTeamView ? `${teamSummary.length} visible employee${teamSummary.length === 1 ? "" : "s"}` : selectedEmployee.fullName}{" "}
              {!isTeamView ? <span className="font-mono text-xs text-slate-400">{selectedEmployee.hrId}</span> : null}
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

        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-6">
          <Metric icon={<Fingerprint className="h-5 w-5" />} label="Attendance" ready={sourceReadiness.attendance} value={summary.attendance} />
          <Metric icon={<Plane className="h-5 w-5" />} label="Vacations" ready={sourceReadiness.vacation} value={summary.vacation} />
          <Metric icon={<Clock className="h-5 w-5" />} label="Excuses" ready={sourceReadiness.excuse} value={summary.excuse} />
          <Metric icon={<CalendarCheck className="h-5 w-5" />} label="Plans" ready={sourceReadiness.plan} value={summary.plan} />
          <Metric icon={<ShieldCheck className="h-5 w-5" />} label="National" ready={sourceReadiness.holiday} value={summary.holiday} />
          <Metric icon={<AlertTriangle className="h-5 w-5" />} label="Exceptions" ready value={exceptions.length} tone="warning" />
        </div>
      </section>

      {message ? (
        <div className="border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">{message}</div>
      ) : null}

      <section className="border border-slate-200 bg-white shadow-sm">
        <div className="grid gap-3 p-4 lg:grid-cols-[minmax(220px,1fr)_repeat(5,minmax(140px,190px))_auto] lg:items-end">
          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search calendar"
                value={query}
              />
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">View</span>
            <select
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300 disabled:bg-slate-50"
              disabled={!workspace.access.canSelectEmployee || isPending}
              onChange={(event) => changeViewMode(event.target.value as PrivateCalendarViewMode)}
              value={viewMode}
            >
              <option value="employee">Employee</option>
              <option value="team">Team</option>
            </select>
          </label>

          {!isTeamView ? (
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
                    {employeeOptionLabel(employee)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="block">
              <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
              <select
                className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300"
                onChange={(event) => setEmployeeFilter(event.target.value)}
                value={employeeFilter}
              >
                <option value={allValue}>All visible</option>
                {visibleEmployees.map((employee) => (
                  <option key={employee.hrId} value={employee.hrId}>
                    {employee.fullName} ({employee.hrId})
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Line</span>
            <select
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300"
              onChange={(event) => setLineFilter(event.target.value)}
              value={lineFilter}
            >
              <option value={allValue}>All lines</option>
              {lineOptions.map((line) => <option key={line} value={line}>{line}</option>)}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Department</span>
            <select
              className="h-10 w-full border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none focus:border-orange-300"
              onChange={(event) => setDepartmentFilter(event.target.value)}
              value={departmentFilter}
            >
              <option value={allValue}>All departments</option>
              {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
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

          <div className="flex flex-wrap gap-2">
            <button
              className={[
                "inline-flex h-10 items-center gap-2 border px-3 text-sm font-black",
                exceptionOnly ? "border-red-300 bg-red-50 text-red-800" : "border-slate-200 bg-white text-slate-700",
              ].join(" ")}
              onClick={() => setExceptionOnly((value) => !value)}
              type="button"
            >
              <ListFilter className="h-4 w-4" />
              Exceptions
            </button>
            <Button disabled={isPending} onClick={resetFilters} variant="secondary">
              Reset
            </Button>
          </div>
        </div>

        <div className="grid gap-3 border-t border-slate-100 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
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
        </div>
      </section>

      {isTeamView ? <TeamSummaryPanel rows={teamSummary} /> : null}

      <div className="space-y-5">
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
              const dayExceptions = date ? exceptionsByDay.get(date) ?? [] : [];
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
                    <span className="flex items-center gap-1">
                      {dayExceptions.length > 0 ? (
                        <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-black text-red-700">{dayExceptions.length}</span>
                      ) : null}
                      {dayItems.length > 0 ? (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-black text-slate-600">{dayItems.length}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="mt-2 block space-y-1">
                    {dayExceptions.slice(0, 2).map((exception) => (
                      <span
                        className={["block truncate border px-1.5 py-1 text-[11px] font-bold", exceptionTone(exception.severity)].join(" ")}
                        key={exception.id}
                        title={exception.description}
                      >
                        {exception.title}
                      </span>
                    ))}
                    {dayItems.slice(0, dayExceptions.length > 0 ? 3 : 4).map((item) => (
                      <span
                        className={["block truncate border px-1.5 py-1 text-[11px] font-bold", sourceTone(item.source, item.severity)].join(" ")}
                        key={item.id}
                        title={chipTitle(item, viewMode)}
                      >
                        {chipTitle(item, viewMode)}
                      </span>
                    ))}
                    {dayItems.length + dayExceptions.length > 5 ? (
                      <span className="block border border-slate-200 bg-slate-50 px-1.5 py-1 text-[11px] font-bold text-slate-500">
                        + {dayItems.length + dayExceptions.length - 5} more
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
                <CalendarDays className="h-4 w-4" />
                Daily Timeline
              </div>
              <h3 className="mt-2 text-xl font-black text-slate-950">{dayLabel(selectedDate)}</h3>
            </div>
            <span className="border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-black text-slate-600">
              {timelineItems.length} item{timelineItems.length === 1 ? "" : "s"} / {selectedExceptions.length} exception{selectedExceptions.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="grid gap-5 p-4 xl:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
            {selectedExceptions.length > 0 ? (
              <section>
                <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-red-700">
                  <AlertTriangle className="h-4 w-4" />
                  Exception Warnings
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  {selectedExceptions.map((exception) => <ExceptionItem exception={exception} key={exception.id} />)}
                </div>
              </section>
            ) : null}

            <section className={selectedExceptions.length > 0 ? "min-w-0" : "min-w-0 xl:col-span-2"}>
              {timelineItems.length === 0 ? (
                <div className="border border-dashed border-slate-200 bg-slate-50 p-5 text-center text-sm font-semibold text-slate-500">
                  No private calendar items for this day.
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {timelineItems.map((item) => (
                    <TimelineItem item={item} key={item.id} viewMode={viewMode} />
                  ))}
                </div>
              )}
            </section>
          </div>
        </section>

        <CalendarReportTable rows={reportRows} warningCount={reportWarningCount} />
      </div>
    </div>
  );
}

function Metric({ icon, label, ready, tone = "neutral", value }: { icon: ReactNode; label: string; ready: boolean; tone?: "neutral" | "warning"; value: number }) {
  return (
    <div className={["border p-3", tone === "warning" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"].join(" ")}>
      <div className="flex items-center justify-between gap-3">
        <span className={tone === "warning" ? "text-amber-600" : "text-slate-500"}>{icon}</span>
        <span className={["text-[10px] font-black uppercase tracking-[0.14em]", ready ? "text-emerald-600" : "text-amber-600"].join(" ")}>
          {ready ? "Ready" : "Unavailable"}
        </span>
      </div>
      <p className="mt-3 text-2xl font-black text-slate-950">{value}</p>
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
    </div>
  );
}

function TeamSummaryPanel({ rows }: { rows: PrivateCalendarWorkspace["teamSummary"] }) {
  const sortedRows = [...rows].sort((left, right) => right.exceptionCount - left.exceptionCount || left.fullName.localeCompare(right.fullName));
  return (
    <section className="border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
            <UsersRound className="h-4 w-4" />
            Manager Team Calendar
          </div>
          <h3 className="mt-1 text-lg font-black text-slate-950">Visible employees snapshot</h3>
        </div>
        <span className="border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-black text-slate-600">
          {rows.length} employee{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid max-h-72 gap-2 overflow-y-auto p-4 md:grid-cols-2 xl:grid-cols-3">
        {sortedRows.slice(0, 18).map((row) => (
          <article key={row.hrId} className="border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-black text-slate-900">{row.fullName}</h4>
                <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-500">
                  {row.hrId} {row.lineName ? `- ${row.lineName}` : ""}
                </p>
              </div>
              <span className={["shrink-0 border px-2 py-0.5 text-[10px] font-black", row.exceptionCount ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"].join(" ")}>
                {row.exceptionCount} warning{row.exceptionCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-1 text-center text-[10px] font-black uppercase tracking-[0.08em] text-slate-500">
              <span className="border border-slate-200 bg-white px-1 py-1">A {row.sourceCounts.attendance}</span>
              <span className="border border-slate-200 bg-white px-1 py-1">V {row.sourceCounts.vacation}</span>
              <span className="border border-slate-200 bg-white px-1 py-1">E {row.sourceCounts.excuse}</span>
              <span className="border border-slate-200 bg-white px-1 py-1">P {row.sourceCounts.plan}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ExceptionItem({ exception }: { exception: PrivateCalendarException }) {
  return (
    <article className={["border p-3", exceptionTone(exception.severity)].join(" ")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-black">{exception.title}</h4>
          {exception.employeeName ? (
            <p className="mt-1 text-xs font-bold opacity-80">
              {exception.employeeName} {exception.employeeHrId ? `(${exception.employeeHrId})` : ""}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 border border-current px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] opacity-80">
          {exception.severity}
        </span>
      </div>
      <p className="mt-2 text-xs font-semibold opacity-90">{exception.description}</p>
    </article>
  );
}

function CalendarReportTable({ rows, warningCount }: { rows: CalendarReportRow[]; warningCount: number }) {
  return (
    <section className="overflow-hidden border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
        <div>
          <div className="flex items-center gap-2 text-base font-black text-slate-950">
            <span className="h-2 w-2 bg-orange-500" />
            Calendar Report ({rows.length})
          </div>
          <p className="mt-2 text-sm font-semibold text-slate-500">
            Report rows mirror the private calendar entries and warnings after the current filters.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={["border px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em]", warningCount > 0 ? "border-red-200 bg-red-50 text-red-700" : "border-slate-200 bg-slate-50 text-slate-700"].join(" ")}>
            {warningCount} warning{warningCount === 1 ? "" : "s"}
          </span>
          <span className="border border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-700">
            {rows.length} visible
          </span>
        </div>
      </div>

      <div className="overflow-x-auto bg-white">
        <table className="w-full min-w-[1180px] border-collapse text-left text-xs">
          <thead>
            <tr className="bg-black text-white">
              {["Date", "HR ID", "Full Name", "Job Title", "Line", "Department", "Source", "Calendar Entry", "Time", "Status"].map((column) => (
                <th
                  className="border-r border-orange-900/60 px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.14em] last:border-r-0"
                  key={column}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-orange-100">
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-7 text-center text-sm font-semibold text-slate-500" colSpan={10}>
                  No private calendar entries match the current filters.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr className="transition hover:bg-orange-50/35" key={row.id}>
                  <td className="border-r border-orange-100 px-2 py-2 font-mono text-[11px] font-semibold text-slate-600">
                    {reportDateLabel(row.date)}
                  </td>
                  <td className="border-r border-orange-100 px-2 py-2 font-mono text-[11px] font-semibold text-slate-700">
                    {row.employeeHrId ?? "Company"}
                  </td>
                  <td className="max-w-[230px] truncate border-r border-orange-100 px-2 py-2 font-black text-slate-950">
                    {row.employeeName ?? "Company calendar"}
                  </td>
                  <td className="max-w-[180px] truncate border-r border-orange-100 px-2 py-2 font-semibold text-slate-600">
                    {row.employeeJobTitle ?? "-"}
                  </td>
                  <td className="max-w-[130px] truncate border-r border-orange-100 px-2 py-2 font-semibold text-slate-600">
                    {row.employeeLineName ?? "-"}
                  </td>
                  <td className="max-w-[150px] truncate border-r border-orange-100 px-2 py-2 font-semibold text-slate-600">
                    {row.employeeDepartmentName ?? "-"}
                  </td>
                  <td className="border-r border-orange-100 px-2 py-2">
                    <span className={["inline-flex max-w-[150px] items-center truncate border px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em]", sourceReportTone(row.source, row.severity)].join(" ")}>
                      {sourceReportLabel(row.source)}
                    </span>
                  </td>
                  <td className="max-w-[280px] border-r border-orange-100 px-2 py-2">
                    <p className="truncate font-black text-slate-950">{row.title}</p>
                    <p className="mt-0.5 truncate text-[11px] font-semibold text-slate-500">{row.detail}</p>
                  </td>
                  <td className="max-w-[130px] truncate border-r border-orange-100 px-2 py-2 font-semibold text-slate-600">
                    {row.time ?? "Full day"}
                  </td>
                  <td className="px-2 py-2">
                    <span className={["inline-flex max-w-[140px] truncate border px-2 py-1 text-[10px] font-black uppercase tracking-[0.1em]", sourceReportTone(row.source, row.severity)].join(" ")}>
                      {row.status ?? row.sourceLabel}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TimelineItem({ item, viewMode }: { item: PrivateCalendarItem; viewMode: PrivateCalendarViewMode }) {
  return (
    <article className={["border p-3", sourceTone(item.source, item.severity)].join(" ")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.12em] opacity-80">
              {sourceIcon(item.source)}
              {privateCalendarSourceLabels[item.source]}
            </span>
            {item.time ? <span className="text-xs font-black opacity-80">{item.time}</span> : null}
          </div>
          <h4 className="mt-1 text-sm font-black">{item.title}</h4>
          {viewMode === "team" && item.employeeName ? (
            <p className="mt-1 text-xs font-bold opacity-80">
              {item.employeeName} {item.employeeHrId ? `(${item.employeeHrId})` : ""}
            </p>
          ) : null}
        </div>
        {item.status ? (
          <span className="shrink-0 border border-current px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] opacity-80">
            {item.status}
          </span>
        ) : null}
      </div>

      {item.exceptionFlags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {item.exceptionFlags.map((flag) => (
            <span key={flag} className="border border-current px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] opacity-90">
              {flag}
            </span>
          ))}
        </div>
      ) : null}

      {item.detailLines.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs font-semibold opacity-90">
          {item.detailLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      {item.description ? <p className="mt-3 text-xs font-semibold opacity-80">{item.description}</p> : null}
      {item.approvalImpact ? (
        <p className="mt-3 border border-current bg-white/60 px-2 py-1.5 text-xs font-bold opacity-90">{item.approvalImpact}</p>
      ) : null}
      <div className="mt-3 border-t border-current/20 pt-2 text-[11px] font-semibold opacity-80">
        <div className="flex items-center gap-1 font-black uppercase tracking-[0.12em]">
          <FileSearch className="h-3.5 w-3.5" />
          Source trace
        </div>
        <p className="mt-1">{item.sourceLabel}</p>
        <p>{item.sourceSystem}{item.sourceTable ? ` - ${item.sourceTable}` : ""}</p>
        {item.sourceRecordId ? <p className="font-mono">Record: {item.sourceRecordId}</p> : null}
      </div>
    </article>
  );
}
