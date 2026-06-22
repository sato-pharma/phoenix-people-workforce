"use client";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import {
  SortableTh,
  TableSearchInput,
  TableNoResults,
} from "@/components/ui/sortable-table";
import { useSortableTable, visibleMax } from "@/components/ui/use-sortable-table";

export type TopMoverRow = { label: string; value: number };

function egp(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `EGP ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `EGP ${(v / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(v).toLocaleString("en-US")}`;
}

const SORT_COLS = [
  {
    key: "label",
    accessor: (r: TopMoverRow) => r.label,
    type: "string" as const,
    defaultDir: "asc" as const,
  },
  {
    key: "value",
    accessor: (r: TopMoverRow) => r.value,
    type: "number" as const,
  },
];

/**
 * Reusable premium sortable + filterable + XLSX-exportable table for any
 * top-movers dataset (regions, lines, products, etc.). Used throughout the CEO
 * Command Center Phase A cards (SoS Top Lines, SoS Top Regions, Weekly Regions).
 */
export function CeoTopMoversTable({
  movers,
  title,
  exportTitle,
  labelHeader = "Name",
  valueHeader = "Value (EGP)",
  format,
  subtitle,
  empty = "No data yet.",
}: {
  movers: TopMoverRow[];
  title: string;
  exportTitle: string;
  labelHeader?: string;
  valueHeader?: string;
  format?: (v: number) => string;
  subtitle?: string;
  empty?: string;
}) {
  const table = useSortableTable(movers, {
    columns: SORT_COLS,
    searchAccessors: [(r) => r.label],
    initialSort: { key: "value", dir: "desc" },
  });

  const maxVal = visibleMax(table.rows, (r) => r.value);
  const fmt = format ?? egp;
  const grandTotal = movers.reduce((s, r) => s + r.value, 0);

  const exportRows = movers.map((r) => ({
    label: r.label,
    value: r.value,
    share: grandTotal > 0 ? `${((r.value / grandTotal) * 100).toFixed(1)}%` : "—",
  }));

  return (
    <div className="space-y-2">
      {/* Toolbar: search + export */}
      <div className="flex flex-wrap items-center gap-2">
        <TableSearchInput
          placeholder={`Filter ${labelHeader.toLowerCase()}…`}
          value={table.query}
          onChange={table.setQuery}
          onClear={table.clearQuery}
          size="sm"
          className="min-w-0 flex-1"
        />
        <ExportXlsxButton
          title={exportTitle}
          subtitle={subtitle}
          sheetName={title}
          label="Export"
          columns={[
            { key: "label", label: labelHeader },
            { key: "value", label: valueHeader, numeric: true },
            { key: "share", label: "Share %" },
          ]}
          rows={exportRows}
          className="h-8 shrink-0"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-slate-900 text-left">
              <th className="px-2 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">
                #
              </th>
              <SortableTh
                label={labelHeader}
                sortKey="label"
                sort={table.sort}
                onSort={table.toggleSort}
                className="px-2 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white"
              />
              <SortableTh
                label={valueHeader}
                sortKey="value"
                sort={table.sort}
                onSort={table.toggleSort}
                align="right"
                className="px-2 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white"
              />
              <th className="px-2 py-2 text-right text-[10px] font-black uppercase tracking-[0.12em] text-white">
                Share
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.length === 0 ? (
              <TableNoResults
                colSpan={4}
                filtered={table.isFiltered}
                label={labelHeader.toLowerCase() + "s"}
              />
            ) : (
              (() => {
                const visibleTotal = table.rows.reduce((s, r) => s + r.value, 0);
                return table.rows.map((row, i) => (
                  <tr key={row.label} className="bg-white hover:bg-slate-50/80">
                    <td className="px-2 py-2 text-[10px] font-black text-slate-300">
                      #{i + 1}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-16 shrink-0 bg-slate-100">
                          <div
                            className="h-full bg-orange-400"
                            style={{ width: `${Math.max(3, (row.value / maxVal) * 100)}%` }}
                          />
                        </div>
                        <span className="font-semibold text-slate-800">{row.label}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right font-bold text-slate-900">
                      {fmt(row.value)}
                    </td>
                    <td className="px-2 py-2 text-right text-slate-500">
                      {visibleTotal > 0
                        ? `${((row.value / visibleTotal) * 100).toFixed(1)}%`
                        : "—"}
                    </td>
                  </tr>
                ));
              })()
            )}
          </tbody>
        </table>
      </div>

      {movers.length === 0 && !table.isFiltered ? (
        <p className="py-2 text-center text-[11px] text-slate-400">{empty}</p>
      ) : null}
    </div>
  );
}
