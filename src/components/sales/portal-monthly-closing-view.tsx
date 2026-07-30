"use client";

import { CalendarRange, Download, Loader2, Table2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { ClosingDetailsPanel } from "@/components/sales/closing-details-panel";
import { ClosingMatrixTable } from "@/components/sales/closing-matrix-table";
import {
  MonthlyClosingFilters,
  emptyMonthlyClosingFilter,
  type MonthlyClosingFilter,
} from "@/components/sales/monthly-closing-filters";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import {
  filterMonthlyClosingMatrix,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";

// Employee-portal render of the SAME Closing Matrix + Details view an admin sees at
// /sales/monthly-closing — but scoped to the viewer (District/Regional/National Sales Manager,
// Product/Group Product Manager) and PUBLISHED-gated. The server (loadPortalMonthlyClosing) has
// already narrowed the matrix to the viewer's line/region/area/products and stripped confidential
// columns; this component is pure presentation on top of that, so it can never widen visibility.
//
// The line is LOCKED (resolved from the viewer's HR_ID, never chosen). The month picker only offers
// PUBLISHED months; switching months re-runs the scoped server load via a ?period= navigation, so no
// client fetch can bypass the scope. Region/Area/Product are client-side filters over the already-
// scoped matrix (identical to the admin workspace). Export reuses the shared scoped export route,
// which re-derives the rows from this caller's own access.

type Props = {
  matrix: MonthlyClosingMatrix | null;
  /** Locked display line, resolved server-side from the viewer's HR_ID. */
  line: string;
  /** Published months for this viewer's line (newest first). */
  availablePeriods: string[];
  selectedPeriod: string | null;
};

const monthSelectClassName =
  "h-11 w-44 rounded border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10 disabled:opacity-60";

export function PortalMonthlyClosingView({ matrix, line, availablePeriods, selectedPeriod }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState<MonthlyClosingFilter>(emptyMonthlyClosingFilter);
  const [tab, setTab] = useState<"matrix" | "details">("matrix");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const filteredMatrix = useMemo(
    () => (matrix ? filterMonthlyClosingMatrix(matrix, filter) : null),
    [matrix, filter],
  );

  // Same option-building the admin workspace uses — regions/areas/products drawn from the (already
  // scoped) matrix. The synthetic per-region "Direct" rows are excluded: they share the "DIRECT"
  // code across regions and are not a filterable area.
  const filterOptions = useMemo(() => {
    if (!matrix) return { areas: [], products: [], regions: [] };
    return {
      regions: matrix.regions.map((region) => ({
        code: region.regionCode,
        label: `${region.regionName} (${region.regionCode})`,
      })),
      areas: matrix.regions.flatMap((region) =>
        region.areas
          .filter((area) => !area.isDirect)
          .map((area) => ({
            code: area.areaCode,
            label: `${area.areaName} (${area.areaCode})`,
            regionCode: region.regionCode,
          })),
      ),
      products: matrix.columns.map((column) => ({
        code: column.productCode,
        label: `${column.productName} (${column.productCode})`,
      })),
    };
  }, [matrix]);

  function onSelectPeriod(next: string) {
    if (!next || next === selectedPeriod) return;
    setFilter(emptyMonthlyClosingFilter);
    const query = new URLSearchParams({ period: next });
    startTransition(() => router.push(`${pathname}?${query.toString()}`));
  }

  // Reuses the shared scoped export route. The body is only the line/period selection — the server
  // re-derives the rows from this caller's own access, so a portal viewer only ever gets their own
  // scoped Data + Total sheets (no Matrix/Comparison, which are unscoped admin-only reads).
  async function handleExport() {
    if (!line || !selectedPeriod) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const response = await fetch("/api/sales/monthly-closing/export", {
        body: JSON.stringify({ line, period: selectedPeriod }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(payload?.error ?? payload?.message ?? "Export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-monthly-closing.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  const hasMatrix = Boolean(filteredMatrix && filteredMatrix.columns.length > 0);

  return (
    <div className="space-y-4">
      {/* Locked line + published-month picker */}
      <div className="flex flex-col gap-3 rounded border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)] sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Line</span>
            <div className="flex h-11 items-center rounded border border-slate-200 bg-slate-50 px-3.5 text-sm font-semibold text-slate-900">
              {line}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Month</span>
            {availablePeriods.length > 1 ? (
              <SearchableSelect
                className={monthSelectClassName}
                disabled={isPending}
                onChange={(event) => onSelectPeriod(event.target.value)}
                value={selectedPeriod ?? ""}
              >
                {availablePeriods.map((period) => (
                  <option key={period} value={period}>{period}</option>
                ))}
              </SearchableSelect>
            ) : (
              <div className="flex h-11 w-44 items-center rounded border border-slate-200 bg-slate-50 px-3.5 text-sm font-semibold text-slate-900">
                {selectedPeriod ?? "—"}
              </div>
            )}
          </label>
          {isPending ? <Loader2 className="mb-3 h-4 w-4 animate-spin text-slate-400" /> : null}
        </div>
        <p className="text-xs font-medium text-slate-500">
          Published closing for your line — scoped to your own areas.
        </p>
      </div>

      {/* Matrix / Details tabs — same two views as /sales/monthly-closing */}
      <div className="overflow-hidden rounded border border-slate-200 bg-white shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
        <div className="flex items-center gap-1 border-b border-slate-100 px-4 pt-3">
          {([
            { icon: <CalendarRange className="h-4 w-4" />, key: "matrix" as const, label: "Closing Matrix" },
            { icon: <Table2 className="h-4 w-4" />, key: "details" as const, label: "Details" },
          ]).map((entry) => (
            <button
              className={cn(
                "inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-bold transition",
                tab === entry.key
                  ? "border-[#F97316] text-[#0B0B0B]"
                  : "border-transparent text-slate-500 hover:text-slate-800",
              )}
              key={entry.key}
              onClick={() => setTab(entry.key)}
              type="button"
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </div>

        {tab === "matrix" ? (
          <>
            <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 md:flex-row md:items-center md:justify-between">
              <MonthlyClosingFilters
                areas={filterOptions.areas}
                onChange={setFilter}
                products={filterOptions.products}
                regions={filterOptions.regions}
                value={filter}
              />
              <button
                className="inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50"
                disabled={isExporting || !hasMatrix}
                onClick={() => void handleExport()}
                type="button"
              >
                {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export XLSX
              </button>
            </div>
            {exportError ? (
              <p className="border-b border-rose-100 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700">
                {exportError}
              </p>
            ) : null}
            {filteredMatrix && hasMatrix ? (
              <ClosingMatrixTable matrix={filteredMatrix} />
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                No closing rows match the current filters.
              </p>
            )}
          </>
        ) : (
          <ClosingDetailsPanel line={line} period={selectedPeriod} showConfidentialToggle={false} />
        )}
      </div>
    </div>
  );
}
