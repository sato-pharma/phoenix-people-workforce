"use client";

import { CalendarRange, Download, Loader2, Table2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { ClosingDetailsPanel } from "@/components/sales/closing-details-panel";
import { ClosingMatrixTable } from "@/components/sales/closing-matrix-table";
import { PortalRepClosingList } from "@/components/sales/portal-rep-closing-list";
import { formatPeriod } from "@/components/sales/target-visuals";
import {
  MonthlyClosingFilters,
  emptyMonthlyClosingFilter,
  type MonthlyClosingFilter,
} from "@/components/sales/monthly-closing-filters";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import { isSyntheticDirectArea } from "@/lib/sales/closing-direct-area";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";
import { filterMonthlyClosingMatrix } from "@/lib/sales/monthly-closing-matrix-cells";
import { phxSelectClassName } from "@/components/ui/form-tokens";

// Employee-portal render of the SAME Closing Matrix + Details view an admin sees at
// /sales/monthly-closing — but scoped to the viewer (District/Regional/National Sales Manager,
// Product/Group Product Manager, Marketing Manager, and a Medical Rep to their own area(s) only) and
// PUBLISHED-gated. The server (loadPortalMonthlyClosing) has
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
  /** The Office-only grid behind every "of which Office" column. Null = could not be read. */
  office?: MonthlyClosingMatrix | null;
  /** The line on show — resolved server-side, and one of `availableLines`. */
  line: string;
  /**
   * Every line this viewer may open that has a published month. One entry for the ordinary
   * single-line manager (the Line box stays locked); more only for someone who genuinely covers
   * several, e.g. a Product Manager carrying a line_scope_override.
   */
  availableLines: string[];
  /** Published months for the line on show (newest first). */
  availablePeriods: string[];
  selectedPeriod: string | null;
  /**
   * A Medical Rep sees a stacked, single-area view instead of the wide matrix (owner, 2026-09-23):
   * their matrix is already scoped to their own area, so the region subtotal and National Grand Total
   * the matrix table draws are just that one area restated, and the columns force a horizontal scroll.
   * Every other viewer keeps the shared ClosingMatrixTable. Presentation only — the Details tab and
   * the Export XLSX route are identical for both.
   */
  isMedicalRep?: boolean;
};

const monthSelectClassName =
  cn(phxSelectClassName, "w-44");
const lineSelectClassName =
  cn(phxSelectClassName, "w-52");

export function PortalMonthlyClosingView({ matrix, office = null, line, availableLines, availablePeriods, selectedPeriod, isMedicalRep = false }: Props) {
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

  // Same filter as the matrix — otherwise a filtered row's subtotal would be compared against an
  // unfiltered Office total. See the same note in monthly-closing-workspace.tsx.
  const filteredOffice = useMemo(
    () => (office ? filterMonthlyClosingMatrix(office, filter) : null),
    [office, filter],
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
      // Only the synthetic per-region "Direct" pseudo-area is unfilterable. `area.isDirect` is also
      // true for a real area that absorbed July 2026's direct orders, and the raw flag hid those
      // areas from the picker.
      areas: matrix.regions.flatMap((region) =>
        region.areas
          .filter((area) => !isSyntheticDirectArea(area))
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
    // Carry the line so switching months does not silently drop a multi-line viewer back onto
    // their default line.
    const query = new URLSearchParams({ line, period: next });
    startTransition(() => router.push(`${pathname}?${query.toString()}`));
  }

  // Re-runs the scoped SERVER load for the new line rather than filtering client-side: the two
  // lines have different areas, different products and different targets, so there is nothing on
  // this page to filter — the matrix has to be fetched under the viewer's scope for that line. The
  // month is deliberately NOT carried over; published months differ per line, and the loader falls
  // back to the newest published month of whichever line is now selected.
  function onSelectLine(next: string) {
    if (!next || next === line) return;
    setFilter(emptyMonthlyClosingFilter);
    const query = new URLSearchParams({ line: next });
    startTransition(() => router.push(`${pathname}?${query.toString()}`));
  }

  // Reuses the shared scoped export route. The server re-derives the rows from this caller's own
  // access, so a portal viewer only ever gets their own scoped Data + Total sheets (no
  // Matrix/Comparison, which are unscoped admin-only reads).
  //
  // The filter is sent as the codes the on-screen matrix actually kept, not as the raw filter: this
  // branch of the route has no server-side matrix to resolve the free-text search against, and the
  // details search matches client and brick names too, which would let rows from outside the
  // filtered areas back into the workbook. Codes can only narrow — the route applies them after the
  // access scope, never instead of it.
  async function handleExport() {
    if (!line || !selectedPeriod) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const hasGeographyFilter =
        filter.regionCodes.length > 0 || filter.areaCodes.length > 0 || filter.search.trim().length > 0;
      const scope = filteredMatrix
        ? {
          // Areas only. The matrix groups by the organogram, so its region codes (UE-1, UE-2) are
          // not the geographic codes the raw rows carry — sending them would filter to nothing.
          ...(hasGeographyFilter
            ? {
              areaCodes: [
                ...new Set(
                  filteredMatrix.regions.flatMap((region) =>
                    // Drop ONLY the synthetic pseudo-area, whose "DIRECT" code matches no raw row.
                    // A real area that absorbed July 2026's direct orders must stay: these codes are
                    // what the export route narrows to, so the raw `isDirect` flag silently deleted
                    // Dakahlia 1's rows from a filtered portal workbook.
                    region.areas.filter((area) => !isSyntheticDirectArea(area)).map((area) => area.areaCode),
                  ),
                ),
              ],
            }
            : {}),
          ...(filter.productCodes.length > 0
            ? { productCodes: filteredMatrix.columns.map((column) => column.productCode) }
            : {}),
        }
        : {};
      const response = await fetch("/api/sales/monthly-closing/export", {
        body: JSON.stringify({ line, period: selectedPeriod, ...scope }),
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
      {/* Line (locked, or a picker for a genuinely multi-line viewer) + published-month picker */}
      <div className="flex flex-col gap-3 rounded border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)] sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">Line</span>
            {/* Stays the read-only box for everyone who holds one line — which is almost everyone.
                It becomes a picker only when the server resolved more than one PUBLISHED line for
                this viewer, so the control cannot offer a line they may not open. */}
            {availableLines.length > 1 ? (
              <SearchableSelect
                className={lineSelectClassName}
                disabled={isPending}
                onChange={(event) => onSelectLine(event.target.value)}
                value={line}
              >
                {availableLines.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </SearchableSelect>
            ) : (
              <div className="flex h-11 items-center rounded border border-slate-200 bg-slate-50 px-3.5 text-sm font-semibold text-slate-900">
                {line}
              </div>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">Month</span>
            {availablePeriods.length > 1 ? (
              <SearchableSelect
                className={monthSelectClassName}
                disabled={isPending}
                onChange={(event) => onSelectPeriod(event.target.value)}
                value={selectedPeriod ?? ""}
              >
                {/* The month in words ("Aug 2026"); the value stays the period code the loader reads. */}
                {availablePeriods.map((period) => (
                  <option key={period} value={period}>{formatPeriod(period)}</option>
                ))}
              </SearchableSelect>
            ) : (
              <div className="flex h-11 w-44 items-center rounded border border-slate-200 bg-slate-50 px-3.5 text-sm font-semibold text-slate-900">
                {formatPeriod(selectedPeriod)}
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
                  ? "border-phx-accent text-[#0B0B0B]"
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
            <div
              className={
                isMedicalRep
                  ? "flex justify-end border-b border-slate-100 px-4 py-4"
                  : "flex flex-col gap-3 border-b border-slate-100 px-4 py-4 md:flex-row md:items-center md:justify-between"
              }
            >
              {/* A rep's view is a single area — the region/area filters would offer one option each
                  (the region being exactly what the owner does not want surfaced), so hide the whole
                  bar for them and leave Export alone on the row, at its end. Every other viewer keeps
                  the filters. */}
              {isMedicalRep ? null : (
                <MonthlyClosingFilters
                  areas={filterOptions.areas}
                  onChange={setFilter}
                  products={filterOptions.products}
                  regions={filterOptions.regions}
                  value={filter}
                />
              )}
              <button
                className="inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent disabled:opacity-50"
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
              isMedicalRep ? (
                <PortalRepClosingList matrix={filteredMatrix} />
              ) : (
                <ClosingMatrixTable matrix={filteredMatrix} office={filteredOffice} />
              )
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                No closing rows match the current filters.
              </p>
            )}
          </>
        ) : (
          <ClosingDetailsPanel line={line} period={selectedPeriod} showConfidentialToggle={false} surface="portal" />
        )}
      </div>
    </div>
  );
}
