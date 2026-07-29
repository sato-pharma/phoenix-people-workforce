"use client";

import { AlertTriangle, CalendarRange, CheckCircle2, Download, EyeOff, Loader2, RefreshCw, Send, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { ClosingDetailsPanel } from "@/components/sales/closing-details-panel";
import { ClosingMatrixTable } from "@/components/sales/closing-matrix-table";
import {
  MonthlyClosingFilters,
  emptyMonthlyClosingFilter,
  type MonthlyClosingFilter,
} from "@/components/sales/monthly-closing-filters";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  filterMonthlyClosingMatrix,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { SearchableSelect } from "@/components/ui/searchable-select";


type Props = {
  canPublish?: boolean;
  initialError: string | null;
  initialMatrix: MonthlyClosingMatrix | null;
};

type ClosingResponse = {
  data?: MonthlyClosingMatrix;
  error?: string;
  success: boolean;
};

export function MonthlyClosingWorkspace({ canPublish = false, initialError, initialMatrix }: Props) {
  const [matrix, setMatrix] = useState<MonthlyClosingMatrix | null>(initialMatrix);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [filter, setFilter] = useState<MonthlyClosingFilter>(emptyMonthlyClosingFilter);
  const [published, setPublished] = useState<boolean | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [tab, setTab] = useState<"matrix" | "details">("matrix");

  const selectedLine = matrix?.line ?? "";
  const selectedPeriod = matrix?.period ?? "";
  const availableLines = matrix?.availableLines ?? [];
  const availablePeriods = matrix?.availablePeriods ?? [];

  const filteredMatrix = useMemo(
    () => (matrix ? filterMonthlyClosingMatrix(matrix, filter) : null),
    [matrix, filter],
  );

  const filterOptions = useMemo(() => {
    if (!matrix) return { areas: [], products: [], regions: [] };
    return {
      regions: matrix.regions.map((region) => ({ code: region.regionCode, label: `${region.regionName} (${region.regionCode})` })),
      // Exclude the synthetic per-region "Direct" rows — they share the code "DIRECT" across
      // regions and are not a filterable area.
      areas: matrix.regions.flatMap((region) =>
        region.areas
          .filter((area) => !area.isDirect)
          .map((area) => ({ code: area.areaCode, label: `${area.areaName} (${area.areaCode})`, regionCode: region.regionCode })),
      ),
      products: matrix.columns.map((column) => ({ code: column.productCode, label: `${column.productName} (${column.productCode})` })),
    };
  }, [matrix]);

  useEffect(() => {
    if (!canPublish || !selectedLine || !selectedPeriod) return;
    let cancelled = false;
    void (async () => {
      try {
        const query = new URLSearchParams({ line: selectedLine, period: selectedPeriod });
        const response = await fetch(`/api/sales/monthly-closing/publish?${query.toString()}`, { cache: "no-store" });
        const payload = (await response.json()) as { published?: boolean };
        if (!cancelled) setPublished(Boolean(payload.published));
      } catch {
        if (!cancelled) setPublished(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canPublish, selectedLine, selectedPeriod]);

  async function togglePublish() {
    if (!selectedLine || !selectedPeriod) return;
    setIsPublishing(true);
    setError(null);
    try {
      const method = published ? "DELETE" : "POST";
      const response = await fetch("/api/sales/monthly-closing/publish", {
        body: JSON.stringify({ line: selectedLine, period: selectedPeriod }),
        headers: { "Content-Type": "application/json" },
        method,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to update publish state.");
      }
      setPublished(!published);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update publish state.");
    } finally {
      setIsPublishing(false);
    }
  }

  async function reload(line: string, period: string) {
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (line) query.set("line", line);
      if (period) query.set("period", period);
      const response = await fetch(`/api/sales/monthly-closing?${query.toString()}`, { cache: "no-store" });
      const text = await response.text();
      const payload: ClosingResponse = text ? JSON.parse(text) : { success: response.ok };
      if (payload.success && payload.data) {
        setMatrix(payload.data);
        setFilter(emptyMonthlyClosingFilter);
      } else {
        setError(payload.error ?? "Failed to load Monthly Closing.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load Monthly Closing.");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleExport() {
    if (!selectedLine || !selectedPeriod) return;
    setIsExporting(true);
    try {
      const response = await fetch("/api/sales/monthly-closing/export", {
        body: JSON.stringify({ line: selectedLine, period: selectedPeriod }),
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
      setError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  if (initialError && !matrix) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[#F8FAFC] p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const selectClassName =
    "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10 disabled:opacity-60";

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Line: {selectedLine || "None"}</AdminInsightChip>
            <AdminInsightChip>Month: {selectedPeriod || "No validated data"}</AdminInsightChip>
            <AdminInsightChip tone="slate">Products: {filteredMatrix?.columns.length ?? 0}</AdminInsightChip>
            {canPublish && published !== null ? (
              <AdminInsightChip tone={published ? "orange" : "slate"}>
                {published ? "Published to portal" : "Not published"}
              </AdminInsightChip>
            ) : (
              <AdminInsightChip tone="orange">Sales from uploaded distributor sheets</AdminInsightChip>
            )}
          </>
        )}
        description="Sales vs target closing per area and region, rolled up to national. Publish a month to release it to the employee portal."
        eyebrow="Monthly Closing"
        icon={<CalendarRange className="h-4 w-4" />}
        title="Monthly Closing"
      />

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Line</span>
              <SearchableSelect
                className={selectClassName}
                disabled={isLoading || availableLines.length === 0}
                onChange={(event) => void reload(event.target.value, selectedPeriod)}
                value={selectedLine}
              >
                {availableLines.length === 0 ? (
                  <option value="">No products</option>
                ) : (
                  availableLines.map((line) => (
                    <option key={line} value={line}>{line}</option>
                  ))
                )}
              </SearchableSelect>
            </label>
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Month</span>
              <SearchableSelect
                className={selectClassName}
                disabled={isLoading || availablePeriods.length === 0}
                onChange={(event) => void reload(selectedLine, event.target.value)}
                value={selectedPeriod}
              >
                {availablePeriods.length === 0 ? (
                  <option value="">No validated month</option>
                ) : (
                  availablePeriods.map((period) => (
                    <option key={period} value={period}>{period}</option>
                  ))
                )}
              </SearchableSelect>
            </label>
            <Button
              className="gap-2"
              disabled={isLoading}
              onClick={() => void reload(selectedLine, selectedPeriod)}
              variant="secondary"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            {canPublish ? (
              <Button
                className="gap-2"
                disabled={isPublishing || !selectedLine || !selectedPeriod}
                onClick={() => void togglePublish()}
                variant={published ? "secondary" : "default"}
              >
                {isPublishing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : published ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {published ? "Unpublish" : "Publish to portal"}
              </Button>
            ) : null}
          </div>
        )}
        description="Areas grouped by region with region subtotals and a national grand total. Each area is counted once — region and national rows are roll-ups of the areas."
        title="Closing Matrix"
      >
        {error ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="danger">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>{error}</p>
            </AdminCallout>
          </div>
        ) : !filteredMatrix || availablePeriods.length === 0 ? (
          <div className="p-4 md:p-5">
            <AdminCallout tone="neutral">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>No validated Source of Sales data yet. Upload and validate distributor sheets first.</p>
            </AdminCallout>
          </div>
        ) : (
          <>
            {canPublish && published ? (
              <div className="flex items-center gap-2 border-b border-emerald-100 bg-emerald-50/60 px-4 py-2.5 text-xs font-semibold text-emerald-700 md:px-5">
                <CheckCircle2 className="h-4 w-4" />
                This month is published — sales managers and product managers can see it in their portal (scoped to their line / products).
              </div>
            ) : null}
            {/* Matrix = the published headline. Details = the invoice lines underneath it,
                so the arithmetic can be checked without leaving the page. */}
            <div className="flex items-center gap-1 border-b border-slate-100 px-4 pt-3 md:px-5">
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
                <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-5">
                  <MonthlyClosingFilters
                    areas={filterOptions.areas}
                    onChange={setFilter}
                    products={filterOptions.products}
                    regions={filterOptions.regions}
                    value={filter}
                  />
                  <button
                    className={cn(
                      "inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50",
                    )}
                    disabled={isExporting || filteredMatrix.columns.length === 0}
                    onClick={() => void handleExport()}
                    type="button"
                  >
                    {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Export XLSX
                  </button>
                </div>
                <ClosingMatrixTable matrix={filteredMatrix} />
              </>
            ) : (
              <ClosingDetailsPanel
                line={selectedLine}
                period={selectedPeriod}
                showConfidentialToggle
              />
            )}
          </>
        )}
      </AdminTableShell>
    </div>
  );
}
