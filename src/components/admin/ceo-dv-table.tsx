"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable, visibleMax } from "@/components/ui/use-sortable-table";
import type { CeoDvManagerRow } from "@/lib/ceo/command-center";
import { codeOrWords } from "@/lib/format/code-label";

function pct(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

function days(v: number | null) {
  if (v == null) return "—";
  return `${v}d`;
}

const COLS = [
  { key: "managerName",        accessor: (r: CeoDvManagerRow) => r.managerName,         type: "string" as const, defaultDir: "asc" as const },
  { key: "roleCode",           accessor: (r: CeoDvManagerRow) => r.roleCode,             type: "string" as const },
  { key: "distinctMrs",        accessor: (r: CeoDvManagerRow) => r.distinctMrs,          type: "number" as const },
  { key: "overFocusedMrCount", accessor: (r: CeoDvManagerRow) => r.overFocusedMrCount,   type: "number" as const },
  { key: "neglectedMrCount",   accessor: (r: CeoDvManagerRow) => r.neglectedMrCount,     type: "number" as const },
  { key: "neglectIndex",       accessor: (r: CeoDvManagerRow) => r.neglectIndex,         type: "number" as const },
  { key: "daysSinceLastDv",    accessor: (r: CeoDvManagerRow) => r.daysSinceLastDv,      type: "number" as const },
  { key: "coveragePct",        accessor: (r: CeoDvManagerRow) => r.coveragePct,          type: "number" as const },
];

export function CeoDvTable({
  rows,
  dateFrom,
  dateTo,
}: {
  rows: CeoDvManagerRow[];
  dateFrom: string;
  dateTo: string;
}) {
  const table = useSortableTable(rows, {
    columns: COLS,
    searchAccessors: [(r) => r.managerName, (r) => r.roleCode, (r) => r.lineName],
    initialSort: { key: "neglectIndex", dir: "desc" },
  });

  const maxNeglect = visibleMax(table.rows, (r) => r.neglectedMrCount ?? 0);
  const maxOver    = visibleMax(table.rows, (r) => r.overFocusedMrCount);

  const exportRows = rows.map((r) => ({
    manager:      r.managerName,
    role:         r.roleCode ?? "—",
    line:         r.lineName ?? "—",
    distinct_mrs: r.distinctMrs,
    over_focused: r.overFocusedMrCount,
    neglected:    r.neglectedMrCount ?? 0,
    neglect_pct:  r.neglectIndex != null ? `${Math.round(r.neglectIndex * 100)}%` : "—",
    days_since_dv: r.daysSinceLastDv ?? "",
    coverage_pct: r.coveragePct != null ? `${Math.round(r.coveragePct)}%` : "—",
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TableSearchInput
          placeholder="Search manager, role, line…"
          value={table.query}
          onChange={table.setQuery}
          onClear={table.clearQuery}
        />
        <div className="flex items-center gap-2">
          <span className="text-phx-2xs text-slate-400">{dateFrom} → {dateTo}</span>
          <ExportXlsxButton
            title="Double-Visit Intelligence"
            subtitle={`${dateFrom} to ${dateTo}`}
            sheetName="DV Intelligence"
            columns={[
              { key: "manager",       label: "Manager" },
              { key: "role",          label: "Role" },
              { key: "line",          label: "Line" },
              { key: "distinct_mrs",  label: "Distinct MRs",       numeric: true },
              { key: "over_focused",  label: "Over-Focused MRs",   numeric: true },
              { key: "neglected",     label: "Neglected MRs",      numeric: true },
              { key: "neglect_pct",   label: "Neglect %" },
              { key: "days_since_dv", label: "Days Since Last DV", numeric: true },
              { key: "coverage_pct",  label: "Coverage %" },
            ]}
            rows={exportRows}
          />
          <Link
            href="/admin/double-visit-analytics"
            className="inline-flex items-center gap-1.5 border border-slate-200 bg-white px-3 py-1.5 text-phx-xs font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700"
          >
            Full Analytics <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse text-xs">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[8%]" />
            <col className="w-[16%]" />
            <col className="w-[22%]" />
            <col className="w-[12%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-900 text-left">
              <SortableTh label="Manager · role" sortKey="managerName"        sort={table.sort} onSort={table.toggleSort} className="px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white" />
              <SortableTh label="MRs"          sortKey="distinctMrs"        sort={table.sort} onSort={table.toggleSort} className="px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white text-right" align="right" />
              <SortableTh label="Over-Focused" sortKey="overFocusedMrCount" sort={table.sort} onSort={table.toggleSort} className="px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-amber-300 text-right" align="right" />
              <SortableTh label="Neglected · %" sortKey="neglectedMrCount"   sort={table.sort} onSort={table.toggleSort} className="px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-rose-300 text-right" align="right" />
              <SortableTh label="Last DV"      sortKey="daysSinceLastDv"    sort={table.sort} onSort={table.toggleSort} className="px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white text-right" align="right" />
              <SortableTh label="Coverage"     sortKey="coveragePct"        sort={table.sort} onSort={table.toggleSort} className="px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-emerald-300 text-right" align="right" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-slate-400">No manager data available.</td></tr>
            ) : (
              table.rows.map((row) => {
                const neglectPct   = maxNeglect > 0 ? ((row.neglectedMrCount ?? 0) / maxNeglect) * 100 : 0;
                const overPct      = maxOver    > 0 ? (row.overFocusedMrCount / maxOver) * 100 : 0;
                const isHighNeglect = (row.neglectIndex ?? 0) >= 0.3;
                const isStale       = (row.daysSinceLastDv ?? 0) > 14;
                return (
                  <tr key={row.managerHrId} className="bg-white hover:bg-slate-50">
                    <td className="min-w-0 break-words px-3 py-2">
                      <span className="font-semibold text-slate-900">{row.managerName}</span>
                      <span className="block text-phx-2xs text-slate-500">
                        {[codeOrWords(row.roleCode), row.lineName].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-900">{row.distinctMrs}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-end gap-1">
                        <div className="h-1 w-full bg-slate-100">
                          <div className="h-full bg-amber-400" style={{ width: `${Math.max(2, overPct)}%` }} />
                        </div>
                        <span className={`font-bold ${row.overFocusedMrCount > 0 ? "text-amber-700" : "text-slate-400"}`}>
                          {row.overFocusedMrCount}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-end gap-1">
                        <div className="h-1 w-full bg-slate-100">
                          <div className="h-full bg-rose-400" style={{ width: `${Math.max(2, neglectPct)}%` }} />
                        </div>
                        <span className={`font-bold ${isHighNeglect ? "text-rose-700" : "text-slate-700"}`}>
                          {row.neglectedMrCount ?? "—"} · {pct(row.neglectIndex)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`font-semibold ${isStale ? "text-rose-600" : "text-slate-700"}`}>
                        {days(row.daysSinceLastDv)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className={`font-bold ${(row.coveragePct ?? 0) >= 80 ? "text-emerald-700" : (row.coveragePct ?? 0) >= 50 ? "text-amber-700" : "text-rose-600"}`}>
                        {row.coveragePct != null ? `${Math.round(row.coveragePct)}%` : "—"}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div className="space-y-2 md:hidden">
        {table.rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">No manager data available.</p>
        ) : (
          table.rows.map((row) => (
            <div className="space-y-1 break-words border border-slate-200 bg-white p-3 text-xs" key={row.managerHrId}>
              <p className="text-sm font-semibold text-slate-900">{row.managerName}</p>
              <p className="text-slate-500">{[codeOrWords(row.roleCode), row.lineName].filter(Boolean).join(" · ") || "—"}</p>
              <p className="text-slate-700">
                {row.distinctMrs} MRs · {row.overFocusedMrCount} over-focused · {row.neglectedMrCount ?? "—"} neglected ({pct(row.neglectIndex)})
              </p>
              <p className="text-slate-700">
                Last DV {days(row.daysSinceLastDv)} · Coverage {row.coveragePct != null ? `${Math.round(row.coveragePct)}%` : "—"}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
