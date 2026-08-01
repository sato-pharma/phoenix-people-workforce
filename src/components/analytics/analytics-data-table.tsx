"use client";

import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Columns3 } from "lucide-react";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";

// formatKind (not a function) so column configs stay serializable across the
// server/client boundary — these tables are rendered from Server Component
// pages, and React Server Components cannot pass function props to Client
// Components.
type ColumnFormatKind = "number" | "percent";

type Column<T> = {
  key: keyof T;
  label: string;
  align?: "left" | "right" | "center";
  formatKind?: ColumnFormatKind;
  sortable?: boolean;
};

function formatValue(kind: ColumnFormatKind | undefined, value: unknown): string {
  if (kind === "number") {
    if (value == null) return "—";
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("en-EG", { maximumFractionDigits: 0 }) : "—";
  }
  if (kind === "percent") {
    if (value == null) return "—";
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(1)}%` : "—";
  }
  return value == null ? "" : String(value);
}

type Props<T extends Record<string, unknown>> = {
  columns: Column<T>[];
  rows: T[];
  pageSize?: number;
  searchKeys?: (keyof T)[];
  caption?: string;
  totals?: Partial<Record<keyof T, number>>;
  exportTitle?: string;
  exportSubtitle?: string;
};

type SortDir = "asc" | "desc" | null;

/** Below md: one stacked card per row — the first column as a heading, the rest as label/value
 * pairs — instead of the desktop table's columns, which have no room to breathe on a phone. */
function MobileRow<T extends Record<string, unknown>>({
  columns,
  row,
  isTotal = false,
}: {
  columns: Column<T>[];
  row: Partial<Record<keyof T, unknown>>;
  isTotal?: boolean;
}) {
  const [heading, ...rest] = columns;
  const fields = isTotal ? rest.filter((col) => row[col.key] != null) : rest;

  return (
    <div className={isTotal ? "border-t-2 border-border bg-black/5 px-3 py-3 font-semibold" : "px-3 py-3"}>
      {isTotal ? (
        <p className="text-xs font-black uppercase tracking-wide text-muted-foreground">Total</p>
      ) : heading ? (
        <p className="text-sm font-semibold text-foreground">{formatValue(heading.formatKind, row[heading.key])}</p>
      ) : null}
      {fields.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
          {fields.map((col) => (
            <div key={String(col.key)}>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{col.label}</dt>
              <dd className={`font-medium text-foreground ${col.align === "right" ? "tabular-nums" : ""}`}>
                {formatValue(col.formatKind, row[col.key])}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function AnalyticsDataTable<T extends Record<string, unknown>>({
  columns,
  rows,
  pageSize = 50,
  searchKeys = [],
  caption,
  totals,
  exportTitle,
  exportSubtitle,
}: Props<T>) {
  const [sortKey, setSortKey] = useState<keyof T | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [hiddenColumns, setHiddenColumns] = useState<Set<keyof T>>(new Set());
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);

  const visibleColumns = useMemo(
    () => columns.filter((col) => !hiddenColumns.has(col.key)),
    [columns, hiddenColumns],
  );

  function toggleColumnVisibility(key: keyof T) {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter((row) =>
      searchKeys.some((k) => String(row[k] ?? "").toLowerCase().includes(q)),
    );
  }, [rows, query, searchKeys]);

  // The `totals` prop is computed by the caller over the FULL dataset, while the body renders
  // `filtered`. So the moment someone types in the search box the rows shrink and the Total does
  // not — the footer reports a figure belonging to rows that are no longer on screen. That is
  // precisely the "the total doesn't match the rows above it" complaint.
  //
  // With no query the caller's total is authoritative and used as-is (it legitimately covers rows
  // beyond the current page). With a query it is recomputed over the matching rows and the label
  // says so, so a filtered total can never be mistaken for the whole.
  const isFilteredView = query.trim().length > 0;
  const effectiveTotals = useMemo(() => {
    if (!totals || !isFilteredView) return totals;
    const recomputed: Partial<Record<keyof T, number>> = {};
    for (const key of Object.keys(totals) as (keyof T)[]) {
      // Only re-sum keys the caller actually totalled. A column deliberately left out of `totals`
      // (an average, a share, a ratio) must not acquire a meaningless sum here.
      if (totals[key] == null) continue;
      let sum = 0;
      for (const row of filtered) {
        const value = row[key];
        if (typeof value === "number" && Number.isFinite(value)) sum += value;
      }
      recomputed[key] = sum;
    }
    return recomputed;
  }, [totals, isFilteredView, filtered]);

  const sorted = useMemo(() => {
    if (!sortKey || !sortDir) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av ?? "").localeCompare(String(bv ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const exportColumns = useMemo<ExportColumn[]>(
    () => visibleColumns.map((col) => ({ key: String(col.key), label: col.label, numeric: col.align === "right" })),
    [visibleColumns],
  );

  const exportRows = useMemo<ExportRow[]>(
    () => sorted.map((row) =>
      Object.fromEntries(visibleColumns.map((col) => [String(col.key), row[col.key] as string | number | null | undefined]))
    ),
    [sorted, visibleColumns],
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize);

  function toggleSort(key: keyof T) {
    if (sortKey !== key) { setSortKey(key); setSortDir("desc"); setPage(0); return; }
    setSortDir((d) => (d === "desc" ? "asc" : d === "asc" ? null : "desc"));
    if (sortDir === "asc") setSortKey(null);
    setPage(0);
  }

  function SortIcon({ col }: { col: Column<T> }) {
    if (!col.sortable) return null;
    if (sortKey !== col.key) return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
    if (sortDir === "asc") return <ChevronUp className="h-3 w-3" />;
    if (sortDir === "desc") return <ChevronDown className="h-3 w-3" />;
    return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
  }

  return (
    <div className="flex flex-col gap-2">
      {(searchKeys.length > 0 || caption || columns.length > 1) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {caption && <p className="text-sm font-medium text-foreground">{caption}</p>}
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {searchKeys.length > 0 && (
              <input
                type="search"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(0); }}
                placeholder="Search…"
                className="h-8 border border-border bg-background px-2 text-sm w-48 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}
            {exportTitle && (
              <ExportXlsxButton
                columns={exportColumns}
                rows={exportRows}
                title={exportTitle}
                subtitle={exportSubtitle}
                sheetName={exportTitle.slice(0, 31)}
                label="Export"
                className="h-8"
              />
            )}
            {columns.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setColumnsMenuOpen((open) => !open)}
                  className="h-8 inline-flex items-center gap-1 border border-border bg-background px-2 text-xs hover:bg-muted"
                >
                  <Columns3 className="h-3.5 w-3.5" />
                  Columns
                </button>
                {columnsMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setColumnsMenuOpen(false)} />
                    <div className="absolute right-0 z-20 mt-1 w-48 border border-border bg-background p-2 shadow-md">
                      {columns.map((col) => (
                        <label key={String(col.key)} className="flex items-center gap-2 px-1 py-1 text-xs hover:bg-muted cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!hiddenColumns.has(col.key)}
                            onChange={() => toggleColumnVisibility(col.key)}
                            className="accent-orange-500"
                          />
                          {col.label}
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Below md, a wide multi-column table forces every cell into an unreadable sliver —
          show a stacked card per row instead. The table below remains the md+ view. */}
      <div className="divide-y divide-border border border-border md:hidden">
        {pageRows.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">No rows match the current filters.</p>
        ) : (
          pageRows.map((row, i) => <MobileRow columns={visibleColumns} key={i} row={row} />)
        )}
        {effectiveTotals && pageRows.length > 0 && (
          <MobileRow columns={visibleColumns} isTotal row={effectiveTotals} />
        )}
      </div>

      <div className="hidden overflow-x-auto border border-border md:block">
        <table className="w-full text-sm">
          <thead className="bg-black text-white">
            <tr>
              {visibleColumns.map((col) => (
                <th
                  key={String(col.key)}
                  className={`px-3 py-2 font-semibold text-xs uppercase tracking-wide whitespace-nowrap select-none
                    ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}
                    ${col.sortable ? "cursor-pointer hover:bg-gray-800" : ""}`}
                  onClick={() => col.sortable && toggleSort(col.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    <SortIcon col={col} />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-muted-foreground text-xs">
                  No rows match the current filters.
                </td>
              </tr>
            ) : (
              pageRows.map((row, i) => (
                <tr key={i} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-background" : "bg-muted/20"} hover:bg-orange-50/30`}>
                  {visibleColumns.map((col) => (
                    <td
                      key={String(col.key)}
                      className={`px-3 py-1.5 ${col.align === "right" ? "text-right tabular-nums" : col.align === "center" ? "text-center" : "text-left"}`}
                    >
                      {formatValue(col.formatKind, row[col.key])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {effectiveTotals && (
            <tfoot className="bg-black/5 border-t-2 border-border font-semibold">
              <tr>
                {visibleColumns.map((col, i) => {
                  const t = effectiveTotals[col.key];
                  return (
                    <td key={String(col.key)} className={`px-3 py-2 text-xs ${col.align === "right" ? "text-right tabular-nums" : "text-left"}`}>
                      {i === 0
                        ? isFilteredView
                          ? "Total (filtered)"
                          : "Total"
                        : t != null
                          ? formatValue(col.formatKind, t)
                          : ""}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{filtered.length} rows — page {page + 1} of {totalPages}</span>
          <div className="flex gap-1">
            <button
              disabled={page === 0}
              onClick={() => setPage(0)}
              className="border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-muted"
            >«</button>
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-muted"
            >‹</button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-muted"
            >›</button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(totalPages - 1)}
              className="border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-muted"
            >»</button>
          </div>
        </div>
      )}
    </div>
  );
}
