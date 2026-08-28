"use client";

import { AlertTriangle, Download, Layers, Link2, Loader2, Network } from "lucide-react";
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
import type {
  CustomerDirectoryFilterOptions,
  CustomerMappingResult,
} from "@/lib/sales/customer-mapping";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import { cn } from "@/lib/utils";

type Props = {
  initialError: string | null;
  initialResult: CustomerMappingResult | null;
  options: CustomerDirectoryFilterOptions;
};

type MappingResponse = {
  data?: CustomerMappingResult;
  error?: string;
  message?: string;
  success: boolean;
};

type ViewMode = "byDistributor" | "consolidated";

const headerCell = "whitespace-nowrap px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em]";

export function CustomerMappingWorkspace({ initialError, initialResult, options }: Props) {
  const [result, setResult] = useState<CustomerMappingResult | null>(initialResult);
  const [filter, setFilter] = useState<CustomerDirectoryFilterState>(emptyCustomerDirectoryFilterState);
  const [view, setView] = useState<ViewMode>("byDistributor");
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/sales/customer-mapping/export", {
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
      anchor.download = match?.[1] ?? "phoenix-customer-mapping.xlsx";
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
      const response = await fetch(`/api/sales/customer-mapping?${query.toString()}`, { cache: "no-store" });
      const text = await response.text();
      const payload: MappingResponse | null = text ? (JSON.parse(text) as MappingResponse) : null;

      if (!response.ok) {
        setError(
          payload?.error ?? payload?.message ?? `Request failed${response.status ? ` (${response.status} ${response.statusText})` : ""}.`,
        );
        return;
      }

      if (payload?.success && payload.data) {
        setResult(payload.data);
      } else {
        setError(payload?.error ?? "Failed to load Customer Mapping.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load Customer Mapping.");
    } finally {
      setIsLoading(false);
    }
  }

  if (initialError && !result) {
    return (
      <div className="min-h-[calc(100vh-7rem)] border border-phx-line bg-phx-paper p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const rows = result?.rows ?? [];
  const consolidated = result?.consolidated ?? [];
  const shownCount = view === "byDistributor" ? rows.length : consolidated.length;
  const totalCount = view === "byDistributor" ? result?.totalRows ?? rows.length : result?.totalConsolidated ?? consolidated.length;

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Customer rows: {formatNumber(result?.totalRows ?? rows.length)}</AdminInsightChip>
            <AdminInsightChip tone="slate">Master customers: {formatNumber(result?.totalConsolidated ?? consolidated.length)}</AdminInsightChip>
            <AdminInsightChip tone="orange">Consolidated across distributors: {formatNumber(result?.matchedMasters ?? 0)}</AdminInsightChip>
          </>
        )}
        description="A customer → brick/area/region crosswalk built from the uploaded distributor sales. Export it to VLOOKUP geography by customer code, and consolidate the same pharmacy across distributors (matched on name + brick + address)."
        eyebrow="Source of Sales"
        icon={<Network className="h-4 w-4" />}
        title="Customer Mapping"
      />

      <AdminTableShell
        action={(
          <button
            className="inline-flex h-10 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent disabled:opacity-50"
            disabled={isExporting || isLoading || (rows.length === 0 && consolidated.length === 0)}
            onClick={() => void handleExport()}
            type="button"
          >
            {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export XLSX
          </button>
        )}
        description="Customer codes are unique within a distributor — VLOOKUP by code works directly. The same pharmacy across distributors shares one Master Customer."
        title="Customer Mapping"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-4 md:px-5">
          <div className="flex items-center border border-phx-line">
            <button
              className={cn(
                "flex h-10 items-center gap-2 px-3 text-sm font-bold transition",
                view === "byDistributor" ? "bg-[#0B0B0B] text-white" : "bg-white text-slate-600 hover:text-phx-accent",
              )}
              onClick={() => setView("byDistributor")}
              type="button"
            >
              <Layers className="h-4 w-4" /> By distributor
            </button>
            <button
              className={cn(
                "flex h-10 items-center gap-2 px-3 text-sm font-bold transition",
                view === "consolidated" ? "bg-[#0B0B0B] text-white" : "bg-white text-slate-600 hover:text-phx-accent",
              )}
              onClick={() => setView("consolidated")}
              type="button"
            >
              <Link2 className="h-4 w-4" /> Consolidated
            </button>
          </div>
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
          <div className="overflow-x-auto p-4 md:p-5">
            {result?.truncated ? (
              <p className="mb-3 text-xs font-semibold text-[#92400E]">
                Showing the first {formatNumber(shownCount)} of {formatNumber(totalCount)} — refine the filters to narrow the list. The XLSX export always contains the full filtered set.
              </p>
            ) : null}
            <div className="overflow-hidden border border-phx-line">
              {view === "byDistributor" ? (
                <table className="w-full min-w-[1400px] text-sm">
                  <thead className="bg-[#0B0B0B] text-slate-100">
                    <tr>
                      <th className={headerCell}>Customer Code</th>
                      <th className={headerCell}>Customer Name</th>
                      <th className={headerCell}>Address</th>
                      <th className={headerCell}>Distributor</th>
                      <th className={headerCell}>Brick ID</th>
                      <th className={headerCell}>Brick Name</th>
                      <th className={headerCell}>Area ID</th>
                      <th className={headerCell}>Area Name</th>
                      <th className={headerCell}>Region ID</th>
                      <th className={headerCell}>Region Name</th>
                      <th className={headerCell}>Master Customer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-phx-line">
                    {isLoading ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={11}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                    ) : rows.length === 0 ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={11}>No customers match these filters.</td></tr>
                    ) : (
                      rows.map((row) => (
                        <tr className="transition-colors hover:bg-orange-50/50" key={`${row.distributorCode}:${row.customerCode}`}>
                          <td className="whitespace-nowrap px-3 py-2.5 font-semibold tabular-nums text-phx-ink">{row.customerCode}</td>
                          <td className="px-3 py-2.5 text-slate-700">{row.customerName || "—"}</td>
                          <td className="max-w-[260px] px-3 py-2.5 text-slate-500"><span className="line-clamp-2">{row.customerAddress || "—"}</span></td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.distributorName}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-700">{row.brickId || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.brickName || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.areaCode || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.areaName || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.regionCode || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.regionName || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <span className="font-mono text-xs font-semibold text-slate-700">{row.masterCustomerId}</span>
                            {row.matched ? (
                              <span className="ml-2 bg-phx-accent px-1.5 text-[10px] font-black text-white">×{row.distributorSpan}</span>
                            ) : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="w-full min-w-[1300px] text-sm">
                  <thead className="bg-[#0B0B0B] text-slate-100">
                    <tr>
                      <th className={headerCell}>Master Customer</th>
                      <th className={headerCell}>Customer Name</th>
                      <th className={headerCell}>Address</th>
                      <th className={headerCell}>Brick</th>
                      <th className={headerCell}>Area</th>
                      <th className={headerCell}>Region</th>
                      <th className={`${headerCell} text-right`}>Distributors</th>
                      <th className={headerCell}>Distributor codes</th>
                      <th className={`${headerCell} text-right`}>Units</th>
                      <th className={`${headerCell} text-right`}>Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-phx-line">
                    {isLoading ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={10}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                    ) : consolidated.length === 0 ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={10}>No customers match these filters.</td></tr>
                    ) : (
                      consolidated.map((master) => (
                        <tr className="transition-colors hover:bg-orange-50/50" key={master.masterCustomerId}>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <span className="font-mono text-xs font-semibold text-slate-700">{master.masterCustomerId}</span>
                            {master.distributorSpan > 1 ? (
                              <span className="ml-2 bg-phx-accent px-1.5 text-[10px] font-black text-white">×{master.distributorSpan}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5 font-semibold text-phx-ink">{master.customerName || "—"}</td>
                          <td className="max-w-[240px] px-3 py-2.5 text-slate-500"><span className="line-clamp-2">{master.customerAddress || "—"}</span></td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{master.brickName || master.brickId || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{master.areaName || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{master.regionName || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{formatNumber(master.distributorSpan)}</td>
                          <td className="max-w-[220px] px-3 py-2.5 text-slate-500"><span className="line-clamp-2">{master.members.map((member) => member.distributorCode).join(", ")}</span></td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{formatNumber(master.totalUnits)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{formatCurrency(master.totalValue)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
