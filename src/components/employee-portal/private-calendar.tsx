"use client";

import { useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSearch,
  ListFilter,
  RefreshCw,
  Search,
} from "lucide-react";


import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
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
import { SearchableSelect } from "@/components/ui/searchable-select";


const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const allValue = "__all__";

// Where a Super Admin can actually go verify a request-review / no-activity
// clarification claim — a closed, real list of the systems this app already
// has, plus an escape hatch for anything else.
const verificationSourceOptions = [
  "CRM / iReports360 (Double Visit)",
  "Fingerprint / Attendance Device",
  "Manager Confirmation",
  "HR Records (Vacation / Excuse Approval)",
  "Other",
] as const;

function todayIso() {
  return currentCairoDateOnlyIso();
}

// Cairo local clock time — the app's operating timezone — so "Synced at" reads as
// the employee's own wall-clock time, not a raw UTC/ISO timestamp.
function formatSyncedAt(date: Date) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Africa/Cairo",
  }).format(date);
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

// Every source gets its own hue, chosen to stay visually distinct even at
// small chip sizes: double_visit is fuchsia (indigo read too close to
// vacation's blue), holiday defaults to violet (teal read too close to
// attendance's emerald green).
function sourceAccentColor(source: PrivateCalendarSource, severity?: string) {
  if (severity === "danger") return "border-l-red-500";
  if (severity === "warning") return "border-l-amber-400";
  if (source === "attendance") return "border-l-emerald-500";
  if (source === "vacation") return "border-l-blue-500";
  if (source === "excuse") return "border-l-amber-500";
  if (source === "double_visit") return "border-l-fuchsia-500";
  return "border-l-violet-500";
}

function sourceChipTone(source: PrivateCalendarSource, severity?: string) {
  if (severity === "danger") return "bg-red-100 text-red-700";
  if (severity === "warning") return "bg-amber-100 text-amber-700";
  if (source === "attendance") return "bg-emerald-100 text-emerald-700";
  if (source === "vacation") return "bg-blue-100 text-blue-700";
  if (source === "excuse") return "bg-amber-100 text-amber-700";
  if (source === "double_visit") return "bg-fuchsia-100 text-fuchsia-700";
  return "bg-violet-100 text-violet-700";
}

// Solid swatch colour per source for legend dots / agenda markers.
function sourceSwatchColor(source: PrivateCalendarSource) {
  if (source === "attendance") return "bg-emerald-500";
  if (source === "vacation") return "bg-blue-500";
  if (source === "excuse") return "bg-amber-500";
  if (source === "double_visit") return "bg-fuchsia-500";
  return "bg-violet-500";
}

// Every private calendar exception is either a real problem (danger) or a
// lighter warning (e.g. late arrival) — shared tone lookup for the day-cell
// chip, the actionable strip, the agenda, and the detail panel.
function exceptionTone(severity: string) {
  if (severity === "danger") {
    return {
      badge: "bg-red-200 text-red-800",
      border: "border-l-red-500",
      chip: "bg-red-100 text-red-700",
      dot: "bg-red-500",
      panel: "bg-red-50/40",
      panelStrong: "bg-red-50/80 ring-red-100",
      text: "text-red-800",
    };
  }
  return {
    badge: "bg-amber-200 text-amber-800",
    border: "border-l-amber-400",
    chip: "bg-amber-100 text-amber-700",
    dot: "bg-amber-500",
    panel: "bg-amber-50/30",
    panelStrong: "bg-amber-50/80 ring-amber-100",
    text: "text-amber-800",
  };
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
  return 4;
}

function sortTimelineItems(items: PrivateCalendarItem[]) {
  return [...items].sort((left, right) => {
    const rank = timelineRank(left) - timelineRank(right);
    if (rank !== 0) return rank;
    return `${left.time ?? ""}-${left.employeeName ?? ""}-${left.title}`.localeCompare(`${right.time ?? ""}-${right.employeeName ?? ""}-${right.title}`);
  });
}

type PrivateCalendarSurface = "employee" | "workspace";

function chipTitle(item: PrivateCalendarItem, viewMode: PrivateCalendarViewMode) {
  if (viewMode === "team" && item.employeeName) return `${item.employeeName} - ${item.title}`;
  return item.title;
}

function employeeOptionLabel(employee: { fullName: string; hrId: string; jobTitle: string | null; lineName: string | null }) {
  return `${employee.fullName} (${employee.hrId})${employee.lineName ? ` - ${employee.lineName}` : ""}${employee.jobTitle ? ` - ${employee.jobTitle}` : ""}`;
}

export function PrivateCalendar({
  initialWorkspace,
  surface = "employee",
  todayIso: todayIsoProp,
  viewerHrId = null,
}: {
  initialWorkspace: PrivateCalendarWorkspace;
  surface?: PrivateCalendarSurface;
  /** Today's date as YYYY-MM-DD, computed once on the server to prevent SSR/hydration mismatch. */
  todayIso: string;
  // Whoever is actually logged in and looking at this screen — NOT necessarily
  // the employee whose calendar is displayed (a manager/admin can view someone
  // else's calendar here too). Flag-day and no-activity-clarification are
  // self-service actions, so they only render when this matches
  // selectedEmployee.hrId — viewing your OWN calendar.
  viewerHrId?: string | null;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selectedDate, setSelectedDate] = useState(todayIsoProp);
  const [sourceFilter, setSourceFilter] = useState<string>(allValue);
  const [statusFilter, setStatusFilter] = useState<string>(allValue);
  const [employeeFilter, setEmployeeFilter] = useState<string>(allValue);
  const [departmentFilter, setDepartmentFilter] = useState<string>(allValue);
  const [lineFilter, setLineFilter] = useState<string>(allValue);
  const [exceptionOnly, setExceptionOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [calendarView, setCalendarView] = useState<"month" | "list">("month");
  const [hiddenSources, setHiddenSources] = useState<Set<PrivateCalendarSource>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Every source this calendar reads (attendance, CRM double visits, vacation,
  // excuse) is queried live server-side on every fetch — there is no cache layer
  // to invalidate. "Sync Now" re-runs that same live fetch on demand instead of
  // requiring a month/employee change to force a refresh; lastSyncedAt tracks
  // every successful fetch (nav or explicit sync) so the timestamp is always
  // honest about how current the data on screen actually is.
  // Starts null (the initial view came from the server-rendered page load, not a
  // client fetch, so there is no honest client-side timestamp for it) and is set
  // the moment any real fetch completes — nav, employee switch, or Sync Now.
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

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
  const today = todayIsoProp;
  const isTeamView = viewMode === "team";
  const isWorkspaceSurface = surface === "workspace";
  // View/Employee/Line/Department/Search only mean anything when the viewer can
  // actually see more than themselves — a self-scoped viewer (e.g. a regular
  // employee) has exactly one employee, one line, one department in their data,
  // so those controls would be dead UI that filters nothing. Source/Status/
  // Exceptions still filter within one person's own items and stay for everyone.
  const canFilterAcrossEmployees = workspace.access.canSelectEmployee;
  // Every private calendar source is already an actually recorded/verified event
  // (attendance, leave, CRM double visits) — there is no separate "planned" view
  // to distinguish anymore, so this flag currently has no effect on what renders.
  const actualOnly = surface === "employee";
  const panelClass = isWorkspaceSurface
    ? "overflow-hidden rounded-sm border border-slate-200 bg-white shadow-sm"
    : "overflow-hidden rounded-sm bg-white shadow-lg ring-1 ring-slate-200/60";
  const secondaryPanelClass = isWorkspaceSurface
    ? "overflow-hidden rounded-sm border border-slate-200 bg-white shadow-sm"
    : "overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-slate-200/60";
  const inputClass = isWorkspaceSurface
    ? "h-10 w-full rounded-sm border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-500/15 disabled:cursor-not-allowed disabled:opacity-60"
    : "h-10 w-full rounded-sm border-0 bg-slate-100 px-3 text-sm font-semibold text-slate-800 outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-60";
  const searchInputClass = isWorkspaceSurface
    ? "h-10 w-full rounded-sm border border-slate-300 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-500/15"
    : "h-10 w-full rounded-sm border-0 bg-slate-100 pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-orange-300";
  const controlRadiusClass = "rounded-sm";

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
      if (hiddenSources.has(item.source)) return false;
      if (sourceFilter !== allValue && item.source !== sourceFilter) return false;
      if (statusFilter !== allValue && item.status !== statusFilter) return false;
      if (employeeFilter !== allValue && item.employeeHrId && privateCalendarHrIdKey(item.employeeHrId) !== privateCalendarHrIdKey(employeeFilter)) return false;
      if (departmentFilter !== allValue && item.employeeHrId && employee?.departmentName !== departmentFilter) return false;
      if (lineFilter !== allValue && item.employeeHrId && employee?.lineName !== lineFilter) return false;
      if (exceptionOnly && item.exceptionFlags.length === 0) return false;
      if (search && !itemSearchText(item).includes(search)) return false;
      return true;
    });
  }, [departmentFilter, employeeByHrId, employeeFilter, exceptionOnly, hiddenSources, items, lineFilter, query, sourceFilter, statusFilter]);

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

  // Agenda (List view): every in-month day that has items or exceptions, sorted,
  // each fully readable. Antidote to the cramped month grid.
  const agendaDays = useMemo(() => {
    const dates = new Set<string>();
    for (const date of itemsByDay.keys()) dates.add(date);
    for (const date of exceptionsByDay.keys()) dates.add(date);
    return Array.from(dates)
      .filter((date) => Number(date.slice(5, 7)) === month)
      .sort()
      .map((date) => ({
        date,
        dayExceptions: exceptionsByDay.get(date) ?? [],
        dayItems: sortTimelineItems(itemsByDay.get(date) ?? []),
      }));
  }, [exceptionsByDay, itemsByDay, month]);

  // Sources actually present in the (unfiltered-by-hide) data, in canonical order.
  const presentSources = useMemo(() => {
    const present = new Set(items.map((item) => item.source));
    return privateCalendarSources.filter((source) => present.has(source));
  }, [items]);

  const selectedItems = useMemo(
    () => filteredItems.filter((item) => privateCalendarItemOccursOn(item, selectedDate)),
    [filteredItems, selectedDate],
  );
  const selectedExceptions = useMemo(() => filteredExceptions.filter((exception) => exception.date === selectedDate), [filteredExceptions, selectedDate]);
  const timelineItems = useMemo(() => sortTimelineItems(selectedItems), [selectedItems]);
  const daysWithIssues = useMemo(
    () => new Set(exceptions.map((ex) => ex.date)).size,
    [exceptions],
  );

  // Flag-this-day is a self-service action — only the employee whose calendar
  // this is can act on it, never a manager/admin paging through someone else's
  // calendar from the admin surface.
  const canActOnOwnDay = viewerHrId != null && privateCalendarHrIdKey(viewerHrId) === privateCalendarHrIdKey(selectedEmployee.hrId);

  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [disputeClaimText, setDisputeClaimText] = useState("");
  const [disputeSourceOptions, setDisputeSourceOptions] = useState<string[]>([]);
  const [disputeSourceDetail, setDisputeSourceDetail] = useState("");
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);
  const [disputeMessage, setDisputeMessage] = useState<string | null>(null);


  async function submitDayDispute() {
    setDisputeMessage(null);
    if (!disputeClaimText.trim() || disputeSourceOptions.length === 0) {
      setDisputeMessage("Tell us what actually happened, and where a Super Admin can verify it.");
      return;
    }
    if (disputeSourceOptions.includes("Other") && !disputeSourceDetail.trim()) {
      setDisputeMessage("Tell us where a Super Admin can verify this.");
      return;
    }
    setDisputeSubmitting(true);
    try {
      const claimSourceText = disputeSourceDetail.trim()
        ? `${disputeSourceOptions.join(", ")}: ${disputeSourceDetail.trim()}`
        : disputeSourceOptions.join(", ");
      const displayedSummary = timelineItems.length > 0
        ? timelineItems.map((item) => item.title).join(" | ")
        : selectedExceptions.length > 0
          ? selectedExceptions.map((exception) => exception.title).join(" | ")
          : "Nothing was shown for this day.";
      const response = await fetch("/api/private-calendar/disputes", {
        body: JSON.stringify({
          claimSourceText,
          claimText: disputeClaimText,
          displayedSummary,
          disputeDate: selectedDate,
          employeeName: selectedEmployee.fullName,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to submit this dispute.");
      setDisputeClaimText("");
      setDisputeSourceOptions([]);
      setDisputeSourceDetail("");
      setDisputeMessage("Request submitted — a Super Admin will review it.");
    } catch (error) {
      setDisputeMessage(error instanceof Error ? error.message : "Unable to submit this dispute.");
    } finally {
      setDisputeSubmitting(false);
    }
  }

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
      ...(actualOnly ? { actualOnly: "1" } : {}),
    });
    const response = await fetch(`/api/private-calendar?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.message ?? "Unable to load private calendar.");
    setWorkspace(payload.data);
    setSelectedDate(nextSelectedDate);
    setLastSyncedAt(new Date());
  }

  // Re-runs the exact same live fetch as month/employee navigation, for the
  // CURRENTLY viewed month/employee — every source it reads (attendance,
  // vacation, excuse, CRM double visits) is queried straight from Phoenix's own
  // database with no cache in between, so this always reflects whatever is
  // currently there. It does not (and cannot) reach out to iReports360 itself —
  // that external pull is the scheduled cron's job.
  function syncNow() {
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(year, month, selectedEmployee.hrId, selectedDate, viewMode);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to sync private calendar.");
      }
    });
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
    const { year: todayYear, month: todayMonth } = currentCairoDateParts();
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(todayYear, todayMonth, selectedEmployee.hrId, todayIso());
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
    setHiddenSources(new Set());
  }

  function toggleSource(source: PrivateCalendarSource) {
    setHiddenSources((current) => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  function focusException(date: string) {
    setSelectedDate(date);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      setCalendarView("list");
    }
  }

  return (
    <div className={isWorkspaceSurface ? "space-y-5" : "space-y-6"}>
      {!workspace.schemaReady ? (
        <div className="flex items-center gap-3 rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 shadow-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Some private calendar sources are temporarily unavailable.
        </div>
      ) : null}

      {/* ── Header + Metrics ── */}
      <section className={panelClass}>
        <div className={isWorkspaceSurface ? "border-b border-slate-200 bg-slate-950 px-5 py-4" : "bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 px-6 py-5"}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-white/80 ring-1 ring-white/20">
                  Private Calendar
                </span>
                {workspace.access.isGlobalViewer ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-phx-info/20 px-3 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-info-bg ring-1 ring-phx-info-line/30">
                    Global view
                  </span>
                ) : null}
                {isTeamView ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/20 px-3 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-indigo-200 ring-1 ring-indigo-400/30">
                    Team mode
                  </span>
                ) : null}
              </div>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-white">{monthLabel(year, month)}</h2>
              <p className="mt-1 text-sm font-semibold text-slate-300">
                {isTeamView
                  ? `${teamSummary.length} visible employee${teamSummary.length === 1 ? "" : "s"}`
                  : selectedEmployee.fullName}{" "}
                {!isTeamView ? <span className="font-mono text-xs text-slate-400">{selectedEmployee.hrId}</span> : null}
              </p>
              <p className="mt-1 text-xs font-semibold text-slate-400">
                {isPending ? "Syncing…" : lastSyncedAt ? `Synced at ${formatSyncedAt(lastSyncedAt)}` : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex border border-white/20 bg-white/10 p-0.5">
                {(["month", "list"] as const).map((mode) => (
                  <button
                    className={[
                      "h-9 px-3.5 text-xs font-black uppercase tracking-[0.1em] transition-colors",
                      calendarView === mode ? "bg-slate-900 text-white" : "text-white/70 hover:bg-white/15",
                    ].join(" ")}
                    key={mode}
                    onClick={() => setCalendarView(mode)}
                    type="button"
                  >
                    {mode === "month" ? "Month" : "List"}
                  </button>
                ))}
              </div>
              <button
                aria-label="Sync Now — refresh this calendar with whatever is currently recorded in Phoenix"
                className={["inline-flex h-9 items-center gap-1.5 bg-white/10 px-3 text-xs font-black text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-50", controlRadiusClass].join(" ")}
                disabled={isPending}
                onClick={syncNow}
                type="button"
              >
                <RefreshCw className={["h-3.5 w-3.5", isPending ? "animate-spin" : ""].join(" ")} />
                Sync Now
              </button>
              <a
                className={["inline-flex h-9 items-center gap-1.5 bg-white/10 px-3 text-xs font-black text-white/80 ring-1 ring-white/20 transition hover:bg-white/20", controlRadiusClass].join(" ")}
                href={`/api/private-calendar/export?format=xlsx&year=${year}&month=${month}&employeeHrId=${encodeURIComponent(selectedEmployee.hrId)}&view=${viewMode}${actualOnly ? "&actualOnly=1" : ""}`}
                download
              >
                <Download className="h-3.5 w-3.5" />
                XLSX
              </a>
              <a
                className={["inline-flex h-9 items-center gap-1.5 bg-white/10 px-3 text-xs font-black text-white/80 ring-1 ring-white/20 transition hover:bg-white/20", controlRadiusClass].join(" ")}
                href={`/api/private-calendar/export?format=pdf&year=${year}&month=${month}&employeeHrId=${encodeURIComponent(selectedEmployee.hrId)}&view=${viewMode}${actualOnly ? "&actualOnly=1" : ""}`}
                download
              >
                <Download className="h-3.5 w-3.5" />
                PDF
              </a>
              <button
                aria-label="Previous month"
                className={["inline-flex h-9 w-9 items-center justify-center bg-white/10 text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-40", controlRadiusClass].join(" ")}
                disabled={isPending}
                onClick={() => shiftMonth(-1)}
                type="button"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                className={["h-9 bg-orange-500 px-4 text-sm font-black text-white shadow-md transition hover:bg-orange-400 disabled:opacity-50", controlRadiusClass].join(" ")}
                disabled={isPending}
                onClick={goToday}
                type="button"
              >
                Today
              </button>
              <button
                aria-label="Next month"
                className={["inline-flex h-9 w-9 items-center justify-center bg-white/10 text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-40", controlRadiusClass].join(" ")}
                disabled={isPending}
                onClick={() => shiftMonth(1)}
                type="button"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-6">
          <Metric label="Attendance" ready={sourceReadiness.attendance} value={summary.attendance} />
          <Metric label="Vacations" ready={sourceReadiness.vacation} value={summary.vacation} />
          <Metric label="Excuses" ready={sourceReadiness.excuse} value={summary.excuse} />
          <Metric label="National" ready={sourceReadiness.holiday} value={summary.holiday} />
          <Metric label="Exceptions" ready value={exceptions.length} tone="warning" />
          <Metric label="Days w/ Issues" ready value={daysWithIssues} tone="warning" />
        </div>
      </section>

      {message ? (
        <div className="flex items-center gap-3 rounded-sm border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800 shadow-sm">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {message}
        </div>
      ) : null}

      {/* ── Filters ── */}
      <section className={secondaryPanelClass}>
        <div className="border-b border-slate-100 px-5 py-3">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Filter &amp; Search</p>
        </div>
        <div className={canFilterAcrossEmployees
          ? "grid gap-4 p-5 lg:grid-cols-[minmax(220px,1fr)_repeat(5,minmax(140px,190px))_auto] lg:items-end"
          : "grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-[minmax(160px,260px)_auto] lg:items-end"}
        >
          {canFilterAcrossEmployees ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Search</span>
                <span className="relative block">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    className={searchInputClass}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search calendar…"
                    value={query}
                  />
                </span>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">View</span>
                <SearchableSelect
                  className={inputClass}
                  disabled={isPending}
                  onChange={(event) => changeViewMode(event.target.value as PrivateCalendarViewMode)}
                  value={viewMode}
                >
                  <option value="employee">Employee</option>
                  <option value="team">Team</option>
                </SearchableSelect>
              </label>

              {!isTeamView ? (
                <label className="block">
                  <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
                  <SearchableSelect
                    className={inputClass}
                    disabled={isPending}
                    onChange={(event) => changeEmployee(event.target.value)}
                    value={selectedEmployee.hrId}
                  >
                    {visibleEmployees.map((employee) => (
                      <option key={employee.hrId} value={employee.hrId}>
                        {employeeOptionLabel(employee)}
                      </option>
                    ))}
                  </SearchableSelect>
                </label>
              ) : (
                <label className="block">
                  <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
                  <SearchableSelect
                    className={inputClass}
                    onChange={(event) => setEmployeeFilter(event.target.value)}
                    value={employeeFilter}
                  >
                    <option value={allValue}>All visible</option>
                    {visibleEmployees.map((employee) => (
                      <option key={employee.hrId} value={employee.hrId}>
                        {employee.fullName} ({employee.hrId})
                      </option>
                    ))}
                  </SearchableSelect>
                </label>
              )}

              <label className="block">
                <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Line</span>
                <SearchableSelect
                  className={inputClass}
                  onChange={(event) => setLineFilter(event.target.value)}
                  value={lineFilter}
                >
                  <option value={allValue}>All lines</option>
                  {lineOptions.map((line) => <option key={line} value={line}>{line}</option>)}
                </SearchableSelect>
              </label>

              <label className="block">
                <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Department</span>
                <SearchableSelect
                  className={inputClass}
                  onChange={(event) => setDepartmentFilter(event.target.value)}
                  value={departmentFilter}
                >
                  <option value={allValue}>All departments</option>
                  {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
                </SearchableSelect>
              </label>
            </>
          ) : null}

          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Source</span>
            <SearchableSelect
              className={inputClass}
              onChange={(event) => setSourceFilter(event.target.value)}
              value={sourceFilter}
            >
              <option value={allValue}>All sources</option>
              {presentSources.map((source) => (
                <option key={source} value={source}>{privateCalendarSourceLabels[source]}</option>
              ))}
            </SearchableSelect>
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              className={[
                "inline-flex h-10 items-center gap-2 px-3 text-sm font-black ring-1 transition",
                controlRadiusClass,
                exceptionOnly
                  ? "bg-red-50 text-red-700 ring-red-200 hover:bg-red-100"
                  : "bg-slate-100 text-slate-700 ring-slate-200/60 hover:bg-slate-200",
              ].join(" ")}
              onClick={() => setExceptionOnly((value) => !value)}
              type="button"
            >
              <ListFilter className="h-4 w-4" />
              Exceptions
            </button>
            <button
              className={["h-10 bg-slate-100 px-3 text-sm font-black text-slate-600 ring-1 ring-slate-200/60 transition hover:bg-slate-200 disabled:opacity-50", controlRadiusClass].join(" ")}
              disabled={isPending}
              onClick={resetFilters}
              type="button"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="grid gap-4 border-t border-slate-100 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Status</span>
            <SearchableSelect
              className={inputClass}
              onChange={(event) => setStatusFilter(event.target.value)}
              value={statusFilter}
            >
              <option value={allValue}>All statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </SearchableSelect>
          </label>
        </div>
      </section>

      {isTeamView ? <TeamSummaryPanel rows={teamSummary} /> : null}

      {/* ── Source legend / toggle chips ── */}
      {presentSources.length > 0 ? (
        <section className={[secondaryPanelClass, "px-5 py-4"].join(" ")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-1 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Sources</span>
            {presentSources.map((source) => {
              const hidden = hiddenSources.has(source);
              return (
                <button
                  className={[
                    "inline-flex items-center gap-2 border px-3 py-1.5 text-xs font-black uppercase tracking-[0.08em] transition",
                    controlRadiusClass,
                    hidden
                      ? "border-slate-200 bg-slate-50 text-slate-400 line-through"
                      : "border-slate-900 bg-slate-900 text-white",
                  ].join(" ")}
                  key={source}
                  onClick={() => toggleSource(source)}
                  type="button"
                >
                  <span className={["h-2.5 w-2.5 shrink-0 rounded-full", hidden ? "bg-slate-300" : sourceSwatchColor(source)].join(" ")} />
                  <span className="whitespace-nowrap">{privateCalendarSourceLabels[source]}</span>
                </button>
              );
            })}
            {hiddenSources.size > 0 ? (
              <button
                className={["inline-flex items-center px-3 py-1.5 text-xs font-black text-orange-600 transition hover:text-orange-700", controlRadiusClass].join(" ")}
                onClick={() => setHiddenSources(new Set())}
                type="button"
              >
                Show all
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Actionable exceptions strip ── */}
      {filteredExceptions.length > 0 ? (
        <section className={["border-l-4 border-l-red-500", secondaryPanelClass].join(" ")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-5 py-3">
            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-red-700">
              {filteredExceptions.length} {filteredExceptions.every((exception) => exception.title === "No Activity Recorded")
                ? `No Activity Day${filteredExceptions.length === 1 ? "" : "s"}`
                : `Exception${filteredExceptions.length === 1 ? "" : "s"}`} Need Review
            </span>
          </div>
          <div className="divide-y divide-slate-100">
            {filteredExceptions.slice(0, 8).map((exception) => {
              const tone = exceptionTone(exception.severity);
              return (
                <button
                  className={["flex w-full flex-wrap items-center gap-2 px-5 py-3 text-left transition hover:bg-orange-50/40", tone.panel].join(" ")}
                  key={exception.id}
                  onClick={() => focusException(exception.date)}
                  type="button"
                >
                  <span className="whitespace-nowrap font-mono text-phx-xs font-semibold text-slate-500">{reportDateLabel(exception.date)}</span>
                  <span className="whitespace-nowrap text-sm font-black text-slate-900">{exception.title}</span>
                  {exception.employeeName ? (
                    <span className="inline-flex items-center whitespace-nowrap rounded-sm bg-slate-100 px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600">
                      {exception.employeeName}{exception.employeeHrId ? ` (${exception.employeeHrId})` : ""}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center whitespace-nowrap rounded-sm bg-white px-1.5 py-0.5 text-phx-xs font-semibold text-slate-500 ring-1 ring-slate-200/60">
                    {exception.description}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {calendarView === "list" ? (
        <PrivateCalendarAgenda
          agendaDays={agendaDays}
          onSelectDate={setSelectedDate}
          viewMode={viewMode}
        />
      ) : (
      <div className="space-y-6">
        {/* ── Calendar Grid ── */}
        <section className={panelClass}>
          {/* FRIDAY is the only narrow column — do not shrink Saturday back.
              Friday is off for everyone (isFieldWorkforceFriday is unconditional), so it
              stays empty almost every week and gets a fixed minimal width. SATURDAY is
              NOT the weekend for the population this calendar reports on: Medical Rep and
              District (Sales) Manager have a Friday-only weekend
              (isFieldWorkforceFridayOnlyTitle) and work Sat-Wed as full days, so Saturday
              carries real activity chips AND is the day `no_activity_recorded` exceptions
              fire on — see the weekly-off note in src/lib/private-calendar/logic.ts. It
              needs an equal 1fr share like Sun-Thu. Keep this template identical on the
              header row and the day grid below or the columns misalign. */}
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)] bg-slate-950">
            {weekdays.map((weekday) => (
              <div key={weekday} className="px-1 py-3 text-center text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)] divide-x divide-y divide-slate-100">
            {weeks.flatMap((week) => week).map((day, index) => {
              const date = day.date;
              const dayItems = date ? itemsByDay.get(date) ?? [] : [];
              const dayExceptions = date ? exceptionsByDay.get(date) ?? [] : [];
              const selected = date === selectedDate;
              const isToday = date === today;
              // Chips now stack their detail (name / count / area, or Office / From / To /
              // status) across multiple lines instead of one crammed line, so fewer items
              // fit before overflowing — show fewer per cell and give the cell more height.
              const visibleExceptionCount = Math.min(dayExceptions.length, 2);
              const visibleItemCount = Math.min(dayItems.length, dayExceptions.length > 0 ? 1 : 2);
              const hiddenCount = dayItems.length + dayExceptions.length - visibleExceptionCount - visibleItemCount;
              return (
                <button
                  className={[
                    "min-h-[150px] bg-white p-2 text-left align-top transition-colors",
                    day.inMonth ? "text-slate-900 hover:bg-orange-50/50" : "bg-slate-50/40 text-slate-300 hover:bg-orange-50/20",
                    selected ? "ring-2 ring-inset ring-orange-400" : "",
                  ].join(" ")}
                  disabled={!date}
                  key={`${date ?? "blank"}-${index}`}
                  onClick={() => date && setSelectedDate(date)}
                  type="button"
                >
                  <span className="flex items-center justify-between gap-1">
                    <span
                      className={[
                        "flex h-6 w-6 items-center justify-center text-xs font-black",
                        isToday ? "rounded-full bg-orange-500 text-white" : "",
                      ].join(" ")}
                    >
                      {date ? Number(date.slice(8, 10)) : ""}
                    </span>
                    <span className="flex items-center gap-1">
                      {dayExceptions.length > 0 ? (
                        <span className="rounded-full bg-phx-danger-bg px-1.5 py-0.5 text-phx-2xs font-black text-phx-danger">
                          {dayExceptions.length}
                        </span>
                      ) : null}
                      {dayItems.length > 0 ? (
                        <span className="rounded-full bg-phx-paper px-1.5 py-0.5 text-phx-2xs font-black text-phx-ink-soft">
                          {dayItems.length}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="mt-1.5 block space-y-2">
                    {dayExceptions.slice(0, visibleExceptionCount).map((exception) => (
                      <span
                        className="block whitespace-nowrap rounded bg-red-100 px-1.5 py-0.5 text-phx-2xs font-bold text-red-700"
                        key={exception.id}
                        title={exception.description}
                      >
                        {exception.title}
                      </span>
                    ))}
                    {dayItems.slice(0, visibleItemCount).map((item) => {
                      const baseLines = item.chipLines ?? [item.title];
                      const lines = viewMode === "team" && item.employeeName ? [item.employeeName, ...baseLines] : baseLines;
                      return (
                        <span
                          className={["block divide-y divide-black/15 rounded px-1.5 py-0.5 text-phx-2xs font-bold leading-tight", sourceChipTone(item.source, item.severity)].join(" ")}
                          key={item.id}
                          title={chipTitle(item, viewMode)}
                        >
                          {lines.map((line, lineIndex) => (
                            <span className="block py-1 [overflow-wrap:anywhere]" key={lineIndex}>{line}</span>
                          ))}
                        </span>
                      );
                    })}
                    {hiddenCount > 0 ? (
                      <span className="block rounded bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-bold text-slate-500">
                        + {hiddenCount} more
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Daily Timeline ── */}
        <section className={panelClass}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
            <div>
              <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">
                Daily Timeline
              </div>
              <h3 className="mt-1.5 text-xl font-black text-slate-950">{dayLabel(selectedDate)}</h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-phx-paper px-4 py-1.5 text-xs font-black text-phx-ink-soft">
                {timelineItems.length} item{timelineItems.length === 1 ? "" : "s"} · {selectedExceptions.length} exception{selectedExceptions.length === 1 ? "" : "s"}
              </span>
              {canActOnOwnDay ? (
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-sky-300 bg-sky-50 px-3 text-xs font-black text-sky-700 transition hover:bg-sky-100"
                  onClick={() => { setDisputeFormOpen((open) => !open); setDisputeMessage(null); }}
                  type="button"
                >
                  <FileSearch className="h-3.5 w-3.5" />
                  Request review
                </button>
              ) : null}
            </div>
          </div>

          {disputeFormOpen ? (
            <div className="border-b border-sky-200 bg-sky-50/60 px-6 py-4">
              <p className="text-xs font-black uppercase tracking-[0.1em] text-sky-700">Request a Review — {dayLabel(selectedDate)}</p>
              <p className="mt-1 text-xs font-semibold text-sky-800">
                If something here doesn&apos;t look right, let us know what actually happened and where a Super Admin can check.
              </p>
              <textarea
                className="mt-3 w-full rounded-sm border border-sky-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-400 focus:outline-none"
                onChange={(event) => setDisputeClaimText(event.target.value)}
                placeholder="What actually happened this day..."
                rows={3}
                value={disputeClaimText}
              />
              <VerificationSourceMultiSelect
                borderClass="border-sky-200"
                focusRingClass="focus:border-sky-400"
                onChange={setDisputeSourceOptions}
                selected={disputeSourceOptions}
              />
              {disputeSourceOptions.length > 0 ? (
                <input
                  className="mt-2 w-full rounded-sm border border-sky-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-sky-400 focus:outline-none"
                  onChange={(event) => setDisputeSourceDetail(event.target.value)}
                  placeholder={disputeSourceOptions.includes("Other") ? "Describe the source" : "Additional details (optional)"}
                  type="text"
                  value={disputeSourceDetail}
                />
              ) : null}
              {disputeMessage ? <p className="mt-2 text-xs font-bold text-sky-900">{disputeMessage}</p> : null}
              <div className="mt-3 flex items-center gap-2">
                <button
                  className="rounded-sm bg-sky-600 px-4 py-1.5 text-xs font-black text-white transition hover:bg-sky-700 disabled:opacity-50"
                  disabled={disputeSubmitting}
                  onClick={submitDayDispute}
                  type="button"
                >
                  {disputeSubmitting ? "Submitting…" : "Submit"}
                </button>
                <button
                  className="rounded-sm border border-sky-300 px-4 py-1.5 text-xs font-black text-sky-700 transition hover:bg-sky-100"
                  onClick={() => setDisputeFormOpen(false)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-6 p-6 xl:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
            {selectedExceptions.length > 0 ? (
              <section>
                <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-red-600">
                  <AlertTriangle className="h-4 w-4" />
                  Exception Warnings
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  {selectedExceptions.map((exception) => <ExceptionItem exception={exception} key={exception.id} />)}
                </div>
              </section>
            ) : null}

            <section className={selectedExceptions.length > 0 ? "min-w-0" : "min-w-0 xl:col-span-2"}>
              {timelineItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-sm border border-dashed border-slate-200 bg-slate-50/60 py-10 text-center">
                  <p className="text-sm font-semibold text-slate-400">No calendar items for this day.</p>
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                  {timelineItems.map((item) => (
                    <TimelineItem item={item} key={item.id} viewMode={viewMode} />
                  ))}
                </div>
              )}
            </section>
          </div>
        </section>
      </div>
      )}
    </div>
  );
}

function PrivateCalendarAgenda({
  agendaDays,
  onSelectDate,
  viewMode,
}: {
  agendaDays: { date: string; dayExceptions: PrivateCalendarException[]; dayItems: PrivateCalendarItem[] }[];
  onSelectDate: (date: string) => void;
  viewMode: PrivateCalendarViewMode;
}) {
  if (agendaDays.length === 0) {
    return (
      <div className="border border-slate-200 bg-white p-10 text-center shadow-sm">
        <p className="text-sm font-bold text-slate-500">No calendar items this month.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {agendaDays.map(({ date, dayExceptions, dayItems }) => (
        <div className="overflow-hidden border border-slate-200 bg-white shadow-sm" key={date}>
          <button
            className="flex w-full items-center justify-between gap-2 bg-slate-900 px-4 py-2.5 text-left transition-colors hover:bg-slate-800"
            onClick={() => onSelectDate(date)}
            type="button"
          >
            <span className="whitespace-nowrap text-sm font-black text-white">{dayLabel(date)}</span>
            <span className="whitespace-nowrap text-phx-xs font-bold text-slate-300">
              {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
              {dayExceptions.length > 0 ? ` · ${dayExceptions.length} exception${dayExceptions.length === 1 ? "" : "s"}` : ""}
            </span>
          </button>
          <div className="divide-y divide-slate-100">
            {dayExceptions.map((exception) => {
              const tone = exceptionTone(exception.severity);
              return (
                <div className={["px-4 py-3", tone.panel].join(" ")} key={exception.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={["inline-block h-2.5 w-2.5 shrink-0 rounded-full", tone.dot].join(" ")} />
                    <span className="whitespace-nowrap text-sm font-black text-slate-900">{exception.title}</span>
                    <span className={["ml-auto inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em]", tone.badge].join(" ")}>
                      Exception
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                    {exception.employeeName ? (
                      <span className="inline-flex items-center whitespace-nowrap rounded-sm bg-slate-50 px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600">
                        {exception.employeeName}{exception.employeeHrId ? ` (${exception.employeeHrId})` : ""}
                      </span>
                    ) : null}
                    <span className="inline-flex items-center whitespace-nowrap rounded-sm bg-slate-50 px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600">
                      {exception.description}
                    </span>
                  </div>
                </div>
              );
            })}
            {dayItems.map((item) => {
              const meta = [
                viewMode === "team" ? item.employeeName : null,
                item.time,
                ...item.detailLines,
                item.description,
              ].filter((value): value is string => Boolean(value));
              return (
                <div className="px-4 py-3" key={item.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={["inline-block h-2.5 w-2.5 shrink-0 rounded-full", sourceSwatchColor(item.source)].join(" ")} />
                    <span className="whitespace-nowrap text-sm font-black text-slate-900">{item.title}</span>
                    <span className={["inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em]", sourceChipTone(item.source, item.severity)].join(" ")}>
                      {privateCalendarSourceLabels[item.source]}
                    </span>
                    {item.status ? (
                      <span className="ml-auto inline-flex items-center whitespace-nowrap rounded-full bg-phx-paper px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-phx-ink-soft">
                        {item.status}
                      </span>
                    ) : null}
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
                  {item.exceptionFlags.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                      {item.exceptionFlags.map((flag) => (
                        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-phx-danger-bg px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-phx-danger" key={flag}>
                          {flag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({
  label,
  ready,
  tone = "neutral",
  value,
}: {
  label: string;
  ready: boolean;
  tone?: "neutral" | "warning";
  value: number;
}) {
  return (
    <div className={["rounded-sm border p-4", tone === "warning" ? "bg-red-50/60 border-red-100" : "bg-slate-50/60 border-slate-200"].join(" ")}>
      <div className="flex items-center justify-end">
        <span className={["rounded-full px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em]", ready ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"].join(" ")}>
          {ready ? "Ready" : "N/A"}
        </span>
      </div>
      <p className="mt-3 text-3xl font-black text-slate-950">{value}</p>
      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
    </div>
  );
}

function TeamSummaryPanel({ rows }: { rows: PrivateCalendarWorkspace["teamSummary"] }) {
  const sortedRows = [...rows].sort((left, right) => right.exceptionCount - left.exceptionCount || left.fullName.localeCompare(right.fullName));
  return (
    <section className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
        <div>
          <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">
            Manager Team Calendar
          </div>
          <h3 className="mt-1 text-lg font-black text-slate-950">Visible employees snapshot</h3>
        </div>
        <span className="rounded-sm bg-slate-100 px-4 py-1.5 text-xs font-black text-slate-600">
          {rows.length} employee{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid max-h-72 gap-3 overflow-y-auto p-5 md:grid-cols-2 xl:grid-cols-3">
        {sortedRows.slice(0, 18).map((row) => (
          <article key={row.hrId} className="rounded-sm border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="whitespace-nowrap text-sm font-black text-slate-900">{row.fullName}</h4>
                <p className="mt-0.5 whitespace-nowrap text-phx-xs font-semibold text-slate-400">
                  {row.hrId}{row.lineName ? ` · ${row.lineName}` : ""}
                </p>
              </div>
              <span className={["shrink-0 rounded-full px-2.5 py-0.5 text-phx-2xs font-black", row.exceptionCount ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"].join(" ")}>
                {row.exceptionCount} warn{row.exceptionCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-1.5 text-center text-phx-2xs font-black text-slate-500">
              <span className="rounded-sm bg-emerald-100 px-1 py-1.5 text-emerald-700">A {row.sourceCounts.attendance}</span>
              <span className="rounded-sm bg-blue-100 px-1 py-1.5 text-blue-700">V {row.sourceCounts.vacation}</span>
              <span className="rounded-sm bg-amber-100 px-1 py-1.5 text-amber-700">E {row.sourceCounts.excuse}</span>
              <span className="rounded-sm bg-indigo-100 px-1 py-1.5 text-indigo-700">D {row.sourceCounts.double_visit}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// Multi-select "where can a Super Admin verify this" dropdown used by the
// Request Review form — a day's claim can point to more than one source at
// once (e.g. both CRM and a manager confirmation).
function VerificationSourceMultiSelect({
  borderClass,
  focusRingClass,
  onChange,
  selected,
}: {
  borderClass: string;
  focusRingClass: string;
  onChange: (next: string[]) => void;
  selected: string[];
}) {
  const [open, setOpen] = useState(false);

  function toggle(option: string) {
    onChange(selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option]);
  }

  return (
    <div className="relative mt-2">
      <button
        className={["flex w-full items-center justify-between rounded-sm border bg-white px-3 py-2 text-left text-sm text-slate-900 focus:outline-none", borderClass, focusRingClass].join(" ")}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className={selected.length > 0 ? "text-slate-900" : "text-slate-400"}>
          {selected.length > 0 ? selected.join(", ") : "Where can a Super Admin verify this?"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 w-full rounded-sm border border-slate-200 bg-white p-1.5 shadow-lg">
          {verificationSourceOptions.map((option) => (
            <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50" key={option}>
              <input checked={selected.includes(option)} onChange={() => toggle(option)} type="checkbox" />
              {option}
            </label>
          ))}
          <button
            className="mt-1 w-full rounded-sm bg-slate-100 px-2 py-1.5 text-xs font-black text-slate-600 hover:bg-slate-200"
            onClick={() => setOpen(false)}
            type="button"
          >
            Done
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ExceptionItem({ exception }: { exception: PrivateCalendarException }) {
  const tone = exceptionTone(exception.severity);
  const isDanger = exception.severity === "danger";
  return (
    <article className={["rounded-sm border-l-4 p-4 shadow-sm ring-1", tone.border, tone.panelStrong].join(" ")}>
      <div className="min-w-0">
        <h4 className={["text-sm font-black", isDanger ? "text-red-900" : "text-amber-900"].join(" ")}>
          {exception.title}
        </h4>
        {exception.employeeName ? (
          <p className={["mt-1 text-xs font-semibold", tone.text].join(" ")}>
            {exception.employeeName}{exception.employeeHrId ? ` (${exception.employeeHrId})` : ""}
          </p>
        ) : null}
      </div>
      <p className={["mt-2.5 text-xs font-semibold leading-relaxed", tone.text].join(" ")}>
        {exception.description}
      </p>
    </article>
  );
}

function TimelineItem({ item, viewMode }: { item: PrivateCalendarItem; viewMode: PrivateCalendarViewMode }) {
  return (
    <article className={["overflow-hidden rounded-sm border-l-4 bg-white shadow-sm ring-1 ring-slate-200/60", sourceAccentColor(item.source, item.severity)].join(" ")}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={["inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em]", sourceChipTone(item.source, item.severity)].join(" ")}>
                {privateCalendarSourceLabels[item.source]}
              </span>
              {item.time ? (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-phx-2xs font-black text-slate-600">
                  {item.time}
                </span>
              ) : null}
            </div>
            <h4 className="mt-2 text-sm font-black text-slate-950">{item.title}</h4>
            {viewMode === "team" && item.employeeName ? (
              <p className="mt-1 text-xs font-semibold text-slate-500">
                {item.employeeName}{item.employeeHrId ? ` (${item.employeeHrId})` : ""}
              </p>
            ) : null}
          </div>
          {item.status ? (
            <span className="shrink-0 rounded-full bg-phx-paper px-2.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-phx-ink-soft">
              {item.status}
            </span>
          ) : null}
        </div>

        {item.exceptionFlags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {item.exceptionFlags.map((flag) => (
              <span key={flag} className="rounded-full bg-phx-danger-bg px-2.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-phx-danger">
                {flag}
              </span>
            ))}
          </div>
        ) : null}

        {item.detailLines.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs font-semibold text-slate-600">
            {item.detailLines.map((line) => <li key={line} className="flex items-start gap-1.5"><span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-slate-400" />{line}</li>)}
          </ul>
        ) : null}

        {item.description ? (
          <p className="mt-3 text-xs font-semibold leading-relaxed text-slate-500">{item.description}</p>
        ) : null}

        {item.approvalImpact ? (
          <div className="mt-3 rounded-sm bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700 ring-1 ring-slate-200/60">
            {item.approvalImpact}
          </div>
        ) : null}

        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
            <FileSearch className="h-3 w-3" />
            Source trace
          </div>
          <p className="mt-1 text-phx-xs font-semibold text-slate-500">{item.sourceLabel}</p>
          <p className="text-phx-xs font-semibold text-slate-400">{item.sourceSystem}{item.sourceTable ? ` · ${item.sourceTable}` : ""}</p>
          {item.sourceRecordId ? <p className="font-mono text-phx-xs text-slate-400">ID: {item.sourceRecordId}</p> : null}
        </div>
      </div>
    </article>
  );
}
