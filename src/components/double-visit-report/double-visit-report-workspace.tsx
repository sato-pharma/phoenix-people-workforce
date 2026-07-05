"use client";

import { type ReactNode, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, ChevronLeft, ChevronRight, SlidersHorizontal, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  DoubleVisitFocusProbationEntry,
  DoubleVisitFocusRosterEntry,
  DoubleVisitReportData,
  DoubleVisitReportRow,
} from "@/lib/double-visit-analytics/types";

type Tab = "log" | "neverVisited" | "probation";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "log", label: "Visit Log" },
  { key: "neverVisited", label: "Never Visited / At Risk" },
  { key: "probation", label: "Probation Watchlist" },
];

const ALL = "ALL";

// Every table is capped at 20 rows per page. Pages are clamped during render (never reset via
// an effect) so a filter that shrinks a list can never strand the view on an empty page.
const PAGE_SIZE = 20;

function pageCountOf(total: number) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function SortHeader<T extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  activeKey: T;
  align?: "left" | "right";
  dir: "asc" | "desc";
  label: string;
  onSort: (key: T) => void;
  sortKey: T;
}) {
  const isActive = activeKey === sortKey;
  return (
    <th className={cn("px-3 py-3", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider transition-colors hover:text-orange-400",
          isActive ? "text-orange-400" : "text-slate-300",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        {isActive ? dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  );
}

// Frozen (sticky) dark header shared by every table so column titles stay visible on scroll.
const STICKY_HEAD = "sticky top-0 z-10 bg-slate-900";

function FilterField({ label, children }: { children: ReactNode; label: string }) {
  return (
    <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
      {label}
      {children}
    </label>
  );
}

function Pagination({ page, total, unit, onPage }: { onPage: (next: number) => void; page: number; total: number; unit: string }) {
  const count = pageCountOf(total);
  if (total <= PAGE_SIZE) return null;
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const btn =
    "inline-flex h-9 items-center gap-1 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#D8E0EA] disabled:hover:text-[#0F172A]";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
      <span className="text-xs font-semibold text-slate-500">Showing {from}–{to} of {total} {unit}</span>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> Prev
        </button>
        <span className="text-[11px] font-black uppercase tracking-wider text-slate-500">Page {page + 1} / {count}</span>
        <button type="button" className={btn} disabled={page >= count - 1} onClick={() => onPage(page + 1)}>
          Next <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function useSort<Row, Key extends string>(rows: Row[], getValue: (row: Row, key: Key) => string | number, defaultKey: Key) {
  const [sortKey, setSortKey] = useState<Key>(defaultKey);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, dir]);
  function onSort(key: Key) {
    if (key === sortKey) {
      setDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDir("desc");
    }
  }
  return { sorted, sortKey, dir, onSort };
}

function DateRangeForm({ dateFrom, dateTo, tab }: { dateFrom: string; dateTo: string; tab: Tab }) {
  const router = useRouter();
  const pathname = usePathname();
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);

  function apply() {
    const params = new URLSearchParams({ dateFrom: from, dateTo: to, tab });
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        From
        <input
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-800"
        />
      </label>
      <label className="flex flex-col gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
        To
        <input
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-800"
        />
      </label>
      <button
        type="button"
        onClick={apply}
        className="h-9 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316]"
      >
        Apply Range
      </button>
    </div>
  );
}

export function DoubleVisitReportWorkspace({
  data,
  initialTab,
  initialVisitorIsViewer,
  viewerHrId,
}: {
  data: DoubleVisitReportData;
  initialTab: Tab;
  initialVisitorIsViewer: boolean;
  viewerHrId: string | null;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [search, setSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [areaFilter, setAreaFilter] = useState(ALL);
  const [lineFilter, setLineFilter] = useState(ALL);
  const [visitKindFilter, setVisitKindFilter] = useState(ALL);
  const [periodFilter, setPeriodFilter] = useState(ALL);
  const [dvStatusFilter, setDvStatusFilter] = useState<"ALL" | "done" | "pending">(ALL as "ALL");
  // "?visitor=me" deep link (from the landing-page trend block) resolves to the viewer's own
  // display label the first time it's seen among this range's rows — falls back to ALL if the
  // viewer performed no visits in the default range (nothing to pre-filter to).
  const viewerVisitorLabel = useMemo(() => {
    if (!viewerHrId) return null;
    const match = data.rows.find((row) => row.doubleVisitorHrId?.toUpperCase() === viewerHrId.toUpperCase());
    return match ? match.doubleVisitorName ?? match.doubleVisitorHrId : null;
  }, [data.rows, viewerHrId]);
  const [visitorFilter, setVisitorFilter] = useState(initialVisitorIsViewer && viewerVisitorLabel ? viewerVisitorLabel : ALL);
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  // Page state per tab (clamped below so shrinking filters never leave an out-of-range page).
  const [logPage, setLogPage] = useState(0);
  const [neverPage, setNeverPage] = useState(0);
  const [probPage, setProbPage] = useState(0);

  // Distinct AM/PM/UNKNOWN periods present in the data (no server-provided list).
  const periodOptions = useMemo(() => [...new Set(data.rows.map((row) => row.period))].sort(), [data.rows]);

  const logRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (areaFilter !== ALL && row.areaName !== areaFilter) return false;
      if (lineFilter !== ALL && row.lineName !== lineFilter) return false;
      if (visitorFilter !== ALL && (row.doubleVisitorName ?? row.doubleVisitorHrId) !== visitorFilter) return false;
      if (visitKindFilter !== ALL && row.visitKind !== visitKindFilter) return false;
      if (periodFilter !== ALL && row.period !== periodFilter) return false;
      if (!term) return true;
      return (
        (row.visitedName ?? "").toLowerCase().includes(term) ||
        (row.doubleVisitorName ?? "").toLowerCase().includes(term) ||
        (row.visitedHrId ?? "").toLowerCase().includes(term)
      );
    });
  }, [data.rows, search, areaFilter, lineFilter, visitorFilter, visitKindFilter, periodFilter]);

  const neverVisitedRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return data.neverVisited.filter((row) => {
      if (areaFilter !== ALL && row.areaName !== areaFilter) return false;
      if (flaggedOnly && !row.flagged) return false;
      if (!term) return true;
      return row.name.toLowerCase().includes(term) || row.hrId.toLowerCase().includes(term);
    });
  }, [data.neverVisited, search, areaFilter, flaggedOnly]);

  const probationRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return data.probation.filter((row) => {
      if (dvStatusFilter === "done" && row.dvDone !== true) return false;
      if (dvStatusFilter === "pending" && row.dvDone !== false) return false;
      if (!term) return true;
      return row.name.toLowerCase().includes(term) || row.hrId.toLowerCase().includes(term);
    });
  }, [data.probation, search, dvStatusFilter]);

  const logSort = useSort<DoubleVisitReportRow, "date" | "visitor" | "visited" | "area" | "line" | "period" | "visits" | "kind">(
    logRows,
    (row, key) => {
      switch (key) {
        case "date": return row.activityDate;
        case "visitor": return row.doubleVisitorName ?? "";
        case "visited": return row.visitedName ?? "";
        case "area": return row.areaName ?? "";
        case "line": return row.lineName ?? "";
        case "period": return row.period;
        case "visits": return row.visitCount;
        case "kind": return row.visitKind;
      }
    },
    "date",
  );

  const neverVisitedSort = useSort<DoubleVisitFocusRosterEntry, "name" | "area" | "hire" | "days">(
    neverVisitedRows,
    (row, key) => {
      switch (key) {
        case "name": return row.name;
        case "area": return row.areaName ?? "";
        case "hire": return row.hireDate ?? "";
        case "days": return row.daysSinceHire ?? -1;
      }
    },
    "days",
  );

  const probationSort = useSort<DoubleVisitFocusProbationEntry, "name" | "hire" | "end" | "remaining" | "dv">(
    probationRows,
    (row, key) => {
      switch (key) {
        case "name": return row.name;
        case "hire": return row.hireDate;
        case "end": return row.probationEndDate;
        case "remaining": return row.daysRemaining;
        case "dv": return row.dvCount;
      }
    },
    "remaining",
  );

  // Clamp each page to its (possibly filtered) row count, then take the visible slice.
  const logPageSafe = Math.min(Math.max(0, logPage), pageCountOf(logSort.sorted.length) - 1);
  const neverPageSafe = Math.min(Math.max(0, neverPage), pageCountOf(neverVisitedSort.sorted.length) - 1);
  const probPageSafe = Math.min(Math.max(0, probPage), pageCountOf(probationSort.sorted.length) - 1);
  const logPageRows = logSort.sorted.slice(logPageSafe * PAGE_SIZE, logPageSafe * PAGE_SIZE + PAGE_SIZE);
  const neverPageRows = neverVisitedSort.sorted.slice(neverPageSafe * PAGE_SIZE, neverPageSafe * PAGE_SIZE + PAGE_SIZE);
  const probPageRows = probationSort.sorted.slice(probPageSafe * PAGE_SIZE, probPageSafe * PAGE_SIZE + PAGE_SIZE);

  const advancedActive =
    tab === "log"
      ? areaFilter !== ALL || lineFilter !== ALL || visitorFilter !== ALL || visitKindFilter !== ALL || periodFilter !== ALL
      : tab === "neverVisited"
        ? areaFilter !== ALL || flaggedOnly
        : dvStatusFilter !== ALL;

  function clearFilters() {
    setSearch("");
    setAreaFilter(ALL);
    setLineFilter(ALL);
    setVisitorFilter(ALL);
    setVisitKindFilter(ALL);
    setPeriodFilter(ALL);
    setFlaggedOnly(false);
    setDvStatusFilter(ALL as "ALL");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3">
        <DateRangeForm dateFrom={data.dateFrom} dateTo={data.dateTo} tab={tab} />
      </div>

      <div className="flex gap-px bg-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "flex-1 px-4 py-3 text-xs font-black uppercase tracking-wider transition-colors",
              tab === t.key ? "bg-slate-900 text-orange-400" : "bg-white text-slate-500 hover:bg-slate-50",
            )}
          >
            {t.label}
            {t.key === "neverVisited" && data.neverVisited.length > 0 && (
              <span className="ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] text-white">
                {data.neverVisited.length}
              </span>
            )}
            {t.key === "probation" && data.probation.length > 0 && (
              <span className="ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] text-white">
                {data.probation.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Search + advanced-filter disclosure */}
      <div className="border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name or HR ID…"
              className="h-9 w-full border border-[#D8E0EA] bg-white pl-8 pr-2 text-sm text-slate-800"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 border px-3 text-xs font-bold uppercase tracking-wider transition",
              showAdvanced || advancedActive ? "border-[#FDBA74] bg-orange-50 text-[#F97316]" : "border-[#D8E0EA] bg-white text-[#0F172A] hover:border-[#FDBA74] hover:text-[#F97316]",
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Advanced filters
            {advancedActive && <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#F97316] px-1 text-[9px] text-white">on</span>}
          </button>
          {(advancedActive || search) && (
            <button type="button" onClick={clearFilters} className="text-xs font-bold text-slate-400 underline transition hover:text-slate-700">
              Clear
            </button>
          )}
        </div>

        {showAdvanced && (
          <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 bg-slate-50/70 px-4 py-3">
            {tab === "log" && (
              <>
                <FilterField label="Area">
                  <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All areas</option>
                    {data.filters.areas.map((area) => (
                      <option key={area} value={area}>{area}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Line">
                  <select value={lineFilter} onChange={(event) => setLineFilter(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All lines</option>
                    {data.filters.lines.map((line) => (
                      <option key={line} value={line}>{line}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Double visitor">
                  <select value={visitorFilter} onChange={(event) => setVisitorFilter(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All double visitors</option>
                    {data.filters.doubleVisitors.map((visitor) => (
                      <option key={visitor} value={visitor}>{visitor}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Type">
                  <select value={visitKindFilter} onChange={(event) => setVisitKindFilter(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>Regular + Campaign</option>
                    {data.filters.visitKinds.map((kind) => (
                      <option key={kind} value={kind}>{kind}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Period">
                  <select value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All periods</option>
                    {periodOptions.map((period) => (
                      <option key={period} value={period}>{period}</option>
                    ))}
                  </select>
                </FilterField>
              </>
            )}
            {tab === "neverVisited" && (
              <>
                <FilterField label="Area">
                  <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All areas</option>
                    {data.filters.areas.map((area) => (
                      <option key={area} value={area}>{area}</option>
                    ))}
                  </select>
                </FilterField>
                <label className="flex h-9 items-center gap-2 text-xs font-semibold text-slate-600">
                  <input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} className="accent-[#F97316]" />
                  Overdue only (45+ days since hire)
                </label>
              </>
            )}
            {tab === "probation" && (
              <FilterField label="DV status">
                <select value={dvStatusFilter} onChange={(event) => setDvStatusFilter(event.target.value as typeof dvStatusFilter)} className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700">
                  <option value={ALL}>All statuses</option>
                  <option value="done">Done</option>
                  <option value="pending">Pending</option>
                </select>
              </FilterField>
            )}
          </div>
        )}
      </div>

      {tab === "log" && (
        <div className="border border-slate-200 bg-white">
          <p className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
            <span className="font-bold text-slate-700">Type</span> shows whether the source system logged this as a Regular field visit
            or a Campaign/other activity. Both count toward totals — this column and filter are for visibility, not exclusion.
          </p>
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className={STICKY_HEAD}>
                <tr>
                  <SortHeader label="Date" sortKey="date" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                  <SortHeader label="Double Visitor" sortKey="visitor" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                  <SortHeader label="Visited MR" sortKey="visited" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                  <SortHeader label="Area" sortKey="area" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                  <SortHeader label="Line" sortKey="line" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                  <SortHeader label="Period" sortKey="period" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                  <SortHeader label="Type" sortKey="kind" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                  <SortHeader label="Visits" sortKey="visits" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {logSort.sorted.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-500">No visits match these filters.</td></tr>
                ) : (
                  logPageRows.map((row, index) => (
                    <tr key={`${row.doubleVisitorHrId}-${row.visitedHrId}-${row.activityDate}-${index}`} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(row.activityDate)}</td>
                      <td className="px-3 py-2.5">{row.doubleVisitorName ?? row.doubleVisitorHrId ?? "—"}</td>
                      <td className="px-3 py-2.5">{row.visitedName ?? row.visitedHrId ?? "—"}</td>
                      <td className="px-3 py-2.5">{row.areaName ?? "—"}</td>
                      <td className="px-3 py-2.5">{row.lineName ?? "—"}</td>
                      <td className="px-3 py-2.5">{row.period}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            "inline-flex items-center whitespace-nowrap px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                            row.visitKind === "Regular" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700",
                          )}
                        >
                          {row.visitKind}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums">{row.visitCount}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={logPageSafe} total={logSort.sorted.length} unit="visits" onPage={setLogPage} />
        </div>
      )}

      {tab === "neverVisited" && (
        <div className="border border-slate-200 bg-white">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className={STICKY_HEAD}>
                <tr>
                  <SortHeader label="Name" sortKey="name" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} />
                  <SortHeader label="Area" sortKey="area" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} />
                  <SortHeader label="Hired" sortKey="hire" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} />
                  <SortHeader label="Days Since Hire" sortKey="days" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {neverVisitedSort.sorted.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-8 text-center text-sm text-slate-500">Everyone in scope has been double-visited in this range.</td></tr>
                ) : (
                  neverPageRows.map((row, index) => (
                    <tr key={row.hrId} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {row.flagged && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />}
                          {row.name}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">{row.areaName ?? "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(row.hireDate)}</td>
                      <td className={cn("px-3 py-2.5 text-right font-bold tabular-nums", row.flagged && "text-rose-600")}>
                        {row.daysSinceHire ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={neverPageSafe} total={neverVisitedSort.sorted.length} unit="reps" onPage={setNeverPage} />
        </div>
      )}

      {tab === "probation" && (
        <div className="border border-slate-200 bg-white">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className={STICKY_HEAD}>
                <tr>
                  <SortHeader label="Name" sortKey="name" activeKey={probationSort.sortKey} dir={probationSort.dir} onSort={probationSort.onSort} />
                  <SortHeader label="Hired" sortKey="hire" activeKey={probationSort.sortKey} dir={probationSort.dir} onSort={probationSort.onSort} />
                  <SortHeader label="Probation End" sortKey="end" activeKey={probationSort.sortKey} dir={probationSort.dir} onSort={probationSort.onSort} />
                  <SortHeader label="Days Left" sortKey="remaining" activeKey={probationSort.sortKey} dir={probationSort.dir} onSort={probationSort.onSort} align="right" />
                  <SortHeader label="DV" sortKey="dv" activeKey={probationSort.sortKey} dir={probationSort.dir} onSort={probationSort.onSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {probationSort.sorted.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-slate-500">No one in your scope is currently on probation.</td></tr>
                ) : (
                  probPageRows.map((row, index) => (
                    <tr key={row.hrId} className={cn(index % 2 === 0 ? "bg-white" : "bg-orange-50/30", row.hrId === viewerHrId && "ring-1 ring-inset ring-orange-300")}>
                      <td className="px-3 py-2.5">{row.name}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(row.hireDate)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(row.probationEndDate)}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums">{row.daysRemaining}</td>
                      <td className="px-3 py-2.5 text-right">
                        {row.dvDone === null ? (
                          <span className="font-bold tabular-nums text-slate-700">{row.dvCount}</span>
                        ) : row.dvDone ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" /> Done</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-rose-600"><AlertTriangle className="h-3.5 w-3.5" /> Pending</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Pagination page={probPageSafe} total={probationSort.sorted.length} unit="reps" onPage={setProbPage} />
        </div>
      )}
    </div>
  );
}
