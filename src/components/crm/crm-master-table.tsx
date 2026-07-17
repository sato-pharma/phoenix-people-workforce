"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Braces, ChevronLeft, ChevronRight, Database, Download, Info, Loader2, Search, SlidersHorizontal } from "lucide-react";

import { downloadXlsxExport } from "@/lib/export/download-xlsx-client";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type {
  CrmMasterAmpm,
  CrmMasterColumn,
  CrmMasterData,
  CrmMasterDataset,
  CrmMasterMappingStatus,
  CrmMasterRow,
} from "@/lib/crm/master";
import type { VisitsSyncRun } from "@/lib/visits-report/types";

const DATASET_TABS: Array<{ id: CrmMasterDataset; label: string }> = [
  { id: "visits", label: "Visits" },
  { id: "checkins", label: "Check-ins" },
  { id: "double_visits", label: "Double Visits" },
  { id: "triple_visits", label: "Triple Visits" },
  { id: "vacations", label: "Vacations" },
  { id: "regular_no_checkin", label: "Regular · No Check-in" },
  { id: "regular_dv_no_checkin", label: "Regular DV · No Check-in" },
  { id: "crm_issues", label: "CRM Issues" },
];

function datasetLabel(dataset: CrmMasterDataset): string {
  return DATASET_TABS.find((tab) => tab.id === dataset)?.label ?? dataset;
}

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
  const [lineValue, setLineValue] = useState(data.line ?? "");
  const [hireFromText, setHireFromText] = useState(data.hireFrom ?? "");
  const [hireToText, setHireToText] = useState(data.hireTo ?? "");
  const [minDurationText, setMinDurationText] = useState(data.minDuration != null ? String(data.minDuration) : "");
  const [halfDaysOnly, setHalfDaysOnly] = useState(data.halfDaysOnly);
  const advancedActive =
    Boolean(data.agentHrId) ||
    data.ampm !== "all" ||
    Boolean(data.visitType) ||
    data.mappingStatus !== "all" ||
    Boolean(data.line) ||
    Boolean(data.hireFrom) ||
    Boolean(data.hireTo) ||
    data.minDuration != null ||
    data.halfDaysOnly;
  const [showAdvanced, setShowAdvanced] = useState(advancedActive);
  const [exportBusy, setExportBusy] = useState(false);

  // Tab / navigation responsiveness: a pending transition dims the table + highlights the tab you
  // clicked immediately, so switching tabs never feels dead while the server round-trips. The
  // optimistic dataset is trusted only while the navigation is in flight; data.dataset is the truth.
  const [isPending, startTransition] = useTransition();
  const [pendingDataset, setPendingDataset] = useState<CrmMasterDataset | null>(null);
  const activeDataset = isPending && pendingDataset ? pendingDataset : data.dataset;

  // Synced top horizontal scrollbar: a thin bar directly above the table whose scroll position
  // mirrors the table body's, so wide columns can be panned without scrolling to the bottom.
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const syncLock = useRef(false);

  useEffect(() => {
    // Width of the scrolling content = the widest of the table element and its scroll container. The
    // table reflows WIDER well after first paint (nowrap columns, RTL Arabic text, web fonts loading a
    // second or two later), and a single early read captures a too-small width → the top scrollbar goes
    // missing. The component remounts on every navigation (page key), so scrollWidth starts at 0 here;
    // we GROW it to the widest value seen and keep it (no shrink-back flicker). Re-measure aggressively
    // for a few seconds + on font load + via a ResizeObserver so a late reflow is always caught.
    const measure = () => {
      const width = Math.max(tableRef.current?.scrollWidth ?? 0, bodyRef.current?.scrollWidth ?? 0);
      setScrollWidth((prev) => (width > prev ? width : prev));
    };
    measure();
    const interval = setInterval(measure, 250);
    const stop = setTimeout(() => clearInterval(interval), 3000);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (observer && tableRef.current) observer.observe(tableRef.current);
    if (observer && bodyRef.current) observer.observe(bodyRef.current);
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(measure);
    }
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(interval);
      clearTimeout(stop);
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
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  function switchDataset(dataset: CrmMasterDataset) {
    if (dataset === data.dataset) return;
    setPendingDataset(dataset); // highlight the clicked tab instantly, before the server responds
    // Reset page + filters that are dataset-specific; keep the date range + agent + line + hiring.
    navigate({ dataset, page: null, search: null, ampm: null, visitType: null, mappingStatus: null, minDuration: null, halfDaysOnly: null });
  }

  function applyFilters() {
    navigate({
      agentHrId: agentText || null,
      ampm: ampmValue === "all" ? null : ampmValue,
      dateFrom: fromText || null,
      dateTo: toText || null,
      halfDaysOnly: halfDaysOnly ? "1" : null,
      hireFrom: hireFromText || null,
      hireTo: hireToText || null,
      line: lineValue || null,
      mappingStatus: mappingValue === "all" ? null : mappingValue,
      minDuration: minDurationText.trim() || null,
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
    setLineValue("");
    setHireFromText("");
    setHireToText("");
    setMinDurationText("");
    setHalfDaysOnly(false);
    navigate({
      agentHrId: null,
      ampm: null,
      dateFrom: null,
      dateTo: null,
      halfDaysOnly: null,
      hireFrom: null,
      hireTo: null,
      line: null,
      mappingStatus: null,
      minDuration: null,
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

  // Export the FULL filtered result of the current tab (not just the page): fetch every matching
  // row from the server, render each cell the same way the table does, then build the XLSX.
  async function handleExport() {
    if (exportBusy || data.totalCount === 0) return;
    setExportBusy(true);
    try {
      const params = new URLSearchParams(searchParams.toString());
      params.set("dataset", data.dataset);
      params.delete("page");
      params.delete("pageSize");
      const response = await fetch(`/api/admin/crm/master-export?${params.toString()}`);
      if (!response.ok) throw new Error("Export failed");
      const payload = (await response.json()) as { rows: Array<Record<string, unknown>>; truncated: boolean };
      const columns: ExportColumn[] = data.columns.map((col) => ({ key: col.key, label: col.label }));
      const rows: ExportRow[] = payload.rows.map((row) => {
        const out: ExportRow = {};
        for (const col of data.columns) out[col.key] = renderCell(row[col.key], col.kind);
        return out;
      });
      await downloadXlsxExport({
        columns,
        rows,
        sheetName: datasetLabel(data.dataset),
        subtitle: payload.truncated ? "Capped at the first 50,000 rows" : undefined,
        title: `CRM — ${datasetLabel(data.dataset)}`,
      });
    } catch (error) {
      console.error("CRM master export failed:", error);
    } finally {
      setExportBusy(false);
    }
  }

  // CRM Issues: resolve an unmapped agent via the existing resolve-identity flow (writes the
  // crm_id → hr_id override, or marks resigned). Works on whichever DB the app is connected to.
  async function resolveIdentity(
    crmId: number,
    agentName: string | null,
    action: "mapped" | "resigned",
    mappedHrId: string | null,
  ) {
    try {
      const response = await fetch("/api/admin/visits-report/resolve-identity", {
        body: JSON.stringify({ action, crmId, crmName: agentName, mappedHrId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { message?: string; success?: boolean };
      if (!response.ok || !payload.success) {
        window.alert(payload.message ?? "Could not resolve this CRM identity.");
        return;
      }
      router.refresh();
    } catch {
      window.alert("Could not resolve this CRM identity.");
    }
  }

  function onMapAgent(crmId: number, agentName: string | null) {
    const hrId = window.prompt(`Map "${agentName ?? `CRM id ${crmId}`}" to which HR ID?  (e.g. CN-0005)`);
    if (!hrId || !hrId.trim()) return;
    void resolveIdentity(crmId, agentName, "mapped", hrId.trim());
  }

  function onMarkResigned(crmId: number, agentName: string | null) {
    if (!window.confirm(`Mark "${agentName ?? `CRM id ${crmId}`}" as resigned? Their CRM records will be hidden.`)) return;
    void resolveIdentity(crmId, agentName, "resigned", null);
  }

  const datasets = DATASET_TABS;

  return (
    <div className="space-y-4">
      {/* Dataset toggle + freshness */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap overflow-hidden border border-slate-200">
          {datasets.map((ds) => {
            const isActive = ds.id === activeDataset;
            const isLoadingTab = isPending && ds.id === pendingDataset;
            return (
              <button
                className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-bold transition ${
                  isActive ? "bg-orange-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
                key={ds.id}
                onClick={() => switchDataset(ds.id)}
                type="button"
              >
                {isLoadingTab ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Database aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {ds.label}
              </button>
            );
          })}
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
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Line
            <select
              className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
              onChange={(event) => setLineValue(event.target.value)}
              value={lineValue}
            >
              <option value="">All lines</option>
              {data.lineOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Hired from
            <input
              className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
              onChange={(event) => setHireFromText(event.target.value)}
              type="date"
              value={hireFromText}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Hired to
            <input
              className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
              onChange={(event) => setHireToText(event.target.value)}
              type="date"
              value={hireToText}
            />
          </label>
          {data.dataset !== "checkins" ? (
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
                <select
                  className="border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
                  onChange={(event) => setVisitTypeText(event.target.value)}
                  value={visitTypeText}
                >
                  <option value="">All types</option>
                  {data.visitTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
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
          {data.dataset === "vacations" ? (
            <>
              <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Min Duration (days)
                <input
                  className="w-28 border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none"
                  min="0"
                  onChange={(event) => setMinDurationText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFilters();
                  }}
                  placeholder="e.g. 2"
                  step="0.5"
                  type="number"
                  value={minDurationText}
                />
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <input
                  checked={halfDaysOnly}
                  className="h-4 w-4 accent-orange-600"
                  onChange={(event) => setHalfDaysOnly(event.target.checked)}
                  type="checkbox"
                />
                Half-days only
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
        <p className="flex items-center gap-2">
          <span>
            <span className="font-bold text-slate-900">{data.totalCount.toLocaleString()}</span> records
            {data.totalCount > 0 ? (
              <span className="text-slate-400"> · showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}</span>
            ) : null}
          </span>
          {isPending ? (
            <span className="inline-flex items-center gap-1 font-semibold text-orange-600">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Updating…
            </span>
          ) : null}
        </p>
        <div className="flex items-center gap-3">
          <button
            className="inline-flex h-8 items-center gap-2 border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 transition enabled:hover:border-orange-300 enabled:hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={exportBusy || data.totalCount === 0}
            onClick={handleExport}
            title={data.totalCount === 0 ? "Nothing to export" : "Export the full filtered result as XLSX"}
            type="button"
          >
            {exportBusy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Download aria-hidden="true" className="h-3.5 w-3.5" />}
            Export XLSX
          </button>
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

      {/* Master table with a synced top scrollbar + sticky header. Dims during a pending navigation. */}
      <div className={isPending ? "pointer-events-none opacity-50 transition-opacity" : "transition-opacity"}>
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
                  <RowGroup
                    columns={data.columns}
                    dataset={data.dataset}
                    isOpen={expanded.has(row.id)}
                    key={row.id}
                    onMap={onMapAgent}
                    onResign={onMarkResigned}
                    onToggle={() => toggleRaw(row.id)}
                    row={row}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function RowGroup({
  columns,
  dataset,
  isOpen,
  onMap,
  onResign,
  onToggle,
  row,
}: {
  columns: readonly CrmMasterColumn[];
  dataset: CrmMasterDataset;
  isOpen: boolean;
  onMap: (crmId: number, agentName: string | null) => void;
  onResign: (crmId: number, agentName: string | null) => void;
  onToggle: () => void;
  row: CrmMasterRow;
}) {
  const crmId = typeof row.agent_crm_id === "number" ? row.agent_crm_id : null;
  const agentName = typeof row.agent_name === "string" ? row.agent_name : null;
  const showFix = dataset === "crm_issues" && crmId != null;
  // Vacations tab: tint rows that are a national/official holiday (the service sets `national_holiday`).
  const isNationalHoliday = typeof row.national_holiday === "string" && row.national_holiday.length > 0;
  return (
    <>
      <tr
        className={`border-b text-slate-700 ${
          isNationalHoliday ? "border-amber-200 bg-amber-100/70 hover:bg-amber-100" : "border-slate-100 hover:bg-orange-50/40"
        }`}
      >
        {columns.map((col) => (
          <td className="whitespace-nowrap px-3 py-2" key={col.key}>
            {renderCell(row[col.key], col.kind)}
          </td>
        ))}
        <td className="whitespace-nowrap px-3 py-2 text-right">
          <div className="inline-flex items-center gap-1">
            {showFix ? (
              <>
                <button
                  className="border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700 transition hover:bg-emerald-100"
                  onClick={() => {
                    if (crmId != null) onMap(crmId, agentName);
                  }}
                  type="button"
                >
                  Map…
                </button>
                <button
                  className="border border-slate-200 px-2 py-1 text-[11px] font-bold text-slate-500 transition hover:bg-slate-50"
                  onClick={() => {
                    if (crmId != null) onResign(crmId, agentName);
                  }}
                  type="button"
                >
                  Resigned
                </button>
              </>
            ) : null}
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
          </div>
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
