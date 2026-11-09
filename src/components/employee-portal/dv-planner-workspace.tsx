"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertTriangle,
  CalendarCheck2,
  CalendarSearch,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Hourglass,
  Search,
  XCircle,
} from "lucide-react";

import { canonicalHrIdKey } from "@/lib/hr-id";
import { checkPlannedDate } from "@/lib/double-visit-analytics/date-check";
import { summarizeRosterCoverage, type DvCoverageSummary } from "@/lib/double-visit-analytics/roster-summary";
import { entryPeriodLabel } from "@/lib/double-visit-analytics/count-bucket";
import type {
  DoubleVisitReportRow,
  DoubleVisitRosterEntry,
  DoubleVisitStartingSoonEntry,
} from "@/lib/double-visit-analytics/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminChipDepthClassName, adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

// Per-rep "planned date" tracker: pick the date you chose to visit a rep, see whether CRM
// confirmed a DV on that exact day using the roster already loaded — no separate fetch. Client-only
// (localStorage), same key format as the original single-rep/date checker this page replaced, so
// any dates already saved there keep working.
type PlannedDates = Record<string, string>;

const DV_PLANNER_STORAGE_EVENT = "phoenix-dv-planner-change";

function usePlannedDates(storageKey: string): PlannedDates {
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener("storage", callback);
    window.addEventListener(DV_PLANNER_STORAGE_EVENT, callback);
    return () => {
      window.removeEventListener("storage", callback);
      window.removeEventListener(DV_PLANNER_STORAGE_EVENT, callback);
    };
  }, []);
  const getSnapshot = useCallback(() => {
    try {
      return window.localStorage.getItem(storageKey) ?? "{}";
    } catch {
      return "{}";
    }
  }, [storageKey]);
  const serialized = useSyncExternalStore(subscribe, getSnapshot, () => "{}");
  return useMemo(() => {
    try {
      return JSON.parse(serialized) as PlannedDates;
    } catch {
      return {};
    }
  }, [serialized]);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return stableEnGbFormatter({
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

// The directory stores some names in capitals ("SAHAR EL GALLAD"). A name written wholly in capitals
// is shown in normal case; a name that already carries lower-case letters is left exactly as typed.
function displayPersonName(value: string) {
  if (!/[A-Z]/.test(value) || /[a-z]/.test(value)) return value;
  return value.toLowerCase().replace(/(^|[\s\-'’(])(\p{L})/gu, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

function isoDaysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function isoStartOfMonth(monthsAgo: number) {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - monthsAgo);
  return date.toISOString().slice(0, 10);
}

function isoEndOfMonth(monthsAgo: number) {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - monthsAgo + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

const PERIOD_PRESETS = [
  { label: "Last 30 Days", from: () => isoDaysAgo(30), to: isoToday },
  { label: "This Month", from: () => isoStartOfMonth(0), to: isoToday },
  { label: "Last Month", from: () => isoStartOfMonth(1), to: () => isoEndOfMonth(1) },
] as const;

function PeriodFilterBar({ dateFrom, dateTo }: { dateFrom: string; dateTo: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);

  function apply(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams({ dateFrom: nextFrom, dateTo: nextTo });
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className={`flex flex-wrap items-end gap-3 border border-slate-200 bg-white px-5 py-4 ${adminSoftDepthClassName}`}>
      <div className="flex flex-wrap gap-2">
        {PERIOD_PRESETS.map((preset) => (
          <button
            className={`h-9 border border-slate-200 bg-slate-50 px-3 text-xs font-bold text-slate-600 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 ${adminControlDepthClassName}`}
            key={preset.label}
            onClick={() => {
              const nextFrom = preset.from();
              const nextTo = preset.to();
              setFrom(nextFrom);
              setTo(nextTo);
              apply(nextFrom, nextTo);
            }}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>
      <span className="h-9 w-px bg-slate-200" />
      <label className="flex flex-col gap-1 text-phx-sm font-bold uppercase tracking-wider text-slate-400">
        From
        <input
          className={phxFieldClassName}
          max={to}
          onChange={(event) => setFrom(event.target.value)}
          type="date"
          value={from}
        />
      </label>
      <label className="flex flex-col gap-1 text-phx-sm font-bold uppercase tracking-wider text-slate-400">
        To
        <input
          className={phxFieldClassName}
          min={from}
          onChange={(event) => setTo(event.target.value)}
          type="date"
          value={to}
        />
      </label>
      <button
        className="h-9 border border-slate-200 bg-white px-4 text-xs font-bold text-slate-900 shadow-sm transition hover:border-orange-300 hover:text-orange-700"
        onClick={() => apply(from, to)}
        type="button"
      >
        Apply Period
      </button>
    </div>
  );
}

function groupVisitsByDay(visits: DoubleVisitReportRow[]) {
  const byDay = new Map<string, DoubleVisitReportRow[]>();
  for (const visit of visits) {
    byDay.set(visit.activityDate, [...(byDay.get(visit.activityDate) ?? []), visit]);
  }
  return Array.from(byDay.entries())
    .map(([date, dayVisits]) => ({ date, visits: dayVisits }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function groupVisitsByRole(visits: DoubleVisitReportRow[]) {
  // A chain visit is in BOTH managers' records (owner, 2026-10-08), so it appears under each one's role,
  // named by that manager — the rep's own total above still counts it once.
  const byRole = new Map<string, DoubleVisitReportRow[]>();
  for (const visit of visits) {
    const views: DoubleVisitReportRow[] =
      visit.doubleVisitor2HrId || visit.doubleVisitor2Name
        ? [
            visit,
            {
              ...visit,
              doubleVisitorHrId: visit.doubleVisitor2HrId ?? null,
              doubleVisitorName: visit.doubleVisitor2Name ?? null,
              doubleVisitorRole: visit.doubleVisitor2Role ?? null,
            },
          ]
        : [visit];
    for (const view of views) {
      const key = view.doubleVisitorRole ?? "Unmapped role";
      byRole.set(key, [...(byRole.get(key) ?? []), view]);
    }
  }
  return Array.from(byRole.entries())
    .map(([role, roleVisits]) => {
      const dates = roleVisits.map((v) => v.activityDate).sort();
      return {
        role,
        count: roleVisits.length,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
        visitorNames: Array.from(new Set(roleVisits.map((v) => v.doubleVisitorName).filter((name): name is string => Boolean(name)))),
      };
    })
    .sort((a, b) => b.count - a.count);
}

function RoleBreakdown({ visits }: { visits: DoubleVisitReportRow[] }) {
  const roles = useMemo(() => groupVisitsByRole(visits), [visits]);
  const multipleRoles = roles.length > 1;
  return (
    <div className="border-b border-slate-200 bg-white px-4 py-2.5">
      <p className="mb-1.5 text-phx-sm font-black uppercase tracking-wider text-slate-400">
        Visited by {multipleRoles ? `${roles.length} different roles` : "1 role only"}
      </p>
      <div className="space-y-1">
        {roles.map((entry) => (
          <div className="flex items-center justify-between gap-3 text-xs" key={entry.role}>
            <span className="min-w-0 break-words font-semibold leading-snug text-slate-700">
              {entry.role}
              {entry.visitorNames.length > 0 ? ` (${entry.visitorNames.join(", ")})` : ""}
            </span>
            <span className="shrink-0 whitespace-nowrap text-slate-500">
              {entry.count}x ·{" "}
              {entry.firstDate === entry.lastDate ? formatDate(entry.firstDate) : `${formatDate(entry.firstDate)} – ${formatDate(entry.lastDate)}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VisitHistory({ visits }: { visits: DoubleVisitReportRow[] }) {
  if (visits.length === 0) {
    return <p className="px-4 py-3 text-xs text-slate-500">No double visits recorded in this period.</p>;
  }
  const days = groupVisitsByDay(visits);
  return (
    <div>
      <RoleBreakdown visits={visits} />
      <div className="divide-y divide-slate-100 bg-slate-50/60">
        {days.map((day) => (
          <div className="px-4 py-2.5" key={day.date}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-bold text-slate-800">{formatDate(day.date)}</span>
              <span className="font-bold text-blue-700">
                {day.visits.length} visit{day.visits.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-1 space-y-0.5">
              {day.visits.map((visit, index) => (
                <div className="flex items-center justify-between gap-3 text-phx-xs text-slate-500" key={`${day.date}-${index}`}>
                  <span className="text-slate-400">{entryPeriodLabel(visit)}</span>
                  <span className="min-w-0 flex-1 break-words text-right leading-snug">
                    {visit.doubleVisitorName ?? "Unknown"}
                    {visit.doubleVisitorRole ? ` · ${visit.doubleVisitorRole}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DateCheckBadge({ result }: { result: ReturnType<typeof checkPlannedDate> }) {
  if (!result) return null;
  if (result.status === "future") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-blue-200 bg-blue-50 px-2 py-1 text-phx-sm font-bold uppercase text-blue-700">
        <Clock className="h-3 w-3" />
        Planned — not due yet
      </span>
    );
  }
  if (result.status === "confirmed") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 py-1 text-phx-sm font-bold text-emerald-700">
        <CheckCircle2 className="h-3 w-3" />
        Confirmed{result.visitorNames.length > 0 ? ` · with ${result.visitorNames.map(displayPersonName).join(", ")}` : ""}
      </span>
    );
  }
  if (result.status === "outside-range") {
    return (
      <span className={`inline-flex items-center gap-1 whitespace-nowrap border border-slate-200 bg-slate-50 px-2 py-1 text-phx-sm font-bold uppercase text-slate-500 ${adminChipDepthClassName}`}>
        <CalendarSearch className="h-3 w-3" />
        Widen date range above
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border border-rose-200 bg-rose-50 px-2 py-1 text-phx-sm font-bold uppercase text-rose-700">
      <XCircle className="h-3 w-3" />
      Not recorded that day
    </span>
  );
}

function RosterRow({
  dateCheckMode,
  dateFrom,
  dateTo,
  entry,
  onSetPlannedDate,
  plannedDate,
  today,
  visits,
}: {
  dateCheckMode: boolean;
  dateFrom: string;
  dateTo: string;
  entry: DoubleVisitRosterEntry;
  onSetPlannedDate: (hrId: string, date: string) => void;
  plannedDate: string;
  today: string;
  visits: DoubleVisitReportRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = entry.visited;
  const dayCount = useMemo(() => new Set(visits.map((visit) => visit.activityDate)).size, [visits]);
  const dateCheckResult = useMemo(
    () => checkPlannedDate({ dateFrom, dateTo, plannedDate, today, visits }),
    [dateFrom, dateTo, plannedDate, today, visits],
  );

  return (
    <div className="bg-white">
      <div
        className={`grid grid-cols-1 gap-3 px-5 py-4 transition md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center ${
          canExpand ? "cursor-pointer hover:bg-blue-50/45" : ""
        }`}
        onClick={() => canExpand && setExpanded((value) => !value)}
      >
        <div className="min-w-0">
          <p className="break-words text-sm font-bold leading-snug text-slate-950">{displayPersonName(entry.name)}</p>
          <p className="mt-0.5 break-words text-xs leading-snug text-slate-500">
            {[entry.areaName, entry.lineName].filter(Boolean).join(" · ") || "Scope member"} · Hired{" "}
            {formatDate(entry.hireDate)}
          </p>
        </div>

        <div>
          {entry.onProbation ? (
            <span className="inline-flex items-center gap-1 whitespace-nowrap border border-orange-200 bg-orange-50 px-2 py-1 text-phx-sm font-bold uppercase text-orange-700">
              <Hourglass className="h-3 w-3" />
              Probation
              {entry.probationDaysRemaining != null && entry.probationDaysRemaining > 0
                ? ` · ${entry.probationDaysRemaining}d left`
                : ""}
            </span>
          ) : (
            <span className="text-xs text-slate-300">—</span>
          )}
        </div>

        <div>
          {entry.visited ? (
            <span className="inline-flex items-center gap-1 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 py-1 text-phx-sm font-bold text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              {entry.visitCount} DV{entry.visitCount === 1 ? "" : "s"} / {dayCount} day{dayCount === 1 ? "" : "s"} · last {formatDate(entry.lastVisitDate)}
            </span>
          ) : entry.lastVisitDateEver ? (
            // Not visited in the selected window, but HAS an older DV — the "getting stale" signal.
            <span
              className={`inline-flex items-center gap-1 whitespace-nowrap border px-2 py-1 text-phx-sm font-bold ${
                entry.cadenceBand === "critical"
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              <Clock className="h-3 w-3" />
              Last DV {entry.daysSinceLastVisit}d ago · {formatDate(entry.lastVisitDateEver)}
            </span>
          ) : (
            // No DV at all within the cadence lookback — truly never visited. The tone follows the
            // cadence band, which for a never-visited rep runs from the hire date (30/60): a rep who
            // started two days ago is not overdue, so the badge stays neutral until day 31.
            <span
              className={`inline-flex items-center gap-1 whitespace-nowrap border px-2 py-1 text-phx-sm font-bold ${
                entry.cadenceBand === "critical"
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : entry.cadenceBand === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-slate-200 bg-slate-50 text-slate-600"
              }`}
            >
              <AlertTriangle className="h-3 w-3" />
              Never visited{entry.daysSinceHire != null ? ` · ${entry.daysSinceHire}d since hire` : ""}
            </span>
          )}
        </div>

        <div className="flex justify-end">
          {canExpand ? (
            expanded ? (
              <ChevronDown className="h-4 w-4 text-slate-400" />
            ) : (
              <ChevronRight className="h-4 w-4 text-slate-400" />
            )
          ) : null}
        </div>
      </div>
      {dateCheckMode ? (
        <div
          className="flex flex-wrap items-center gap-3 border-t border-dashed border-slate-200 bg-slate-50/70 px-5 py-2.5"
          onClick={(event) => event.stopPropagation()}
        >
          <label className="flex items-center gap-2 text-phx-xs font-bold uppercase tracking-wider text-slate-500">
            Planned date
            <input
              className={phxFieldClassName}
              max={dateTo}
              min={dateFrom}
              onChange={(event) => onSetPlannedDate(entry.hrId, event.target.value)}
              type="date"
              value={plannedDate}
            />
          </label>
          {dateCheckResult ? <DateCheckBadge result={dateCheckResult} /> : (
            <span className="text-phx-xs text-slate-400">Pick the date you chose for this rep.</span>
          )}
        </div>
      ) : null}
      {canExpand && expanded ? <VisitHistory visits={visits} /> : null}
    </div>
  );
}

type SortMode = "alarms" | "overdue" | "lastVisit" | "name";

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: "alarms", label: "Alarms first" },
  { key: "overdue", label: "Most overdue" },
  { key: "lastVisit", label: "Last visit" },
  { key: "name", label: "Name" },
];

type FilterKey = "neverVisited" | "overdue" | "probation" | "visited";

const FILTER_OPTIONS: { key: FilterKey; label: string; predicate: (entry: DoubleVisitRosterEntry) => boolean }[] = [
  { key: "neverVisited", label: "Never visited", predicate: (entry) => !entry.visited },
  { key: "overdue", label: "Overdue", predicate: (entry) => entry.cadenceOverdue },
  { key: "probation", label: "Probation", predicate: (entry) => entry.onProbation },
  { key: "visited", label: "Visited", predicate: (entry) => entry.visited },
];

function sortRoster(entries: DoubleVisitRosterEntry[], mode: SortMode): DoubleVisitRosterEntry[] {
  const copy = [...entries];
  if (mode === "overdue") {
    // Most days since the last visit first. A never-visited rep is measured from their hire date —
    // the same clock the overdue band uses — so a rep who started this week sorts with the fresh ones.
    const overdueDays = (entry: DoubleVisitRosterEntry) => entry.daysSinceLastVisit ?? entry.daysSinceHire ?? Number.POSITIVE_INFINITY;
    return copy.sort((a, b) => overdueDays(b) - overdueDays(a) || a.name.localeCompare(b.name));
  }
  if (mode === "lastVisit") {
    return copy.sort((a, b) => (b.lastVisitDateEver ?? "").localeCompare(a.lastVisitDateEver ?? "") || a.name.localeCompare(b.name));
  }
  if (mode === "name") {
    return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
  // "alarms" — probation first, then never-visited, then the rest; alphabetical within a band.
  return copy.sort((a, b) => {
    const weight = (entry: DoubleVisitRosterEntry) => (entry.onProbation ? 0 : !entry.visited ? 1 : 2);
    return weight(a) - weight(b) || a.name.localeCompare(b.name);
  });
}

function groupRosterByLineAndManager(roster: DoubleVisitRosterEntry[]) {
  const byLine = new Map<string, DoubleVisitRosterEntry[]>();
  for (const entry of roster) {
    const line = entry.lineName ?? "No line on file";
    byLine.set(line, [...(byLine.get(line) ?? []), entry]);
  }
  return Array.from(byLine.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([lineName, lineEntries]) => {
      const byManager = new Map<string, DoubleVisitRosterEntry[]>();
      for (const entry of lineEntries) {
        const manager = entry.managerName ?? "No manager on file";
        byManager.set(manager, [...(byManager.get(manager) ?? []), entry]);
      }
      const managerGroups = Array.from(byManager.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([managerName, reps]) => ({ managerName, reps }));
      return { lineName, managerGroups, reps: lineEntries };
    });
}

// Coverage readout for a group header — a mini bar + %, plus alarm counts. `tone` adapts the
// neutral text so it reads on the navy line header (dark) and the slate DM header (light).
function GroupCoverage({ summary, tone }: { summary: DvCoverageSummary; tone: "dark" | "light" }) {
  const neutral = tone === "dark" ? "text-slate-300" : "text-slate-500";
  const track = tone === "dark" ? "bg-white/20" : "bg-slate-200";
  return (
    <span className="flex shrink-0 items-center gap-2 text-phx-sm font-bold uppercase tracking-wider">
      <span className={`hidden h-1.5 w-16 overflow-hidden sm:flex ${track}`}>
        <span className="bg-emerald-500" style={{ width: `${summary.coveragePct}%` }} />
      </span>
      <span className={tone === "dark" ? "text-white" : "text-slate-800"}>{summary.coveragePct}%</span>
      <span className={neutral}>{summary.total}</span>
      {summary.neverVisited > 0 ? <span className="text-rose-500">{summary.neverVisited} never</span> : null}
      {summary.overdue > 0 ? <span className="text-amber-500">{summary.overdue} overdue</span> : null}
      {summary.onProbation > 0 ? <span className="text-orange-400">{summary.onProbation} prob</span> : null}
    </span>
  );
}

export function DvPlannerWorkspace({
  dateFrom,
  dateTo,
  roster,
  rows,
  startingSoon = [],
  viewerHrId,
}: {
  dateFrom: string;
  dateTo: string;
  roster: DoubleVisitRosterEntry[];
  rows: DoubleVisitReportRow[];
  /** Reps whose hire date is after today: named here, counted nowhere (not in the scorecard). */
  startingSoon?: DoubleVisitStartingSoonEntry[];
  viewerHrId: string;
}) {
  const [search, setSearch] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());
  const [sortMode, setSortMode] = useState<SortMode>("alarms");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dateCheckMode, setDateCheckMode] = useState(false);
  const today = useMemo(() => isoToday(), []);
  const plannedDatesStorageKey = `phoenix-dv-planner:${viewerHrId.toLowerCase()}`;
  const plannedDates = usePlannedDates(plannedDatesStorageKey);

  function setPlannedDate(hrId: string, date: string) {
    const key = canonicalHrIdKey(hrId) ?? hrId.toLowerCase();
    const next = { ...plannedDates };
    if (date) next[key] = date;
    else delete next[key];
    try {
      window.localStorage.setItem(plannedDatesStorageKey, JSON.stringify(next));
      window.dispatchEvent(new Event(DV_PLANNER_STORAGE_EVENT));
    } catch {
      // The date check still works for this session when browser storage is unavailable.
    }
  }

  function toggleFilter(key: FilterKey) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visitsByRepKey = useMemo(() => {
    const result = new Map<string, DoubleVisitReportRow[]>();
    for (const row of rows) {
      const key = canonicalHrIdKey(row.visitedHrId);
      if (!key) continue;
      result.set(key, [...(result.get(key) ?? []), row]);
    }
    return result;
  }, [rows]);

  const filteredRoster = useMemo(() => {
    const term = search.trim().toLowerCase();
    const active = FILTER_OPTIONS.filter((option) => activeFilters.has(option.key));
    const matches = roster.filter((entry) => {
      const searchOk =
        !term ||
        [entry.name, entry.hrId, entry.areaName, entry.lineName, entry.managerName]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term));
      // Chips are OR-combined: with none active, show everyone.
      const filterOk = active.length === 0 || active.some((option) => option.predicate(entry));
      return searchOk && filterOk;
    });
    return sortRoster(matches, sortMode);
  }, [roster, search, activeFilters, sortMode]);

  const overall = useMemo(() => summarizeRosterCoverage(roster), [roster]);
  const lineGroups = useMemo(() => groupRosterByLineAndManager(filteredRoster), [filteredRoster]);

  return (
    <div className="space-y-4">
      <PeriodFilterBar dateFrom={dateFrom} dateTo={dateTo} />

      {/* Scorecard */}
      <div className={`border border-slate-200 bg-white px-5 py-4 ${adminSoftDepthClassName}`}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              <span className="text-2xl font-black tabular-nums text-slate-950">{overall.coveragePct}%</span>
              <span className="text-phx-sm font-bold uppercase tracking-wider text-slate-400">Coverage</span>
            </div>
            <div className="flex h-8 w-40 overflow-hidden bg-slate-200">
              <span className="bg-emerald-500" style={{ width: `${overall.coveragePct}%` }} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-bold">
            <span className="flex items-center gap-1.5 text-slate-900">
              <CalendarCheck2 className="h-3.5 w-3.5 text-blue-600" />
              {overall.total} in scope
            </span>
            <span className="text-emerald-700">{overall.covered} visited</span>
            <span className="text-rose-700">{overall.neverVisited} never visited</span>
            <span className="text-amber-700">{overall.overdue} overdue</span>
            <span className="text-orange-700">{overall.onProbation} on probation</span>
            {overall.probationDvPending > 0 ? (
              <span className="text-orange-700">{overall.probationDvPending} probation DV pending</span>
            ) : null}
          </div>
          <span className="ml-auto text-xs font-medium text-slate-400">
            {formatDate(dateFrom)} – {formatDate(dateTo)}
          </span>
        </div>
      </div>

      {startingSoon.length > 0 ? (
        // Not counted in any figure above: a rep joins the roster on their hire date.
        <div className={`border border-slate-200 bg-white px-5 py-3 text-xs leading-5 text-slate-600 ${adminSoftDepthClassName}`}>
          <span className="font-bold text-slate-900">Starting soon · not counted yet: </span>
          {startingSoon
            .map(
              (entry) =>
                `${displayPersonName(entry.name)}${entry.areaName ? ` (${entry.areaName})` : ""}, starts ${formatDate(entry.hireDate)}`,
            )
            .join(" · ")}
        </div>
      ) : null}

      <section className="overflow-hidden border border-slate-200 bg-[#f8fbff] shadow-[0_18px_45px_rgba(30,64,175,0.08)]">
        <div className="space-y-3 border-b border-slate-200 bg-white px-5 py-4">
          <label className="relative block min-w-0">
            <span className="sr-only">Search Medical Reps</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className={cn(phxFieldClassName, "pl-10")}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search rep, HR ID, area, line or manager"
              type="search"
              value={search}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {FILTER_OPTIONS.map((option) => {
              const active = activeFilters.has(option.key);
              return (
                <button
                  className={`h-8 border px-3 text-phx-xs font-bold uppercase tracking-wide transition ${
                    active
                      ? "border-orange-500 bg-orange-500 text-white shadow-sm"
                      : "border-slate-200 bg-white text-slate-600 hover:border-orange-300 hover:text-orange-600"
                  }`}
                  key={option.key}
                  onClick={() => toggleFilter(option.key)}
                  type="button"
                  aria-pressed={active}
                >
                  {option.label}
                </button>
              );
            })}
            {activeFilters.size > 0 ? (
              <button
                className="h-8 px-2 text-phx-xs font-bold uppercase tracking-wide text-slate-400 transition hover:text-slate-700"
                onClick={() => setActiveFilters(new Set())}
                type="button"
              >
                Clear
              </button>
            ) : null}
            <button
              className={`inline-flex h-8 items-center gap-1.5 border px-3 text-phx-xs font-bold uppercase tracking-wide transition ${
                dateCheckMode
                  ? "border-blue-600 bg-blue-600 text-white shadow-sm"
                  : "border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700"
              }`}
              onClick={() => setDateCheckMode((value) => !value)}
              type="button"
              aria-pressed={dateCheckMode}
              title="Pick a date per rep and check whether CRM confirmed a DV that day"
            >
              <CalendarSearch className="h-3.5 w-3.5" />
              Date Check
            </button>
            <span className="ml-auto inline-flex items-center overflow-hidden border border-slate-200">
              {SORT_OPTIONS.map((option) => (
                <button
                  className={`h-8 px-3 text-phx-xs font-bold uppercase tracking-wide transition ${
                    sortMode === option.key ? "bg-slate-900 text-white" : "bg-white text-slate-500 hover:bg-slate-100"
                  }`}
                  key={option.key}
                  onClick={() => setSortMode(option.key)}
                  type="button"
                  aria-pressed={sortMode === option.key}
                >
                  {option.label}
                </button>
              ))}
            </span>
          </div>
        </div>

        <div>
          {lineGroups.map((lineGroup) => {
            const lineKey = `line:${lineGroup.lineName}`;
            const lineCollapsed = collapsed.has(lineKey);
            const lineSummary = summarizeRosterCoverage(lineGroup.reps);
            return (
              <div key={lineGroup.lineName}>
                <button
                  className="flex w-full items-center justify-between gap-3 border-b border-slate-200 bg-[#172554] px-5 py-2.5 text-left transition hover:bg-[#1e3a8a]"
                  onClick={() => toggleCollapse(lineKey)}
                  type="button"
                  aria-expanded={!lineCollapsed}
                >
                  <span className="flex items-center gap-2">
                    {lineCollapsed ? (
                      <ChevronRight className="h-4 w-4 text-slate-300" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-slate-300" />
                    )}
                    <span className="text-xs font-black uppercase tracking-wider text-white">{lineGroup.lineName}</span>
                  </span>
                  <GroupCoverage summary={lineSummary} tone="dark" />
                </button>
                {lineCollapsed
                  ? null
                  : lineGroup.managerGroups.map((managerGroup) => {
                      const dmKey = `dm:${lineGroup.lineName}|${managerGroup.managerName}`;
                      const dmCollapsed = collapsed.has(dmKey);
                      const dmSummary = summarizeRosterCoverage(managerGroup.reps);
                      return (
                        <div key={managerGroup.managerName}>
                          <button
                            className="flex w-full items-center justify-between gap-3 border-b border-slate-200 bg-slate-100 px-5 py-1.5 pl-8 text-left transition hover:bg-slate-200/70"
                            onClick={() => toggleCollapse(dmKey)}
                            type="button"
                            aria-expanded={!dmCollapsed}
                          >
                            <span className="flex items-center gap-2">
                              {dmCollapsed ? (
                                <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                              ) : (
                                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                              )}
                              <span className="text-phx-xs font-bold text-slate-600">DM: {displayPersonName(managerGroup.managerName)}</span>
                            </span>
                            <GroupCoverage summary={dmSummary} tone="light" />
                          </button>
                          {dmCollapsed ? null : (
                            <div className="divide-y divide-slate-200">
                              {managerGroup.reps.map((entry) => {
                                const key = canonicalHrIdKey(entry.hrId);
                                return (
                                  <RosterRow
                                    dateCheckMode={dateCheckMode}
                                    dateFrom={dateFrom}
                                    dateTo={dateTo}
                                    entry={entry}
                                    key={entry.hrId}
                                    onSetPlannedDate={setPlannedDate}
                                    plannedDate={(key && plannedDates[key]) ?? ""}
                                    today={today}
                                    visits={(key && visitsByRepKey.get(key)) || []}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
              </div>
            );
          })}

          {filteredRoster.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              {roster.length === 0 ? "No Medical Reps are in your scope." : "No Medical Reps match this search or filter."}
            </div>
          ) : null}
        </div>
      </section>

      <p className="text-xs leading-5 text-slate-500">
        Read-only CRM check · Click a visited rep to see their double-visit history · Cadence looks back 180 days: overdue after 30 days with no double visit, critical after 60 — for a rep never visited, counted from the hire date · Reps count from their hire date.
      </p>
    </div>
  );
}
