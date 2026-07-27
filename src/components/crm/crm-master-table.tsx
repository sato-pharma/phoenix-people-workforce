"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Braces, ChevronLeft, ChevronRight, Download, Info, Loader2, Search, TriangleAlert, X } from "lucide-react";

import { downloadXlsxExport } from "@/lib/export/download-xlsx-client";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type {
  CrmMasterAmpm,
  CrmMasterColumn,
  CrmMasterData,
  CrmMasterMappingStatus,
  CrmMasterRow,
} from "@/lib/crm/master";
// Value import from the dependency-free sibling file, NOT master.ts itself — master.ts pulls in
// the Supabase admin client + employee-directory/PDF chain, which must never reach this "use
// client" component's bundle (see CRM_MASTER_DATASETS' own doc comment).
import { CRM_MASTER_DATASETS, CRM_MASTER_EXPORT_MAX_ROWS, type CrmMasterDataset } from "@/lib/crm/master-datasets";

function datasetLabel(dataset: CrmMasterDataset): string {
  return CRM_MASTER_DATASETS.find((tab) => tab.id === dataset)?.label ?? dataset;
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

/** Africa/Cairo, 12-hour clock only (no date) — for the Visit Time cell's inline badge, mirroring
 * the Visits Report's time+source display. Vendor-local, so no timezone shift (see formatVendorLocal). */
function formatVendorTimeOnly(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, minute: "2-digit", timeZone: "UTC" }).format(date);
}

/** Label for a recognition_score value — shared by the on-screen badge and the XLSX export cell. */
function recognitionLabel(score: unknown): string {
  if (score === 100) return "100% Recognized";
  if (score === 75) return "75% Partial";
  if (score === 50) return "50% Half Data";
  return "Unrecognized";
}

/** Export-only rendering: no JSX badge in an XLSX cell, so the visit_time_source is folded into
 * the text as a "(GPS)"/"(Logged)" suffix — otherwise removing the dedicated source column would
 * silently drop that information from exports, not just from the on-screen table. Same idea for
 * recognition_score: the export gets the plain label + what's missing, not a raw 100/75/50/null. */
function renderExportCell(row: Record<string, unknown>, col: CrmMasterColumn): string {
  if (col.key === "visit_time") {
    const value = row[col.key];
    if (value === null || value === undefined || value === "") return "—";
    const source = row.visit_time_source;
    const suffix = source === "GPS check-in" ? " (GPS)" : source === "Logged/save" ? " (Logged)" : "";
    return `${formatVendorLocal(value)}${suffix}`;
  }
  if (col.key === "recognition_score") {
    const label = recognitionLabel(row[col.key]);
    const missing = row.recognition_missing;
    return typeof missing === "string" && missing ? `${label} (missing: ${missing})` : label;
  }
  return renderCell(row[col.key], col.kind);
}

/** The Visit Time cell: date+time on top, a GPS/Logged source badge below — the same visual as
 * the Visits Report's Visit Time column, so the two screens read identically. `source` is the raw
 * row.visit_time_source value ("GPS check-in" | "Logged/save" | null); visit_time_source is
 * deliberately not its own table column (redundant once folded in here). */
function VisitTimeCell({ source, value }: { source: unknown; value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="text-slate-400">—</span>;
  const isGps = source === "GPS check-in";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span title={formatVendorLocal(value)}>{formatVendorTimeOnly(value)}</span>
      <span
        className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
          isGps ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
        }`}
        title={isGps ? "Real GPS check-in time (on site)" : "Logged/save time — not GPS-verified; may be logged later"}
      >
        {isGps ? "GPS" : "Logged"}
      </span>
    </span>
  );
}

/** The Recognized cell: a color-coded badge for the row's recognition_score (100/75/50/null),
 * hovering shows exactly which checks failed (row.recognition_missing) — so a bad score is
 * immediately actionable, not just a mystery color. Red/unlabeled (score null) is deliberately the
 * loudest state: those are the "mostly unresolved" rows the column exists to surface at a glance. */
function RecognitionBadge({ missing, score }: { missing: unknown; score: unknown }) {
  const label = recognitionLabel(score);
  const tone =
    score === 100
      ? "bg-emerald-100 text-emerald-700"
      : score === 75
        ? "bg-amber-100 text-amber-700"
        : score === 50
          ? "bg-orange-100 text-orange-700"
          : "bg-rose-100 text-rose-700";
  const title = typeof missing === "string" && missing ? `Missing: ${missing}` : "All checks resolved";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-bold ${tone}`} title={title}>
      {label}
    </span>
  );
}

const FILTER_FIELD = "flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500";
const FILTER_INPUT = "border border-slate-200 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";

export function CrmMasterTable({ data }: { data: CrmMasterData }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const isCheckins = data.dataset === "checkins";
  const isVacations = data.dataset === "vacations";

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState(data.search ?? "");
  const [fromText, setFromText] = useState(data.dateFrom ?? "");
  const [toText, setToText] = useState(data.dateTo ?? "");
  const [visitTypeText, setVisitTypeText] = useState(data.visitType ?? "");
  const [ampmValue, setAmpmValue] = useState<CrmMasterAmpm>(data.ampm);
  const [mappingValue, setMappingValue] = useState<CrmMasterMappingStatus>(data.mappingStatus);
  const [lineValue, setLineValue] = useState(data.line ?? "");
  const [hireFromText, setHireFromText] = useState(data.hireFrom ?? "");
  const [hireToText, setHireToText] = useState(data.hireTo ?? "");
  const [minDurationText, setMinDurationText] = useState(data.minDuration != null ? String(data.minDuration) : "");
  const [halfDaysOnly, setHalfDaysOnly] = useState(data.halfDaysOnly);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Navigation responsiveness: a pending transition dims the table while filters/pagination/page
  // size round-trip to the server (tab switching itself is now CrmTabBar's own concern).
  const [isPending, startTransition] = useTransition();

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

  function navigate(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  function applyFilters() {
    navigate({
      // Agent HR ID is intentionally NOT its own control any more — the Search box now covers agent
      // AND double HR IDs (see the server `or` expression). A legacy `agentHrId` URL param is left
      // untouched here and shown as a removable chip.
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

  // Remove one active filter (from its chip). The table remounts on navigation (page.tsx keys on the
  // URL-derived inputs), so the local input state re-seeds automatically — no need to reset it here.
  function clearFilters(keys: string[]) {
    const next: Record<string, string | null> = { page: null };
    for (const key of keys) next[key] = null;
    navigate(next);
  }

  // The active-filter chips, derived from the APPLIED values (data.*), not the local input state.
  const activeChips: Array<{ id: string; label: string; keys: string[] }> = [];
  if (data.search) activeChips.push({ id: "search", label: `Search: "${data.search}"`, keys: ["search"] });
  if (data.dateFrom || data.dateTo)
    activeChips.push({ id: "date", label: `Date: ${data.dateFrom ?? "…"} → ${data.dateTo ?? "…"}`, keys: ["dateFrom", "dateTo"] });
  if (data.agentHrId) activeChips.push({ id: "agentHrId", label: `Agent HR ID: ${data.agentHrId}`, keys: ["agentHrId"] });
  if (data.line) activeChips.push({ id: "line", label: `Line: ${data.line}`, keys: ["line"] });
  if (data.hireFrom || data.hireTo)
    activeChips.push({ id: "hire", label: `Hired: ${data.hireFrom ?? "…"} → ${data.hireTo ?? "…"}`, keys: ["hireFrom", "hireTo"] });
  if (data.ampm !== "all") activeChips.push({ id: "ampm", label: `AM/PM: ${data.ampm}`, keys: ["ampm"] });
  if (data.visitType) activeChips.push({ id: "visitType", label: `Visit Type: ${data.visitType}`, keys: ["visitType"] });
  if (data.mappingStatus !== "all")
    activeChips.push({
      id: "mappingStatus",
      label: `Mapping: ${data.mappingStatus === "agent_mapped" ? "Agent mapped" : "Agent unmapped"}`,
      keys: ["mappingStatus"],
    });
  if (data.minDuration != null)
    activeChips.push({ id: "minDuration", label: `Min duration: ${data.minDuration}d`, keys: ["minDuration"] });
  if (data.halfDaysOnly) activeChips.push({ id: "halfDaysOnly", label: "Half-days only", keys: ["halfDaysOnly"] });

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
    setExportError(null);
    try {
      const params = new URLSearchParams(searchParams.toString());
      params.set("dataset", data.dataset);
      params.delete("page");
      params.delete("pageSize");
      const response = await fetch(`/api/admin/crm/master-export?${params.toString()}`);
      if (!response.ok) throw new Error(`Export request failed (${response.status})`);
      const payload = (await response.json()) as { rows: Array<Record<string, unknown>>; truncated: boolean };
      const columns: ExportColumn[] = data.columns.map((col) => ({ key: col.key, label: col.label }));
      const rows: ExportRow[] = payload.rows.map((row) => {
        const out: ExportRow = {};
        for (const col of data.columns) out[col.key] = renderExportCell(row, col);
        return out;
      });
      await downloadXlsxExport({
        columns,
        rows,
        sheetName: datasetLabel(data.dataset),
        subtitle: payload.truncated
          ? `Capped at the first ${CRM_MASTER_EXPORT_MAX_ROWS.toLocaleString()} rows — narrow the date range to export the rest`
          : undefined,
        title: `CRM — ${datasetLabel(data.dataset)}`,
      });
    } catch (error) {
      console.error("CRM master export failed:", error);
      setExportError(
        error instanceof Error ? error.message : "Export failed. Try narrowing the filters and exporting again.",
      );
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Unified filter panel — one bar, one Apply/Reset, removable active-filter chips. The former
          separate "Agent HR ID" box is folded into Search, which now matches agent AND double HR IDs
          server-side, so a single field covers every identity lookup. */}
      <div className="space-y-3 border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          <label className={FILTER_FIELD}>
            From
            <input className={FILTER_INPUT} onChange={(event) => setFromText(event.target.value)} type="date" value={fromText} />
          </label>
          <label className={FILTER_FIELD}>
            To
            <input className={FILTER_INPUT} onChange={(event) => setToText(event.target.value)} type="date" value={toText} />
          </label>
          <label className={`${FILTER_FIELD} col-span-2`}>
            Search
            <div className="flex items-center gap-2 border border-slate-200 px-2 py-1.5 focus-within:border-orange-400">
              <Search aria-hidden="true" className="h-4 w-4 text-slate-400" />
              <input
                className="w-full text-sm text-slate-800 focus:outline-none"
                onChange={(event) => setSearchText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyFilters();
                }}
                placeholder={isCheckins ? "Agent HR ID, contact, address…" : "Agent, double, contact, customer, comment, HR ID…"}
                type="search"
                value={searchText}
              />
            </div>
          </label>
          <label className={FILTER_FIELD}>
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
          {!isCheckins ? (
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
          {isVacations ? (
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
        </div>

        {/* Active-filter chips + one Apply / Reset for the whole panel. Chips are derived from the
            APPLIED filters (data.*) and each removes just its own filter. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            {activeChips.length === 0 ? (
              <span className="text-xs text-slate-400">No filters applied</span>
            ) : (
              activeChips.map((chip) => (
                <button
                  className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 transition hover:border-orange-400 hover:bg-orange-100"
                  key={chip.id}
                  onClick={() => clearFilters(chip.keys)}
                  title="Remove this filter"
                  type="button"
                >
                  {chip.label}
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              ))
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
              onClick={resetFilters}
              type="button"
            >
              Reset
            </button>
            <button className="bg-orange-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-orange-700" onClick={applyFilters} type="button">
              Apply
            </button>
          </div>
        </div>
      </div>

      {/* Count + page size + pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <p className="flex items-center gap-2">
          <span>
            <span className="font-bold text-slate-900">{data.totalCount.toLocaleString()}</span> records
            {data.totalCount > 0 ? (
              <span className="text-slate-400"> · showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}</span>
            ) : null}
          </span>
          {data.truncated ? (
            <span
              className="inline-flex items-center gap-1 font-semibold text-amber-600"
              title="This tab is computed in memory and hit its 60,000 source-row cap; some rows may be missing. Narrow the date range for a complete view."
            >
              ⚠ capped at 60,000 source rows — some may be missing
            </span>
          ) : null}
          {isPending ? (
            <span className="inline-flex items-center gap-1 font-semibold text-orange-600">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Updating…
            </span>
          ) : null}
          {exportError ? (
            <span className="inline-flex items-center gap-1 font-semibold text-rose-600" title={exportError}>
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" /> Export failed — {exportError}
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
                    isOpen={expanded.has(row.id)}
                    key={row.id}
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
  isOpen,
  onToggle,
  row,
}: {
  columns: readonly CrmMasterColumn[];
  isOpen: boolean;
  onToggle: () => void;
  row: CrmMasterRow;
}) {
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
            {col.key === "visit_time" ? (
              <VisitTimeCell source={row.visit_time_source} value={row[col.key]} />
            ) : col.key === "recognition_score" ? (
              <RecognitionBadge missing={row.recognition_missing} score={row[col.key]} />
            ) : (
              renderCell(row[col.key], col.kind)
            )}
          </td>
        ))}
        <td className="whitespace-nowrap px-3 py-2 text-right">
          <div className="inline-flex items-center gap-1">
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
