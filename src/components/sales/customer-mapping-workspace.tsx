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

const headerCell = "break-words px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em]";

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
          <div className="p-4 md:p-5">
            {result?.truncated ? (
              <p className="mb-3 text-xs font-semibold text-[#92400E]">
                Showing the first {formatNumber(shownCount)} of {formatNumber(totalCount)} — refine the filters to narrow the list. The XLSX export always contains the full filtered set.
              </p>
            ) : null}
            <div className="overflow-hidden border border-phx-line">
              {view === "byDistributor" ? (
                /* Eleven columns cannot divide a screen, so each ID rides UNDER the name it
                   belongs to — code under Customer, brick/area/region ids under their names —
                   rather than shrinking the type. Nothing is dropped.

                   Seven still cannot divide a PHONE: measured at 375px each column got ~45px and
                   the master code (a mono token that cannot break) overran its cell. So below `md`
                   five of them fold away and come back as sub-lines under the customer's name. */
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[58%] md:w-[18%]" />
                    <col className="hidden md:table-column md:w-[18%]" />
                    <col className="hidden md:table-column md:w-[14%]" />
                    <col className="hidden md:table-column md:w-[13%]" />
                    <col className="hidden md:table-column md:w-[12%]" />
                    <col className="hidden md:table-column md:w-[12%]" />
                    <col className="w-[42%] md:w-[13%]" />
                  </colgroup>
                  <thead className="bg-[#0B0B0B] text-slate-100">
                    <tr>
                      <th className={headerCell}>Customer</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Address</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Distributor</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Brick</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Area</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Region</th>
                      <th className={headerCell}>Master Customer</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-phx-line">
                    {isLoading ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={7}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                    ) : rows.length === 0 ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={7}>No customers match these filters.</td></tr>
                    ) : (
                      rows.map((row) => (
                        <tr className="transition-colors hover:bg-orange-50/50" key={`${row.distributorCode}:${row.customerCode}`}>
                          <td className="break-words px-3 py-2.5 align-top text-slate-700">
                            <span className="block">{row.customerName || "—"}</span>
                            <span className="block font-semibold tabular-nums text-xs text-slate-400">{row.customerCode}</span>
                            {/* Below `md` the five folded columns come back here, so a phone
                                loses nothing. */}
                            <span className="mt-1 block text-xs text-slate-500 md:hidden">{row.customerAddress || "—"}</span>
                            <span className="block text-xs text-slate-500 md:hidden">{row.distributorName}</span>
                            <span className="block text-xs text-slate-500 md:hidden">
                              {`${row.brickName || row.brickId || "—"} · ${row.areaName || "—"} / ${row.regionName || "—"}`}
                            </span>
                          </td>
                          {/* The address WRAPS — it used to be clamped to two lines, which is the
                              ellipsis the owner's rule forbids. */}
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-500 md:table-cell">{row.customerAddress || "—"}</td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">{row.distributorName}</td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">
                            <span className="block">{row.brickName || "—"}</span>
                            <span className="block text-xs text-slate-400">{row.brickId || "—"}</span>
                          </td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">
                            {row.areaName || "—"}
                          </td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">
                            {row.regionName || "—"}
                          </td>
                          <td className="break-words px-3 py-2.5 align-top">
                            <span className="font-mono text-xs font-semibold text-slate-700">{row.masterCustomerId}</span>
                            {row.matched ? (
                              <span className="ml-2 inline-block bg-phx-accent px-1.5 text-phx-sm font-black text-white">×{row.distributorSpan}</span>
                            ) : null}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                /* Ten columns merged to eight: the master id rides under the customer's name, and
                   the distributor codes under their count. table-fixed + a percentage colgroup
                   then makes a sideways scroll impossible whatever the data — and below `md` six
                   of the eight fold away, returning as sub-lines under the customer's name. */
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[58%] md:w-[18%]" />
                    <col className="hidden md:table-column md:w-[17%]" />
                    <col className="hidden md:table-column md:w-[12%]" />
                    <col className="hidden md:table-column md:w-[12%]" />
                    <col className="hidden md:table-column md:w-[12%]" />
                    <col className="hidden md:table-column md:w-[14%]" />
                    <col className="hidden md:table-column md:w-[7%]" />
                    <col className="w-[42%] md:w-[8%]" />
                  </colgroup>
                  <thead className="bg-[#0B0B0B] text-slate-100">
                    <tr>
                      <th className={headerCell}>Customer</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Address</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Brick</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Area</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Region</th>
                      <th className={`${headerCell} hidden md:table-cell`}>Distributors</th>
                      <th className={`${headerCell} hidden text-right md:table-cell`}>Units</th>
                      <th className={`${headerCell} text-right`}>Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-phx-line">
                    {isLoading ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={8}><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                    ) : consolidated.length === 0 ? (
                      <tr><td className="px-3 py-6 text-center text-slate-400" colSpan={8}>No customers match these filters.</td></tr>
                    ) : (
                      consolidated.map((master) => (
                        <tr className="transition-colors hover:bg-orange-50/50" key={master.masterCustomerId}>
                          <td className="break-words px-3 py-2.5 align-top">
                            <span className="block font-semibold text-phx-ink">{master.customerName || "—"}</span>
                            <span className="font-mono text-xs font-semibold text-slate-400">{master.masterCustomerId}</span>
                            {master.distributorSpan > 1 ? (
                              <span className="ml-2 inline-block bg-phx-accent px-1.5 text-phx-sm font-black text-white">×{master.distributorSpan}</span>
                            ) : null}
                            {/* Below `md` the six folded columns come back here, so a phone loses
                                nothing. */}
                            <span className="mt-1 block text-xs text-slate-500 md:hidden">{master.customerAddress || "—"}</span>
                            <span className="block text-xs text-slate-500 md:hidden">
                              {`${master.brickName || master.brickId || "—"} · ${master.areaName || "—"} / ${master.regionName || "—"}`}
                            </span>
                            <span className="block text-xs text-slate-500 md:hidden">
                              {`${formatNumber(master.distributorSpan)} distributors · ${master.members.map((member) => member.distributorCode).join(", ")}`}
                            </span>
                            <span className="block text-xs tabular-nums text-slate-500 md:hidden">{`${formatNumber(master.totalUnits)} units`}</span>
                          </td>
                          {/* Address and the distributor-code list WRAP — both were clamped to two
                              lines, which is the ellipsis the owner's rule forbids. */}
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-500 md:table-cell">{master.customerAddress || "—"}</td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">{master.brickName || master.brickId || "—"}</td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">{master.areaName || "—"}</td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">{master.regionName || "—"}</td>
                          <td className="hidden break-words px-3 py-2.5 align-top text-slate-600 md:table-cell">
                            <span className="block font-semibold tabular-nums text-slate-900">{formatNumber(master.distributorSpan)}</span>
                            <span className="block text-xs text-slate-400">{master.members.map((member) => member.distributorCode).join(", ")}</span>
                          </td>
                          <td className="hidden break-words px-3 py-2.5 text-right align-top tabular-nums font-semibold text-slate-900 md:table-cell">{formatNumber(master.totalUnits)}</td>
                          <td className="break-words px-3 py-2.5 text-right align-top tabular-nums font-semibold text-slate-900">{formatCurrency(master.totalValue)}</td>
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
