"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Braces, ChevronLeft, ChevronRight, Database, Info, Search, SlidersHorizontal } from "lucide-react";

import type {
  CrmMasterAmpm,
  CrmMasterColumn,
  CrmMasterData,
  CrmMasterDataset,
  CrmMasterMappingStatus,
  CrmMasterRow,
} from "@/lib/crm/master";
import type { VisitsSyncRun } from "@/lib/visits-report/types";

function formatCairo(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(date);
}

/** Date only, e.g. "11 Jul 2026" (UTC — a plain calendar date has no time-of-day). */
function formatDateOnly(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(date);
}

/** Date + 12-hour time in Cairo, e.g. "11 Jul 2026, 4:59 PM" — for a true UTC instant we recorded
 * (synced_at), converted to Cairo. */
function formatDateTimeCairo(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const datePart = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric" }).format(date);
  const timePart = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "Africa/Cairo" }).format(date);
  return `${datePart}, ${timePart}`;
}

/** Vendor timestamps (saveDate / checkDate) are already Cairo wall-clock but stored tagged UTC
 * (iReports360 sends zone-less local times). Render the stored clock reading with NO timezone
 * shift, e.g. "16 Jul 2026, 6:13 PM" — converting would read ~2–3h too late. */
function formatVendorLocal(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const datePart = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(date);
  const timePart = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "UTC" }).format(date);
  return `${datePart}, ${timePart}`;
}

/** Cell rendering: vendor local datetimes render as their stored Cairo wall-clock; our UTC
 * datetimes convert to Cairo; dates → date only; everything else raw. The full untouched value
 * is always available in the row's raw JSON. */
function renderCell(value: unknown, kind: CrmMasterColumn["kind"]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "datetime_local") return formatVendorLocal(value);
  if (kind === "datetime") return formatDateTimeCairo(value);
  if (kind === "date") return formatDateOnly(value);
  return String(value);
}

export function CrmMasterTable({ data }: { data: CrmMasterData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState(data.search ?? "");
  const [fromText, setFromText] = useState(data.dateFrom ?? "");
  const [toText, setToText] = useState(data.dateTo ?? "");
  const [agentText, setAgentText] = useState(data.agentHrId ?? "");
  const [visitTypeText, setVisitTypeText] = useState(data.visitType ?? "");
  const [ampmValue, setAmpmValue] = useState<CrmMasterAmpm>(data.ampm);
  const [mappingValue, setMappingValue] = useState<CrmMasterMappingStatus>(data.mappingStatus);
  const advancedActive =
    Boolean(data.agentHrId) || data.ampm !== "all" || Boolean(data.visitType) || data.mappingStatus !== "all";
  const [showAdvanced, setShowAdvanced] = useState(advancedActive);

  // Synced top horizontal scrollbar: a thin bar directly above the table whose scroll position
  // mirrors the table body's, so wide columns can be panned without scrolling to the bottom.
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const syncLock = useRef(false);

  useEffect(() => {
    const measure = () => setScrollWidth(tableRef.current?.scrollWidth ?? 0);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (observer && tableRef.current) observer.observe(tableRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [data.rows, data.columns, data.dataset]);

  function mirrorScroll(from: "top" | "body") {
    if (syncLock.current) return;
    syncLock.current = true;
    const source = from === "top" ? topRef.current : bodyRef.current;
    const target = from === "top" ? bodyRef.current : topRef.current;
    if (source && target) target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      syncLock.current = false;
    });
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / data.pageSize));
  const rangeStart = data.totalCount === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const rangeEnd = Math.min(data.page * data.pageSize, data.totalCount);
  const lastSuccess = data.latestSyncRuns.find((run: VisitsSyncRun) => run.status === "success") ?? null;

  function navigate(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  function switchDataset(dataset: CrmMasterDataset) {
    if (dataset === data.dataset) return;
    // Reset page + the visits-only filters that don't apply to check-ins; keep date range + agent.
    navigate({ dataset, page: null, search: null, ampm: null, visitType: null, mappingStatus: null });
  }

  function applyFilters() {
    navigate({
      agentHrId: agentText || null,
      ampm: ampmValue === "all" ? null : ampmValue,
      dateFrom: fromText || null,
      dateTo: toText || null,
      mappingStatus: mappingValue === "all" ? null : mappingValue,
      page: null,
      search: searchText || null,
      visitType: visitTypeText || null,
    });
  }

  function resetFilters() {
    setSearchText("");
    setFromText("");
    setToText("");
    setAgentText("");
    setVisitTypeText("");
    setAmpmValue("all");
    setMappingValue("all");
    navigate({
      agentHrId: null,
      ampm: null,
      dateFrom: null,
      dateTo: null,
      mappingStatus: null,
      page: null,
      search: null,
      visitType: null,
    });
  }

  function toggleRaw(id: string) {
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
  }

  const datasets: Array<{ id: CrmMasterDataset; label: string }> = [
    { id: "visits", label: "Visits" },
    { id: "checkins", label: "Check-ins" },
  ];

  return (
    <div className="space-y-4">
      {/* Dataset toggle + freshness */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden border border-slate-200">
          {datasets.map((ds) => (
            <button
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold transition ${
                ds.id === data.dataset ? "bg-orange-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
              key={ds.id}
              onClick={() => switchDataset(ds.id)}
              type="button"
            >
              <Database aria-hidden="true" className="h-3.5 w-3.5" />
              {ds.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Last successful sync:{" "}
          <span className="font-semibold text-slate-700">{formatCairo(lastSuccess?.completedAt ?? null)}</span>
          {lastSuccess ? <span className="text-slate-400"> (Cairo)</span> : null}
          {!data.configured ? <span className="ml-2 text-amber-700">· iReports360 not configured</span> : null}
        </p>
      </div>

      {/* Basic filters */}
      <div className="flex flex-wrap items-end gap-3 border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          From
          <input
            className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setFromText(event.target.value)}
            type="date"
            value={fromText}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          To
          <input
            className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
            onChange={(event) => setToText(event.target.value)}
            type="date"
            value={toText}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Search
          <div className="flex items-center gap-2 border border-slate-200 px-2 py-1.5 focus-within:border-orange-400">
            <Search aria-hidden="true" className="h-4 w-4 text-slate-400" />
            <input
              className="w-full text-sm text-slate-800 focus:outline-none"
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilters();
              }}
              placeholder={data.dataset === "checkins" ? "Agent HR ID, contact, address…" : "Agent, contact, customer, comment, HR ID…"}
              type="search"
              value={searchText}
            />
          </div>
        </label>
        <button
          className={`inline-flex items-center gap-2 border px-3 py-2 text-xs font-bold transition ${
            showAdvanced || advancedActive
              ? "border-orange-300 bg-orange-50 text-orange-700"
              : "border-slate-200 text-slate-600 hover:bg-slate-50"
          }`}
          onClick={() => setShowAdvanced((value) => !value)}
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
          Advanced
        </button>
        <button className="bg-orange-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-orange-700" onClick={applyFilters} type="button">
          Apply
        </button>
        <button
          className="border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
          onClick={resetFilters}
          type="button"
        >
          Reset
        </button>
      </div>

      {/* Advanced filters */}
      {showAdvanced ? (
        <div className="flex flex-wrap items-end gap-3 border border-orange-200 bg-orange-50/40 p-4">
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Agent HR ID
            <input
              className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
              onChange={(event) => setAgentText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyFilters();
              }}
              placeholder="e.g. B-107"
              type="text"
              value={agentText}
            />
          </label>
          {data.dataset === "visits" ? (
            <>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                AM/PM
                <select
                  className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
                  onChange={(event) => setAmpmValue(event.target.value as CrmMasterAmpm)}
                  value={ampmValue}
                >
                  <option value="all">All</option>
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Visit Type
                <input
                  className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
                  onChange={(event) => setVisitTypeText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFilters();
                  }}
                  placeholder="e.g. Campaign, Meeting"
                  type="text"
                  value={visitTypeText}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Mapping
                <select
                  className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
                  onChange={(event) => setMappingValue(event.target.value as CrmMasterMappingStatus)}
                  value={mappingValue}
                >
                  <option value="all">All</option>
                  <option value="agent_mapped">Agent mapped</option>
                  <option value="agent_unmapped">Agent unmapped</option>
                </select>
              </label>
            </>
          ) : null}
          <button className="bg-orange-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-orange-700" onClick={applyFilters} type="button">
            Apply filters
          </button>
        </div>
      ) : null}

      {/* Count + page size + pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <p>
          <span className="font-bold text-slate-900">{data.totalCount.toLocaleString()}</span>{" "}
          {data.dataset === "checkins" ? "check-in" : "visit"} records
          {data.totalCount > 0 ? (
            <span className="text-slate-400"> · showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}</span>
          ) : null}
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-slate-500">
            Rows
            <select
              className="border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 focus:border-orange-400 focus:outline-none"
              onChange={(event) => navigate({ page: null, pageSize: event.target.value })}
              value={data.pageSize}
            >
              {data.pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1 border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={data.page <= 1}
              onClick={() => navigate({ page: String(data.page - 1) })}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Prev
            </button>
            <span className="tabular-nums text-slate-500">
              Page {data.page.toLocaleString()} / {totalPages.toLocaleString()}
            </span>
            <button
              className="inline-flex items-center gap-1 border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={data.page >= totalPages}
              onClick={() => navigate({ page: String(data.page + 1) })}
              type="button"
            >
              Next
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Master table with a synced top scrollbar + sticky header */}
      {!data.schemaReady ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          The iReports360 mirror is not set up yet — no CRM data to show.
        </div>
      ) : data.rows.length === 0 ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          No records match the current filters.
        </div>
      ) : (
        <div>
          {/* Top horizontal scrollbar — directly above the header */}
          <div
            className="overflow-x-auto border border-b-0 border-slate-200 bg-white"
            onScroll={() => mirrorScroll("top")}
            ref={topRef}
          >
            <div style={{ height: 1, width: scrollWidth }} />
          </div>
          <div
            className="max-h-[65vh] overflow-auto border border-slate-200 bg-white"
            onScroll={() => mirrorScroll("body")}
            ref={bodyRef}
          >
            <table className="w-full border-collapse text-left text-xs" ref={tableRef}>
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-slate-200 bg-slate-100 text-slate-500">
                  {data.columns.map((col) => (
                    <th className="whitespace-nowrap px-3 py-2 font-semibold" key={col.key} title={col.note ?? undefined}>
                      <span className={`inline-flex items-center gap-1 ${col.note ? "cursor-help" : ""}`}>
                        {col.label}
                        {col.note ? <Info aria-hidden="true" className="h-3 w-3 text-orange-400" /> : null}
                      </span>
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Raw</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row: CrmMasterRow) => (
                  <RowGroup columns={data.columns} isOpen={expanded.has(row.id)} key={row.id} onToggle={() => toggleRaw(row.id)} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function RowGroup({
  columns,
  isOpen,
  onToggle,
  row,
}: {
  columns: readonly CrmMasterColumn[];
  isOpen: boolean;
  onToggle: () => void;
  row: CrmMasterRow;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 text-slate-700 hover:bg-orange-50/40">
        {columns.map((col) => (
          <td className="whitespace-nowrap px-3 py-2" key={col.key}>
            {renderCell(row[col.key], col.kind)}
          </td>
        ))}
        <td className="whitespace-nowrap px-3 py-2 text-right">
          <button
            aria-expanded={isOpen}
            className={`inline-flex items-center gap-1 border px-2 py-1 text-[11px] font-bold transition ${
              isOpen ? "border-orange-400 bg-orange-50 text-orange-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
            }`}
            onClick={onToggle}
            type="button"
          >
            <Braces aria-hidden="true" className="h-3.5 w-3.5" />
            {isOpen ? "Hide" : "JSON"}
          </button>
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-slate-100 bg-slate-950">
          <td className="p-0" colSpan={columns.length + 1}>
            <pre className="max-h-96 overflow-auto px-4 py-3 text-[11px] leading-5 text-emerald-200">
              {JSON.stringify(row.raw_payload ?? {}, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}
