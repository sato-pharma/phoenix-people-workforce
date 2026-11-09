"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable, visibleMax } from "@/components/ui/use-sortable-table";

type RegionRow  = { key: string; label: string; totalValue: number; totalQty: number };
type ProductRow = { key: string; label: string; totalValue: number; totalQty: number; line: string | null };

function egp(v: number) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `EGP ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `EGP ${(v / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(v).toLocaleString("en-US")}`;
}

function RegionTable({ rows, period }: { rows: RegionRow[]; period: string | null }) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "label",      accessor: (r) => r.label,      type: "string", defaultDir: "asc" },
      { key: "totalValue", accessor: (r) => r.totalValue, type: "number" },
      { key: "totalQty",   accessor: (r) => r.totalQty,   type: "number" },
    ],
    searchAccessors: [(r) => r.label],
    initialSort: { key: "totalValue", dir: "desc" },
  });
  const grandTotal = rows.reduce((s, r) => s + r.totalValue, 0);
  const maxVal = visibleMax(table.rows, (r) => r.totalValue);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput
          placeholder="Search region…"
          value={table.query}
          onChange={table.setQuery}
          onClear={table.clearQuery}
        />
        <ExportXlsxButton
          title={`Monthly SoS by Region${period ? ` — ${period}` : ""}`}
          sheetName="Region"
          columns={[
            { key: "label",      label: "Region" },
            { key: "totalValue", label: "Value (EGP)", numeric: true },
            { key: "totalQty",   label: "Qty",         numeric: true },
            { key: "share",      label: "Share %" },
          ]}
          rows={rows.map((r) => ({
            label:      r.label,
            totalValue: r.totalValue,
            totalQty:   r.totalQty,
            share:      grandTotal > 0 ? `${((r.totalValue / grandTotal) * 100).toFixed(1)}%` : "—",
          }))}
        />
      </div>
      <table className="w-full table-fixed border-collapse text-xs">
        <colgroup>
          <col className="w-[40%]" />
          <col className="w-[24%]" />
          <col className="w-[16%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead>
          <tr className="bg-slate-900 text-left">
            <SortableTh label="Region" sortKey="label"      sort={table.sort} onSort={table.toggleSort} className="px-3 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-white" />
            <SortableTh label="Value"  sortKey="totalValue" sort={table.sort} onSort={table.toggleSort} className="px-3 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-white" align="right" />
            <SortableTh label="Qty"    sortKey="totalQty"   sort={table.sort} onSort={table.toggleSort} className="px-3 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-white" align="right" />
            <th className="px-3 py-2 text-right text-phx-sm font-black uppercase tracking-[0.12em] text-white">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {table.rows.length === 0 ? (
            <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-400">No data.</td></tr>
          ) : table.rows.map((row) => (
            <tr key={row.key} className="bg-white hover:bg-slate-50">
              <td className="px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="h-1.5 w-12 shrink-0 bg-slate-100">
                    <div className="h-full bg-orange-400" style={{ width: `${Math.max(2, (row.totalValue / maxVal) * 100)}%` }} />
                  </div>
                  <span className="min-w-0 break-words font-semibold text-slate-800">{row.label}</span>
                </div>
              </td>
              <td className="px-3 py-2 text-right font-bold text-slate-900">{egp(row.totalValue)}</td>
              <td className="px-3 py-2 text-right text-slate-600">{row.totalQty.toLocaleString("en-US")}</td>
              <td className="px-3 py-2 text-right text-slate-500">
                {grandTotal > 0 ? `${((row.totalValue / grandTotal) * 100).toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductTable({ rows, period }: { rows: ProductRow[]; period: string | null }) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "label",      accessor: (r) => r.label,      type: "string", defaultDir: "asc" },
      { key: "line",       accessor: (r) => r.line,        type: "string" },
      { key: "totalValue", accessor: (r) => r.totalValue,  type: "number" },
      { key: "totalQty",   accessor: (r) => r.totalQty,    type: "number" },
    ],
    searchAccessors: [(r) => r.label, (r) => r.line],
    initialSort: { key: "totalValue", dir: "desc" },
  });
  const grandTotal = rows.reduce((s, r) => s + r.totalValue, 0);
  const maxVal = visibleMax(table.rows, (r) => r.totalValue);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput
          placeholder="Search product or line…"
          value={table.query}
          onChange={table.setQuery}
          onClear={table.clearQuery}
        />
        <ExportXlsxButton
          title={`Monthly SoS by Product${period ? ` — ${period}` : ""}`}
          sheetName="Product"
          columns={[
            { key: "label",      label: "Product" },
            { key: "line",       label: "Line" },
            { key: "totalValue", label: "Value (EGP)", numeric: true },
            { key: "totalQty",   label: "Qty",         numeric: true },
            { key: "share",      label: "Share %" },
          ]}
          rows={rows.map((r) => ({
            label:      r.label,
            line:       r.line ?? "—",
            totalValue: r.totalValue,
            totalQty:   r.totalQty,
            share:      grandTotal > 0 ? `${((r.totalValue / grandTotal) * 100).toFixed(1)}%` : "—",
          }))}
        />
      </div>
      <table className="w-full table-fixed border-collapse text-xs">
        <colgroup>
          <col className="w-[34%]" />
          <col className="w-[18%]" />
          <col className="w-[22%]" />
          <col className="w-[12%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead>
          <tr className="bg-slate-900 text-left">
            <SortableTh label="Product" sortKey="label"      sort={table.sort} onSort={table.toggleSort} className="px-3 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-white" />
            <SortableTh label="Line"    sortKey="line"       sort={table.sort} onSort={table.toggleSort} className="px-3 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-white" />
            <SortableTh label="Value"   sortKey="totalValue" sort={table.sort} onSort={table.toggleSort} className="px-3 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-white" align="right" />
            <SortableTh label="Qty"     sortKey="totalQty"   sort={table.sort} onSort={table.toggleSort} className="px-3 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-white" align="right" />
            <th className="px-3 py-2 text-right text-phx-sm font-black uppercase tracking-[0.12em] text-white">Share</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {table.rows.length === 0 ? (
            <tr><td colSpan={5} className="px-3 py-4 text-center text-slate-400">No data.</td></tr>
          ) : table.rows.map((row) => (
            <tr key={row.key} className="bg-white hover:bg-slate-50">
              <td className="px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="h-1.5 w-12 shrink-0 bg-slate-100">
                    <div className="h-full bg-orange-400" style={{ width: `${Math.max(2, (row.totalValue / maxVal) * 100)}%` }} />
                  </div>
                  <span className="min-w-0 break-words font-semibold text-slate-800">{row.label}</span>
                </div>
              </td>
              <td className="break-words px-3 py-2 text-slate-500">{row.line ?? "—"}</td>
              <td className="px-3 py-2 text-right font-bold text-slate-900">{egp(row.totalValue)}</td>
              <td className="px-3 py-2 text-right text-slate-600">{row.totalQty.toLocaleString("en-US")}</td>
              <td className="px-3 py-2 text-right text-slate-500">
                {grandTotal > 0 ? `${((row.totalValue / grandTotal) * 100).toFixed(1)}%` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Tab = "region" | "product";

export function CeoSosTables({
  byRegion,
  byProduct,
  period,
}: {
  byRegion: RegionRow[];
  byProduct: ProductRow[];
  period: string | null;
}) {
  const [tab, setTab] = useState<Tab>("region");

  return (
    <div className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex border border-slate-200">
          {(["region", "product"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-phx-xs font-bold uppercase tracking-[0.1em] transition ${
                tab === t
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              By {t}
            </button>
          ))}
        </div>
        {period ? <span className="text-phx-sm text-slate-400">Period: {period}</span> : null}
        <Link
          href="/sales/monthly-closing"
          className="inline-flex items-center gap-1.5 border border-slate-200 bg-white px-3 py-1.5 text-phx-xs font-bold text-slate-700 hover:border-orange-300 hover:text-orange-700"
        >
          Full SoS <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {tab === "region" ? (
        <RegionTable rows={byRegion} period={period} />
      ) : (
        <ProductTable rows={byProduct} period={period} />
      )}
    </div>
  );
}
