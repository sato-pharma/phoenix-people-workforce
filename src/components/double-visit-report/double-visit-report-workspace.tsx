"use client";

import { type ReactNode, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, ChevronLeft, ChevronRight, Download, SlidersHorizontal, Search } from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { cn } from "@/lib/utils";
import { ALL, filterLogRows, filterNeverVisitedRows, filterProbationRows } from "@/lib/double-visit-analytics/report-filters";
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

// Every table is capped at 20 rows per page. Pages are clamped during render (never reset via
// an effect) so a filter that shrinks a list can never strand the view on an empty page.
const PAGE_SIZE = 20;

function pageCountOf(total: number) {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// Shared between the desktop table cell and the mobile card's status slot so both surfaces
// always agree on wording/color.
function VisitKindBadge({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide",
        kind === "Regular" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700",
      )}
    >
      {kind}
    </span>
  );
}

function ProbationDvBadge({ row }: { row: DoubleVisitFocusProbationEntry }) {
  if (row.dvDone === null) {
    return <span className="text-sm font-bold tabular-nums text-slate-700">{row.dvCount}</span>;
  }
  return row.dvDone ? (
    <span className="inline-flex items-center gap-1 text-sm text-emerald-600">
      <CheckCircle2 className="h-3.5 w-3.5" /> Done
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm text-rose-600">
      <AlertTriangle className="h-3.5 w-3.5" /> Pending
    </span>
  );
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
          "inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-wider transition-colors hover:text-orange-400",
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
    <label className="flex flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-400">
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
    "inline-flex h-9 items-center gap-1 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink transition hover:border-phx-accent-line hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-phx-line disabled:hover:text-phx-ink";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
      <span className="text-xs font-semibold text-slate-500">Showing {from}–{to} of {total} {unit}</span>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" /> Prev
        </button>
        <span className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Page {page + 1} / {count}</span>
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
      <label className="flex flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-400">
        From
        <input
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-800"
        />
      </label>
      <label className="flex flex-col gap-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-400">
        To
        <input
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-800"
        />
      </label>
      <button
        type="button"
        onClick={apply}
        className="h-9 border border-phx-line bg-white px-3 text-xs font-bold text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent"
      >
        Apply Range
      </button>
    </div>
  );
}

// ── Mobile card views (< md) — one per tab, mirroring the desktop table's columns. ──────

function LogVisitCard({ row }: { row: DoubleVisitReportRow }) {
  return (
    <PortalRecordCard
      accent={row.visitKind === "Regular" ? "emerald" : "amber"}
      meta={
        <span>
          {row.doubleVisitorRole ?? "—"} · {formatDate(row.activityDate)}
        </span>
      }
      status={<VisitKindBadge kind={row.visitKind} />}
      title={row.doubleVisitorName ?? row.doubleVisitorHrId ?? "—"}
    >
      <PortalRecordFields
        fields={[
          { label: "Visited MR", value: row.visitedName ?? row.visitedHrId ?? "—" },
          { label: "Area", value: row.areaName ?? "—" },
          { label: "Region", value: row.regionName ?? "—" },
          { label: "Line", value: row.lineName ?? "—" },
          { label: "Period", value: row.period },
          { label: "Visits", value: row.visitCount },
        ]}
      />
    </PortalRecordCard>
  );
}

function NeverVisitedCard({ row }: { row: DoubleVisitFocusRosterEntry }) {
  return (
    <PortalRecordCard
      accent={row.flagged ? "rose" : "slate"}
      meta={row.areaName ?? "—"}
      status={
        <span className={cn("text-sm font-black tabular-nums", row.flagged ? "text-rose-600" : "text-slate-700")}>
          {row.daysSinceHire ?? "—"}
          <span className="ml-1 text-phx-3xs font-bold uppercase tracking-wide text-slate-400">days</span>
        </span>
      }
      title={
        <span className="inline-flex items-center gap-1.5">
          {row.flagged ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" /> : null}
          {row.name}
        </span>
      }
    >
      <PortalRecordFields fields={[{ label: "Hired", value: formatDate(row.hireDate) }]} />
    </PortalRecordCard>
  );
}

function ProbationCard({ row, viewerHrId }: { row: DoubleVisitFocusProbationEntry; viewerHrId: string | null }) {
  return (
    <PortalRecordCard
      accent={row.dvDone === true ? "emerald" : row.dvDone === false ? "rose" : "slate"}
      className={cn(row.hrId === viewerHrId && "ring-1 ring-inset ring-orange-300")}
      meta={<span>Hired {formatDate(row.hireDate)}</span>}
      status={<ProbationDvBadge row={row} />}
      title={row.name}
    >
      <PortalRecordFields
        fields={[
          { label: "Probation End", value: formatDate(row.probationEndDate) },
          { label: "Days Left", value: row.daysRemaining },
        ]}
      />
    </PortalRecordCard>
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
  const [regionFilter, setRegionFilter] = useState(ALL);
  const [roleFilter, setRoleFilter] = useState(ALL);
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

  const logRows = useMemo(
    () => filterLogRows(data.rows, { areaFilter, periodFilter, regionFilter, roleFilter, search, visitKindFilter, visitorFilter }),
    [data.rows, search, areaFilter, regionFilter, roleFilter, visitorFilter, visitKindFilter, periodFilter],
  );

  const neverVisitedRows = useMemo(
    () => filterNeverVisitedRows(data.neverVisited, { areaFilter, flaggedOnly, search }),
    [data.neverVisited, search, areaFilter, flaggedOnly],
  );

  const probationRows = useMemo(
    () => filterProbationRows(data.probation, { dvStatusFilter, search }),
    [data.probation, search, dvStatusFilter],
  );

  const logSort = useSort<DoubleVisitReportRow, "date" | "visitor" | "role" | "visited" | "area" | "region" | "line" | "period" | "visits" | "kind">(
    logRows,
    (row, key) => {
      switch (key) {
        case "date": return row.activityDate;
        case "visitor": return row.doubleVisitorName ?? "";
        case "role": return row.doubleVisitorRole ?? "";
        case "visited": return row.visitedName ?? "";
        case "area": return row.areaName ?? "";
        case "region": return row.regionName ?? "";
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
      ? areaFilter !== ALL || regionFilter !== ALL || roleFilter !== ALL || visitorFilter !== ALL || visitKindFilter !== ALL || periodFilter !== ALL
      : tab === "neverVisited"
        ? areaFilter !== ALL || flaggedOnly
        : dvStatusFilter !== ALL;

  function clearFilters() {
    setSearch("");
    setAreaFilter(ALL);
    setRegionFilter(ALL);
    setRoleFilter(ALL);
    setVisitorFilter(ALL);
    setVisitKindFilter(ALL);
    setPeriodFilter(ALL);
    setFlaggedOnly(false);
    setDvStatusFilter(ALL as "ALL");
  }

  // Mirrors whatever is currently applied on screen (committed date range + active filters +
  // tab) so the downloaded file always matches what the user is looking at.
  function buildExportHref(format: "xlsx" | "pdf") {
    const params = new URLSearchParams({ dateFrom: data.dateFrom, dateTo: data.dateTo, format, tab });
    if (search.trim()) params.set("search", search.trim());
    if (areaFilter !== ALL) params.set("areaFilter", areaFilter);
    if (regionFilter !== ALL) params.set("regionFilter", regionFilter);
    if (roleFilter !== ALL) params.set("roleFilter", roleFilter);
    if (visitorFilter !== ALL) params.set("visitorFilter", visitorFilter);
    if (visitKindFilter !== ALL) params.set("visitKindFilter", visitKindFilter);
    if (periodFilter !== ALL) params.set("periodFilter", periodFilter);
    if (flaggedOnly) params.set("flaggedOnly", "true");
    if (dvStatusFilter !== ALL) params.set("dvStatusFilter", dvStatusFilter);
    return `/api/employee-portals/double-visit-report/export?${params.toString()}`;
  }

  const downloadLinkClass =
    "inline-flex h-9 items-center gap-1.5 border border-phx-line bg-white px-3 text-xs font-bold uppercase tracking-wider text-phx-ink shadow-sm transition hover:border-phx-accent-line hover:text-phx-accent";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3">
        <DateRangeForm dateFrom={data.dateFrom} dateTo={data.dateTo} tab={tab} />
        <div className="ml-auto flex items-center gap-2">
          <a href={buildExportHref("xlsx")} className={downloadLinkClass}>
            <Download className="h-3.5 w-3.5" /> Excel
          </a>
          <a href={buildExportHref("pdf")} className={downloadLinkClass}>
            <Download className="h-3.5 w-3.5" /> PDF
          </a>
        </div>
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
              <span className="ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1 text-phx-2xs text-white">
                {data.neverVisited.length}
              </span>
            )}
            {t.key === "probation" && data.probation.length > 0 && (
              <span className="ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-orange-500 px-1 text-phx-2xs text-white">
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
              className="h-9 w-full border border-phx-line bg-white pl-8 pr-2 text-sm text-slate-800"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 border px-3 text-xs font-bold uppercase tracking-wider transition",
              showAdvanced || advancedActive ? "border-phx-accent-line bg-orange-50 text-phx-accent" : "border-phx-line bg-white text-phx-ink hover:border-phx-accent-line hover:text-phx-accent",
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Advanced filters
            {advancedActive && <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-phx-accent px-1 text-phx-3xs text-white">on</span>}
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
                  <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All areas</option>
                    {data.filters.areas.map((area) => (
                      <option key={area} value={area}>{area}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Region">
                  <select value={regionFilter} onChange={(event) => setRegionFilter(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All regions</option>
                    {data.filters.regions.map((region) => (
                      <option key={region} value={region}>{region}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Job Title">
                  <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All job titles</option>
                    {data.filters.doubleVisitorRoles.map((role) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Double visitor">
                  <select value={visitorFilter} onChange={(event) => setVisitorFilter(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All double visitors</option>
                    {data.filters.doubleVisitors.map((visitor) => (
                      <option key={visitor} value={visitor}>{visitor}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Type">
                  <select value={visitKindFilter} onChange={(event) => setVisitKindFilter(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>Regular + Campaign</option>
                    {data.filters.visitKinds.map((kind) => (
                      <option key={kind} value={kind}>{kind}</option>
                    ))}
                  </select>
                </FilterField>
                <FilterField label="Time Period">
                  <select value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
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
                  <select value={areaFilter} onChange={(event) => setAreaFilter(event.target.value)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
                    <option value={ALL}>All areas</option>
                    {data.filters.areas.map((area) => (
                      <option key={area} value={area}>{area}</option>
                    ))}
                  </select>
                </FilterField>
                <label className="flex h-9 items-center gap-2 text-xs font-semibold text-slate-600">
                  <input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} className="accent-phx-accent" />
                  Overdue only (45+ days since hire)
                </label>
              </>
            )}
            {tab === "probation" && (
              <FilterField label="DV status">
                <select value={dvStatusFilter} onChange={(event) => setDvStatusFilter(event.target.value as typeof dvStatusFilter)} className="h-9 border border-phx-line bg-white px-2 text-sm text-slate-700">
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
          <p className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-phx-xs text-slate-500">
            <span className="font-bold text-slate-700">Type</span> shows whether the source system logged this as a Regular field visit
            or a Campaign/other activity. Both count toward totals — this column and filter are for visibility, not exclusion.
          </p>
          <PortalResponsiveDataList
            empty={<PortalEmptyState title="No visits found" message="No visits match these filters." />}
            getKey={(row, index) => `${row.doubleVisitorHrId}-${row.visitedHrId}-${row.activityDate}-${index}`}
            items={logPageRows}
            renderCard={(row) => <LogVisitCard row={row} />}
            renderTable={() => (
              <div className="max-h-[70vh] overflow-auto">
                <PortalDesktopTable minWidth="1180px">
                  <thead className={STICKY_HEAD}>
                    <tr>
                      <SortHeader label="Date" sortKey="date" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Double Visitor" sortKey="visitor" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Job Title" sortKey="role" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Visited MR" sortKey="visited" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Area" sortKey="area" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Region" sortKey="region" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Line" sortKey="line" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Period" sortKey="period" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Type" sortKey="kind" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} />
                      <SortHeader label="Visits" sortKey="visits" activeKey={logSort.sortKey} dir={logSort.dir} onSort={logSort.onSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100">
                    {logPageRows.map((row, index) => (
                      <tr key={`${row.doubleVisitorHrId}-${row.visitedHrId}-${row.activityDate}-${index}`} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(row.activityDate)}</td>
                        <td className="px-3 py-2.5">{row.doubleVisitorName ?? row.doubleVisitorHrId ?? "—"}</td>
                        <td className="px-3 py-2.5">{row.doubleVisitorRole ?? "—"}</td>
                        <td className="px-3 py-2.5">{row.visitedName ?? row.visitedHrId ?? "—"}</td>
                        <td className="px-3 py-2.5">{row.areaName ?? "—"}</td>
                        <td className="px-3 py-2.5">{row.regionName ?? "—"}</td>
                        <td className="px-3 py-2.5">{row.lineName ?? "—"}</td>
                        <td className="px-3 py-2.5">{row.period}</td>
                        <td className="px-3 py-2.5">
                          <VisitKindBadge kind={row.visitKind} />
                        </td>
                        <td className="px-3 py-2.5 text-right font-bold tabular-nums">{row.visitCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              </div>
            )}
          />
          <Pagination page={logPageSafe} total={logSort.sorted.length} unit="visits" onPage={setLogPage} />
        </div>
      )}

      {tab === "neverVisited" && (
        <div className="border border-slate-200 bg-white">
          <PortalResponsiveDataList
            empty={<PortalEmptyState title="Everyone visited" message="Everyone in scope has been double-visited in this range." />}
            getKey={(row) => row.hrId}
            items={neverPageRows}
            renderCard={(row) => <NeverVisitedCard row={row} />}
            renderTable={() => (
              <div className="max-h-[70vh] overflow-auto">
                <PortalDesktopTable minWidth="680px">
                  <thead className={STICKY_HEAD}>
                    <tr>
                      <SortHeader label="Name" sortKey="name" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} />
                      <SortHeader label="Area" sortKey="area" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} />
                      <SortHeader label="Hired" sortKey="hire" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} />
                      <SortHeader label="Days Since Hire" sortKey="days" activeKey={neverVisitedSort.sortKey} dir={neverVisitedSort.dir} onSort={neverVisitedSort.onSort} align="right" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100">
                    {neverPageRows.map((row, index) => (
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
                    ))}
                  </tbody>
                </PortalDesktopTable>
              </div>
            )}
          />
          <Pagination page={neverPageSafe} total={neverVisitedSort.sorted.length} unit="reps" onPage={setNeverPage} />
        </div>
      )}

      {tab === "probation" && (
        <div className="border border-slate-200 bg-white">
          <PortalResponsiveDataList
            empty={<PortalEmptyState title="No one on probation" message="No one in your scope is currently on probation." />}
            getKey={(row) => row.hrId}
            items={probPageRows}
            renderCard={(row) => <ProbationCard row={row} viewerHrId={viewerHrId} />}
            renderTable={() => (
              <div className="max-h-[70vh] overflow-auto">
                <PortalDesktopTable minWidth="720px">
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
                    {probPageRows.map((row, index) => (
                      <tr key={row.hrId} className={cn(index % 2 === 0 ? "bg-white" : "bg-orange-50/30", row.hrId === viewerHrId && "ring-1 ring-inset ring-orange-300")}>
                        <td className="px-3 py-2.5">{row.name}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(row.hireDate)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatDate(row.probationEndDate)}</td>
                        <td className="px-3 py-2.5 text-right font-bold tabular-nums">{row.daysRemaining}</td>
                        <td className="px-3 py-2.5 text-right">
                          <ProbationDvBadge row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              </div>
            )}
          />
          <Pagination page={probPageSafe} total={probationSort.sorted.length} unit="reps" onPage={setProbPage} />
        </div>
      )}
    </div>
  );
}
