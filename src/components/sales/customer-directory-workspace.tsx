"use client";

import { AlertTriangle, ArrowUpRight, Download, Loader2, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  CustomerDirectoryFilters,
  emptyCustomerDirectoryFilterState,
  type CustomerDirectoryFilterState,
} from "@/components/sales/customer-directory-filters";
import { SortableTh, TableNoResults, TableSearchInput, useSortableTable } from "@/components/ui/sortable-table";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type {
  CustomerDirectoryFilterOptions,
  CustomerDirectoryListResult,
  CustomerDirectoryRow,
} from "@/lib/sales/customer-directory";

type Props = {
  initialError: string | null;
  initialResult: CustomerDirectoryListResult | null;
  options: CustomerDirectoryFilterOptions;
};

type DirectoryResponse = {
  data?: CustomerDirectoryListResult;
  error?: string;
  success: boolean;
};

const headerCell = "break-words px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em]";

function customerHref(row: CustomerDirectoryRow) {
  return `/sales/customer-directory/${encodeURIComponent(row.distributorCode)}/${encodeURIComponent(row.clientCode)}`;
}

export function CustomerDirectoryWorkspace({ initialError, initialResult, options }: Props) {
  const [result, setResult] = useState<CustomerDirectoryListResult | null>(initialResult);
  const [filter, setFilter] = useState<CustomerDirectoryFilterState>(emptyCustomerDirectoryFilterState);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/sales/customer-directory/export", {
        body: JSON.stringify({
          areaCodes: filter.areaCodes,
          brickCodes: filter.brickCodes,
          distributorCodes: filter.distributorCodes,
          fromPeriod: filter.fromPeriod,
          regionCodes: filter.regionCodes,
          search: filter.search,
          toPeriod: filter.toPeriod,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-customer-directory.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  async function reload(next: CustomerDirectoryFilterState) {
    setFilter(next);
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (next.regionCodes.length) query.set("region", next.regionCodes.join(","));
      if (next.areaCodes.length) query.set("area", next.areaCodes.join(","));
      if (next.brickCodes.length) query.set("brick", next.brickCodes.join(","));
      if (next.distributorCodes.length) query.set("distributor", next.distributorCodes.join(","));
      if (next.fromPeriod) query.set("from", next.fromPeriod);
      if (next.toPeriod) query.set("to", next.toPeriod);
      if (next.search.trim()) query.set("search", next.search.trim());
      const response = await fetch(`/api/sales/customer-directory?${query.toString()}`, { cache: "no-store" });
      const text = await response.text();
      const payload: DirectoryResponse = text ? JSON.parse(text) : { success: response.ok };
      if (payload.success && payload.data) {
        setResult(payload.data);
      } else {
        setError(payload.error ?? "Failed to load Customer Directory.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load Customer Directory.");
    } finally {
      setIsLoading(false);
    }
  }

  const customers = result?.customers ?? [];
  // Client-side sort + quick-filter over the loaded page (the server filters re-fetch the full set;
  // this gives instant column sorting + a fast text filter on what is already on screen).
  const table = useSortableTable(customers, {
    columns: [
      { key: "clientName", accessor: (row) => row.clientName, type: "string" },
      { key: "clientAddress", accessor: (row) => row.clientAddress, type: "string" },
      { key: "distributorName", accessor: (row) => row.distributorName, type: "string" },
      { key: "brickId", accessor: (row) => row.brickId, type: "string" },
      { key: "brickName", accessor: (row) => row.brickName, type: "string" },
      { key: "areaName", accessor: (row) => row.areaName, type: "string" },
      { key: "regionName", accessor: (row) => row.regionName, type: "string" },
      { key: "totalUnits", accessor: (row) => row.totalUnits, type: "number" },
      { key: "totalValue", accessor: (row) => row.totalValue, type: "number" },
    ],
    searchAccessors: [
      (row) => row.clientName,
      (row) => row.clientCode,
      (row) => row.clientAddress,
      (row) => row.distributorName,
      (row) => row.brickId,
      (row) => row.brickName,
      (row) => row.areaName,
      (row) => row.regionName,
    ],
    initialSort: null,
  });

  if (initialError && !result) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-phx-paper p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            {/* `customers` is the server's page, cut off at DIRECTORY_RESULT_LIMIT rows. Printing its
                length as a bare count made the chip read "Customers: 2,000" for every filter wide
                enough to hit the cap — a display limit presented as a business figure. When the
                result is truncated the true total is not known here, so say "+" and name the cap. */}
            <AdminInsightChip>
              {result?.truncated
                ? `Customers: ${formatNumber(customers.length)}+ (list capped)`
                : `Customers: ${formatNumber(customers.length)}`}
            </AdminInsightChip>
            <AdminInsightChip tone="orange">Each row = one customer per distributor</AdminInsightChip>
            <AdminInsightChip tone="slate">Value = Qty × factory price</AdminInsightChip>
          </>
        )}
        description="Customers from the uploaded distributor sales. Filter by region, area, brick (by name), distributor and period; click a customer to drill into their full sales."
        eyebrow="Customer Directory"
        icon={<Users className="h-4 w-4" />}
        title="Customer Directory"
      />

      <AdminTableShell
        action={(
          <button
            className="inline-flex h-10 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent disabled:opacity-50"
            disabled={isExporting || isLoading || customers.length === 0}
            onClick={() => void handleExport()}
            type="button"
          >
            {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export XLSX
          </button>
        )}
        description="One row per customer + distributor. The same pharmacy across different distributors stays separate."
        title="Customers"
      >
        <div className="border-b border-slate-100 px-4 py-4 md:px-5">
          <CustomerDirectoryFilters onChange={(next) => void reload(next)} options={options} value={filter} />
        </div>

        {error ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{error}</p>
            </AdminCallout>
          </div>
        ) : (
          <div className="p-4 md:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              {result?.truncated ? (
                <p className="text-xs font-semibold text-[#92400E]">
                  Showing the first {formatNumber(customers.length)} customers — refine the filters to narrow the list.
                </p>
              ) : <span />}
              <div className="flex items-center gap-2">
                {table.isFiltered ? (
                  <span className="text-xs font-semibold text-slate-500">{table.visible} of {table.total} loaded</span>
                ) : null}
                <div className="w-56">
                  <TableSearchInput
                    value={table.query}
                    onChange={table.setQuery}
                    onClear={table.clearQuery}
                    placeholder="Quick-filter loaded rows…"
                    size="md"
                  />
                </div>
              </div>
            </div>
            <div className="overflow-hidden border border-phx-line">
              {/* Ten columns cannot divide a screen, so two pairs are MERGED rather than shrunk:
                  Brick ID rides under Brick, Region under Territory. table-fixed + a percentage
                  colgroup then makes a sideways scroll impossible whatever the data. */}
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[46%] md:w-[20%] lg:w-[18%]" />
                  <col className="hidden md:table-column md:w-[14%] lg:w-[16%]" />
                  <col className="hidden md:table-column md:w-[12%] lg:w-[13%]" />
                  <col className="hidden md:table-column md:w-[12%] lg:w-[13%]" />
                  <col className="hidden md:table-column md:w-[12%] lg:w-[13%]" />
                  <col className="hidden md:table-column md:w-[9%] lg:w-[9%]" />
                  <col className="w-[26%] md:w-[10%] lg:w-[10%]" />
                  {/* The View link cannot shrink below about 75px, so the action column keeps a
                      wider share as the screen narrows — a fixed column narrower than its own
                      button CLIPS it, measured at 768px before this floor went in. */}
                  <col className="w-[28%] md:w-[11%] lg:w-[8%]" />
                </colgroup>
                <thead className="bg-[#0B0B0B] text-slate-100">
                  <tr>
                    <SortableTh label="Customer" sortKey="clientName" sort={table.sort} onSort={table.toggleSort} variant="dark" className="break-words text-xs tracking-[0.12em]" />
                    <SortableTh label="Address" sortKey="clientAddress" sort={table.sort} onSort={table.toggleSort} variant="dark" className="hidden break-words text-xs tracking-[0.12em] md:table-cell" />
                    <SortableTh label="Distributor" sortKey="distributorName" sort={table.sort} onSort={table.toggleSort} variant="dark" className="hidden break-words text-xs tracking-[0.12em] md:table-cell" />
                    <SortableTh label="Brick" sortKey="brickName" sort={table.sort} onSort={table.toggleSort} variant="dark" className="hidden break-words text-xs tracking-[0.12em] md:table-cell" />
                    <SortableTh label="Territory" sortKey="areaName" sort={table.sort} onSort={table.toggleSort} variant="dark" className="hidden break-words text-xs tracking-[0.12em] md:table-cell" />
                    <SortableTh label="Units" sortKey="totalUnits" sort={table.sort} onSort={table.toggleSort} align="right" variant="dark" className="hidden break-words text-xs tracking-[0.12em] md:table-cell" />
                    <SortableTh label="Value" sortKey="totalValue" sort={table.sort} onSort={table.toggleSort} align="right" variant="dark" className="break-words text-xs tracking-[0.12em]" />
                    <th className={headerCell}></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-phx-line">
                  {isLoading ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-400" colSpan={8}>
                        <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                      </td>
                    </tr>
                  ) : table.rows.length === 0 ? (
                    customers.length === 0 ? (
                      <tr>
                        <td className="px-3 py-6 text-center text-slate-400" colSpan={8}>No customers match these filters.</td>
                      </tr>
                    ) : (
                      <TableNoResults colSpan={8} filtered label="customers" />
                    )
                  ) : (
                    table.rows.map((row) => (
                      <tr className="transition-colors hover:bg-orange-50/50" key={`${row.distributorCode}:${row.clientCode}`}>
                        <td className="break-words px-3 py-2.5 align-top">
                          <Link className="block" href={customerHref(row)}>
                            <span className="block font-semibold text-phx-ink hover:text-phx-accent">{row.clientName || "—"}</span>
                            <span className="block text-xs text-slate-400">{row.clientCode}</span>
                          </Link>
                          {/* Below `md` the five folded columns come back here, so a phone loses nothing. */}
                          <span className="mt-1 block text-xs text-slate-500 md:hidden">{row.clientAddress || "—"}</span>
                          <span className="block text-xs text-slate-500 md:hidden">
                            {`${row.distributorName} · ${row.brickName || row.brickId || "—"} · ${row.areaName} / ${row.regionName}`}
                          </span>
                          <span className="block text-xs tabular-nums text-slate-500 md:hidden">
                            {`${formatNumber(row.totalUnits)} units`}
                          </span>
                        </td>
                        {/* The address WRAPS — it used to be clamped to two lines, which is the
                            ellipsis the owner's rule forbids. */}
                        <td className="hidden break-words px-3 py-2.5 align-top text-slate-500 md:table-cell">{row.clientAddress || "—"}</td>
                        <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">{row.distributorName}</td>
                        <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">
                          <span className="block">{row.brickName || "—"}</span>
                          <span className="block text-xs text-slate-400">{row.brickId}</span>
                        </td>
                        <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">
                          <span className="block">{row.areaName}</span>
                          <span className="block text-xs text-slate-400">{row.regionName}</span>
                        </td>
                        <td className="hidden break-words px-3 py-2.5 text-right align-top tabular-nums font-semibold text-slate-900 md:table-cell">{formatNumber(row.totalUnits)}</td>
                        <td className="break-words px-3 py-2.5 text-right align-top tabular-nums font-semibold text-slate-900">{formatCurrency(row.totalValue)}</td>
                        <td className="px-3 py-2.5 align-top">
                          <Link className="inline-flex items-center gap-1 border border-slate-200 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:border-phx-accent-line hover:text-phx-accent" href={customerHref(row)}>
                            View <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
