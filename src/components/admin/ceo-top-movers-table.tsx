"use client";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import {
  SortableTh,
  TableSearchInput,
  TableNoResults,
} from "@/components/ui/sortable-table";
import { useSortableTable, visibleMax } from "@/components/ui/use-sortable-table";
import { formatTopMoverShare, topMoverShareBasis } from "@/lib/ceo/top-mover-share";

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
  total,
  empty = "No data yet.",
}: {
  movers: TopMoverRow[];
  title: string;
  exportTitle: string;
  labelHeader?: string;
  valueHeader?: string;
  format?: (v: number) => string;
  subtitle?: string;
  /**
   * The denominator for the Share column: the WHOLE population's value, not just the rows listed
   * here. Every caller passes a truncated slice (`slice(0, 5)`, `slice(0, 7)`), so without this
   * the column reads as a share of the top few. Left out, it falls back to the sum of `movers`,
   * which is correct only when the caller really is passing a complete set.
   */
  total?: number;
  empty?: string;
}) {
  const table = useSortableTable(movers, {
    columns: SORT_COLS,
    searchAccessors: [(r) => r.label],
    initialSort: { key: "value", dir: "desc" },
  });

  const maxVal = visibleMax(table.rows, (r) => r.value);
  const fmt = format ?? egp;

  // ONE denominator, for the screen AND the export.
  //
  // There used to be two, and both were wrong. The screen divided by the rows left after the
  // FILTER (`table.rows`), so typing in the filter box silently re-based every percentage: narrow
  // to a single region and its share read 100.0%. The export divided by the sum of `movers`
  // instead — so a downloaded sheet and the screen it came from disagreed the moment anyone
  // filtered, which the standing rule that an export must MATCH the screen forbids outright.
  //
  // The sum of `movers` was not right either. Every caller passes a truncated list, so that sum is
  // the total of the top few, not of the period. Measured on production 2026-09-23 against the
  // Source of Sales months: the five listed regions are 90.4% of August's real regional value and
  // 87.6% of May's, so each region's share read roughly 11% and 14% too high — a region at a true
  // 27% was shown as 30%. Top Lines was unaffected in practice: only four lines carry sales, so
  // its top-5 slice is the whole population already.
  //
  // `total` is that real population value where the caller knows it. The shares then legitimately
  // do NOT sum to 100% on a top-N list, which is the honest outcome — the remaining money sits in
  // the rows that did not make the cut.
  //
  // The arithmetic itself lives in `@/lib/ceo/top-mover-share` so it can be tested without
  // rendering React; `movers` goes in, never `table.rows`, which is what re-based the old one.
  const shareBasis = topMoverShareBasis(movers, total);
  const sharePct = (value: number) => formatTopMoverShare(value, shareBasis);

  const exportRows = movers.map((r) => ({
    label: r.label,
    value: r.value,
    share: sharePct(r.value),
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
      <div>
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[10%]" />
            <col className="w-[50%]" />
            <col className="w-[22%]" />
            <col className="w-[18%]" />
          </colgroup>
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
              table.rows.map((row, i) => (
                  <tr key={row.label} className="bg-white hover:bg-slate-50/80">
                    <td className="px-2 py-2 text-phx-2xs font-black text-slate-300">
                      #{i + 1}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="h-1 w-12 shrink-0 bg-slate-100">
                          <div
                            className="h-full bg-orange-400"
                            style={{ width: `${Math.max(3, (row.value / maxVal) * 100)}%` }}
                          />
                        </div>
                        <span className="min-w-0 break-words font-semibold text-slate-800">{row.label}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-right font-bold text-slate-900">
                      {fmt(row.value)}
                    </td>
                    {/* Share of the whole population — NEVER of the rows the filter happens to leave. */}
                    <td className="px-2 py-2 text-right text-slate-500">{sharePct(row.value)}</td>
                  </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
