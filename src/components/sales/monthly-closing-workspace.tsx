"use client";

import { AlertTriangle, CalendarRange, CheckCircle2, Download, EyeOff, Loader2, Lock, LockOpen, RefreshCw, Send, Table2 } from "lucide-react";
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
import { monthlyClosingFilterOptions } from "@/lib/sales/monthly-closing-filter-options";
import {
  filterMonthlyClosingMatrix,
  type MonthlyClosingMatrix,
} from "@/lib/sales/monthly-distributor-import";
import { ClosingPeriodSelect } from "@/components/sales/closing-period-select";
import { closingPeriodGateMessage, closingPeriodOpensOn, isClosingPeriodComplete } from "@/lib/sales/closing-period-gate";
import { describePeriodSelection, periodLabel } from "@/lib/sales/monthly-closing-period-merge";
import type { MonthlySourceCoverage } from "@/lib/sales/source-coverage";
import { SearchableSelect } from "@/components/ui/searchable-select";


type Props = {
  canPublish?: boolean;
  initialCoverage?: MonthlySourceCoverage | null;
  initialError: string | null;
  initialMatrix: MonthlyClosingMatrix | null;
  /** The Office-only grid behind every "of which Office" column. Null = could not be read. */
  initialOffice?: MonthlyClosingMatrix | null;
};

type ClosingResponse = {
  coverage?: MonthlySourceCoverage | null;
  data?: MonthlyClosingMatrix;
  error?: string;
  office?: MonthlyClosingMatrix | null;
  /** Months actually read. */
  periods?: string[];
  /** Requested but unreadable — named on screen rather than silently missing from the totals. */
  skipped?: string[];
  success: boolean;
};

export function MonthlyClosingWorkspace({ canPublish = false, initialCoverage = null, initialError, initialMatrix, initialOffice = null }: Props) {
  const [matrix, setMatrix] = useState<MonthlyClosingMatrix | null>(initialMatrix);
  const [office, setOffice] = useState<MonthlyClosingMatrix | null>(initialOffice);
  const [coverage, setCoverage] = useState<MonthlySourceCoverage | null>(initialCoverage);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [filter, setFilter] = useState<MonthlyClosingFilter>(emptyMonthlyClosingFilter);
  const [published, setPublished] = useState<boolean | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockedAt, setLockedAt] = useState<string | null>(null);
  const [isLocking, setIsLocking] = useState(false);
  const [tab, setTab] = useState<"matrix" | "details">("matrix");
  const [skippedPeriods, setSkippedPeriods] = useState<string[]>([]);

  const selectedLine = matrix?.line ?? "";
  const selectedPeriod = matrix?.period ?? "";
  const availableLines = matrix?.availableLines ?? [];
  const availablePeriods = matrix?.availablePeriods ?? [];

  // The months behind what is on screen. A single-month matrix has no `periods` of its own, so it
  // reads as the one month it is — the absence never means "unknown".
  const selectedPeriods = useMemo(
    () => (matrix?.periods && matrix.periods.length > 0 ? matrix.periods : matrix?.period ? [matrix.period] : []),
    [matrix],
  );
  // Publishing and locking are single-month acts by definition: a lock freezes ONE month's numbers
  // and publishing releases ONE month to the portal. Neither has a meaning over a span, so both are
  // disabled while several months are folded together rather than silently acting on the latest.
  const isMultiPeriod = selectedPeriods.length > 1;
  const periodSpan = describePeriodSelection(selectedPeriods);
  // THE CLOSING GOLDEN RULE — a month is never published during that month (owner, 2026-08-28).
  // The server refuses it regardless (publishClosing calls the same gate); this just shows the
  // reason on the button instead of letting the press come back as an error. Unpublish is never
  // blocked, so this only applies when the button would PUBLISH.
  const periodNotClosedYet = !published && !isMultiPeriod && Boolean(selectedPeriod)
    && !isClosingPeriodComplete(selectedPeriod);
  // A disabled button with only a tooltip explains nothing on a touch screen, so the reason is
  // stated on the page as well.
  const closingOpensOn = periodNotClosedYet ? closingPeriodOpensOn(selectedPeriod) : null;

  const filteredMatrix = useMemo(
    () => (matrix ? filterMonthlyClosingMatrix(matrix, filter) : null),
    [matrix, filter],
  );

  // The Office grid gets the SAME filter. Its cells are looked up by area and product code rather
  // than by position, so an unfiltered grid would still resolve each cell correctly — but its region
  // subtotals and national total would be the unfiltered ones, and "of which Office" would then
  // exceed a filtered row's own total.
  const filteredOffice = useMemo(
    () => (office ? filterMonthlyClosingMatrix(office, filter) : null),
    [office, filter],
  );

  // One plain-language sentence about completeness, or null to show nothing. Missing sources are
  // named (human names, standing rule) with their last-month scale, so "the number looks low"
  // answers itself before anyone re-checks the arithmetic.
  const coverageWarning = useMemo(() => {
    if (!coverage || !coverage.hasPrevData) return null;
    const missing = coverage.missingSources;
    const missingRegions = coverage.missingDirectRegions;
    if (missing.length === 0 && missingRegions.length === 0) return null;
    const parts: string[] = [];
    if (missing.length > 0) {
      const names = missing.slice(0, 3).map((entry) => entry.name);
      const more = missing.length - names.length;
      const scale = coverage.missingPrevValue.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      });
      parts.push(
        `${coverage.period} is missing ${missing.length} of the ${coverage.prevSourceCount} sources that fed ` +
        `${coverage.prevPeriod} — ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""} ` +
        `(${scale} EGP in ${coverage.prevPeriod}).`,
      );
    }
    if (missingRegions.length > 0) {
      parts.push(`The Direct sheet has nothing yet from ${missingRegions.map((entry) => entry.name).join(", ")}.`);
    }
    parts.push("Totals are understated until these arrive.");
    return parts.join(" ");
  }, [coverage]);

  // Built from the UNFILTERED matrix, and shared with the Performance Review so the two screens
  // offer the same regions, areas and products — see monthly-closing-filter-options.ts.
  const filterOptions = useMemo(() => monthlyClosingFilterOptions(matrix), [matrix]);

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

  useEffect(() => {
    if (!canPublish || !selectedLine || !selectedPeriod) return;
    let cancelled = false;
    void (async () => {
      try {
        const query = new URLSearchParams({ line: selectedLine, period: selectedPeriod });
        const response = await fetch(`/api/sales/monthly-closing/lock?${query.toString()}`, { cache: "no-store" });
        const payload = (await response.json()) as { locked?: boolean; lock?: { lockedAt?: string } | null };
        if (!cancelled) {
          setLocked(Boolean(payload.locked));
          setLockedAt(payload.lock?.lockedAt ?? null);
        }
      } catch {
        // Fail SAFE the same way the publish check does, and note which way "safe" points: an
        // unreadable lock state is shown as UNLOCKED, never as locked. Claiming a month is
        // protected when the check failed would be the one lie this feature cannot afford.
        if (!cancelled) {
          setLocked(null);
          setLockedAt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canPublish, selectedLine, selectedPeriod]);

  async function toggleLock() {
    if (!selectedLine || !selectedPeriod) return;
    setIsLocking(true);
    setError(null);
    try {
      const response = await fetch("/api/sales/monthly-closing/lock", {
        body: JSON.stringify({ line: selectedLine, period: selectedPeriod }),
        headers: { "Content-Type": "application/json" },
        method: locked ? "DELETE" : "POST",
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to update lock state.");
      }
      const payload = (await response.json()) as { lock?: { lockedAt?: string } | null };
      setLocked(!locked);
      setLockedAt(locked ? null : payload.lock?.lockedAt ?? new Date().toISOString());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update lock state.");
    } finally {
      setIsLocking(false);
    }
  }

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

  async function reload(line: string, periods: string[]) {
    setIsLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      if (line) query.set("line", line);
      // `period` stays the single-month parameter the route has always understood; `periods` is the
      // multi-month one. Sending exactly one month uses the old path, so nothing changes for the
      // reader who never opens the "Several months" side of the picker.
      if (periods.length === 1) query.set("period", periods[0]);
      else if (periods.length > 1) query.set("periods", periods.join(","));
      const response = await fetch(`/api/sales/monthly-closing?${query.toString()}`, { cache: "no-store" });
      const text = await response.text();
      const payload: ClosingResponse = text ? JSON.parse(text) : { success: response.ok };
      if (payload.success && payload.data) {
        setMatrix(payload.data);
        setOffice(payload.office ?? null);
        setCoverage(payload.coverage ?? null);
        setSkippedPeriods(payload.skipped ?? []);
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
        // Send the on-screen filter too. Without it the workbook was always the full national
        // matrix while the screen showed a filtered one, so "export what I am looking at" produced
        // a different set of numbers — the usual reason a report and its export disagree.
        body: JSON.stringify({
          areaCodes: filter.areaCodes,
          line: selectedLine,
          period: selectedPeriod,
          productCodes: filter.productCodes,
          regionCodes: filter.regionCodes,
          search: filter.search,
        }),
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
            <AdminInsightChip>{isMultiPeriod ? "Months" : "Month"}: {periodSpan || "No validated data"}</AdminInsightChip>
            <AdminInsightChip tone="slate">Products: {filteredMatrix?.columns.length ?? 0}</AdminInsightChip>
            {canPublish && locked ? (
              <AdminInsightChip tone="orange">Locked — numbers frozen</AdminInsightChip>
            ) : null}
            {canPublish && closingOpensOn ? (
              <AdminInsightChip tone="orange">
                {periodLabel(selectedPeriod)} is still running — closing opens {closingOpensOn}
              </AdminInsightChip>
            ) : null}
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
                onChange={(event) => void reload(event.target.value, selectedPeriods)}
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
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                {isMultiPeriod ? "Months" : "Month"}
              </span>
              <ClosingPeriodSelect
                availablePeriods={availablePeriods}
                disabled={isLoading || availablePeriods.length === 0}
                onChange={(periods) => void reload(selectedLine, periods)}
                value={selectedPeriods}
              />
            </label>
            <Button
              className="gap-2"
              disabled={isLoading}
              onClick={() => void reload(selectedLine, selectedPeriods)}
              variant="secondary"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            {canPublish ? (
              <Button
                className="gap-2"
                disabled={isLocking || isMultiPeriod || !selectedLine || !selectedPeriod}
                onClick={() => void toggleLock()}
                title={
                  isMultiPeriod
                    ? `Locking freezes ONE month. Pick a single month to lock — ${periodSpan} is several.`
                    : locked
                      ? `Locked${lockedAt ? ` ${new Date(lockedAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })}` : ""} — nothing can change this month's numbers, including imports and direct database work. Click to unlock.`
                      : "Freeze this month so nothing can change its numbers afterwards — imports, migrations and direct database work included."
                }
                variant={locked ? "default" : "secondary"}
              >
                {isLocking ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : locked ? (
                  <Lock className="h-4 w-4" />
                ) : (
                  <LockOpen className="h-4 w-4" />
                )}
                {locked ? "Locked" : "Lock month"}
              </Button>
            ) : null}
            {canPublish ? (
              <Button
                className="gap-2"
                disabled={isPublishing || isMultiPeriod || periodNotClosedYet || !selectedLine || !selectedPeriod}
                onClick={() => void togglePublish()}
                title={
                  isMultiPeriod
                    ? `Publishing releases ONE month to the portal. Pick a single month — ${periodSpan} is several.`
                    : periodNotClosedYet
                      ? closingPeriodGateMessage(selectedPeriod)
                      : undefined
                }
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
            {coverageWarning ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs font-semibold text-amber-800 md:px-5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{coverageWarning}</p>
              </div>
            ) : null}
            {/* A requested month the closing could not read is NAMED, never dropped quietly — the
                totals below would otherwise cover fewer months than the picker says they do. */}
            {skippedPeriods.length > 0 ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50/70 px-4 py-2.5 text-xs font-semibold text-amber-800 md:px-5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  {skippedPeriods.map((period) => periodLabel(period)).join(", ")}
                  {skippedPeriods.length === 1 ? " has no closing data, so it is" : " have no closing data, so they are"}
                  {" not in the figures below."}
                </p>
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
                    disabled={isExporting || isMultiPeriod || filteredMatrix.columns.length === 0}
                    onClick={() => void handleExport()}
                    title={
                      isMultiPeriod
                        ? `This workbook carries the month's own invoice rows on its Data sheet, which is built one month at a time — so it cannot yet cover ${periodSpan}. Pick a single month to export, or use the Performance Review's export, which covers the whole selection.`
                        : undefined
                    }
                    type="button"
                  >
                    {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Export XLSX
                  </button>
                </div>
                {/* Owner decision (2026-08-08): this screen must match the exported workbook, so
                    it now carries the same store split the export always applied — see
                    loadMonthlyClosingWithStoreSplit. The workbook still has its own Store Split
                    audit tab naming exactly which stores moved where. */}
                <div className="border-b border-slate-100 px-4 py-2.5 text-xs text-slate-500 md:px-5">
                  Store sales are shared across their city&apos;s areas — this matrix and the exported workbook show the same numbers.
                </div>
                <ClosingMatrixTable matrix={filteredMatrix} office={filteredOffice} />
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
