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

  // Nothing to show at all. Say so once, in one line.
  //
  // Until 2026-08-30 an empty table still rendered its whole apparatus: a filter box with nothing
  // to filter, an Export button that would have written an empty sheet, a header row, the table's
  // own "no rows" line, AND the `empty` message underneath it -- the same fact stated twice, under
  // two dead controls. Two of these sit in the Source of Sales card, which made that card 568px of
  // almost entirely blank white and the single largest empty area on the CEO, SFE and System
  // Administrator overviews. It is one component, so this closes it on all three at once.
  //
  // This is the movers.length === 0 case only, so it cannot hide anything: a filter that matches
  // nothing is a different state and still renders the toolbar below, because there the controls
  // are live and clearing the filter is the way out. Nothing is dropped from an export either --
  // there is no row to export.
  if (movers.length === 0) {
    return (
      <div className="border border-slate-200 bg-slate-50/70 px-3 py-4 text-center text-phx-xs text-slate-400">
        {empty}
      </div>
    );
  }

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
              <th className="px-2 py-2 text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">
                #
              </th>
              <SortableTh
                label={labelHeader}
                sortKey="label"
                sort={table.sort}
                onSort={table.toggleSort}
                className="px-2 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white"
              />
              <SortableTh
                label={valueHeader}
                sortKey="value"
                sort={table.sort}
                onSort={table.toggleSort}
                align="right"
                className="px-2 py-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-white"
              />
              <th className="px-2 py-2 text-right text-phx-2xs font-black uppercase tracking-[0.12em] text-white">
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
                    <td className="px-2 py-2 text-phx-2xs font-black text-slate-300">
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
    </div>
  );
}
