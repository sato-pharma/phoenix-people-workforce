"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bookmark,
  ChevronDown,
  Download,
  ExternalLink,
  Filter,
  RefreshCcw,
  Save,
  SlidersHorizontal,
  Star,
  Trash2,
  Building2,
  Users2,
  TrendingUp,
  PackageSearch,
  CircleDollarSign,
  Target,
  CheckCircle2,
  AlertTriangle,
  CircleSlash,
  CalendarClock,
  Flame,
} from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { RoiMultiSelect } from "@/components/marketing-requests/roi-multi-select";
import { CoverageKpiCard } from "@/components/marketing-requests/coverage-kpi-card";
import {
  computeFacetedCoverageDimensions,
  pruneCoverageFilterState,
  withCoverageFilterValues,
} from "@/lib/marketing-requests/coverage-report-facets";
import { coverageFiltersFromSearchParams, coverageFiltersToSearchParams } from "@/lib/marketing-requests/coverage-report-url-state";
import {
  computeCoverageRollupByDimension,
  computeCoverageTrend,
  findWorstZeroSalesOutlier,
  sortRequestRows,
  type CoverageDimensionRollupRow,
  type CoverageRollupDimension,
  type RequestSortKey,
  type SortDirection,
} from "@/lib/marketing-requests/coverage-report-analytics";
import {
  emptyMarketingCoverageFilterState,
  type MarketingCoverageDistributorRollupRow,
  type MarketingCoverageFilterFacets,
  type MarketingCoverageFilterKey,
  type MarketingCoverageFilterState,
  type MarketingCoveragePharmacyRow,
  type MarketingCoveragePreset,
  type MarketingCoverageReport,
  type MarketingCoverageReportRow,
  type MarketingRoiResultStatus,
} from "@/lib/marketing-requests/roi-report-types";
import { ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import { cn } from "@/lib/utils";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}
function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}
function formatPeriod(period: string | null): string {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return "not yet available";
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
function formatExportTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

const ROLLUP_DIMENSION_LABELS: Record<CoverageRollupDimension, string> = {
  line: "Line",
  region: "Region",
  requesterTier: "Requester tier",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_validation: "Pending validation",
  pending_approval: "Pending approval",
  returned: "Returned",
  rejected: "Rejected",
  approved: "Approved",
  active: "Active",
  roi_tracking: "ROI tracking",
  closed: "Closed",
  finance_hold: "Finance hold",
};

const RESULT_BADGE_CLASS: Record<MarketingRoiResultStatus, string> = {
  on_track: "border-emerald-200 bg-emerald-50 text-emerald-700",
  behind: "border-amber-200 bg-amber-50 text-amber-700",
  awaiting_data: "border-sky-200 bg-sky-50 text-sky-700",
  no_data: "border-slate-200 bg-slate-50 text-slate-500",
};

const ROI_STATUS_OPTIONS: Array<{ value: MarketingRoiResultStatus; label: string }> = [
  { value: "on_track", label: ROI_RESULT_STATUS_LABEL.on_track },
  { value: "behind", label: ROI_RESULT_STATUS_LABEL.behind },
  { value: "awaiting_data", label: ROI_RESULT_STATUS_LABEL.awaiting_data },
  { value: "no_data", label: ROI_RESULT_STATUS_LABEL.no_data },
];

type EngineState = "ready" | "loading" | "loaded" | "error";

export function MarketingCoverageReportWorkspace({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [facets, setFacets] = React.useState<MarketingCoverageFilterFacets | null>(null);
  const [optionsError, setOptionsError] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState<MarketingCoverageFilterState>(emptyMarketingCoverageFilterState);
  const [report, setReport] = React.useState<MarketingCoverageReport | null>(null);
  const [state, setState] = React.useState<EngineState>("ready");
  const [reportError, setReportError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [presets, setPresets] = React.useState<MarketingCoveragePreset[]>([]);
  const [presetName, setPresetName] = React.useState("");
  const [savingPreset, setSavingPreset] = React.useState(false);
  const [expandedRequestId, setExpandedRequestId] = React.useState<string | null>(null);
  const [, startFilterTransition] = React.useTransition();
  const [requestSort, setRequestSort] = React.useState<{ key: RequestSortKey; direction: SortDirection }>({
    key: "requestCode",
    direction: "asc",
  });
  // Request-scoped, not filter-scoped: a request's target-pharmacy sales are fixed to its own
  // ROI window regardless of the report's active filters, so this never needs invalidating
  // when filters/report change — it just lives for the component's mount lifetime.
  const [pharmacyCache, setPharmacyCache] = React.useState<Map<string, MarketingCoveragePharmacyRow[]>>(new Map());

  function toggleRequestSort(key: RequestSortKey) {
    setRequestSort((current) => (current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }));
  }
  function requestSortArrow(key: RequestSortKey) {
    if (requestSort.key !== key) return "↕";
    return requestSort.direction === "asc" ? "↑" : "↓";
  }
  function cachePharmacies(requestId: string, pharmacies: MarketingCoveragePharmacyRow[]) {
    setPharmacyCache((prev) => {
      const next = new Map(prev);
      next.set(requestId, pharmacies);
      return next;
    });
  }

  async function fetchPresets(): Promise<MarketingCoveragePreset[]> {
    const response = await fetch("/api/marketing-requests/coverage-report/presets", { cache: "no-store" });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.presets ?? []) as MarketingCoveragePreset[];
  }

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const filterOptionsPromise = fetch("/api/marketing-requests/coverage-report/filter-options", { cache: "no-store" })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message ?? "Unable to load filters.");
            return payload as MarketingCoverageFilterFacets;
          });
        const presetsPromise = fetchPresets().catch(() => []);
        const [payload, presetList] = await Promise.all([filterOptionsPromise, presetsPromise]);
        if (cancelled) return;
        setFacets(payload);
        setPresets(presetList);

        // A shared/deep-linked URL wins over the user's own saved default view.
        const fromUrl = coverageFiltersFromSearchParams(new URLSearchParams(searchParams.toString()));
        const fallbackDefault = presetList.find((preset) => preset.isDefault);
        const initial = fromUrl ?? fallbackDefault?.filters ?? null;
        if (initial) {
          startFilterTransition(() => setFilters(initial));
          void runReport(initial);
        }
      } catch (error) {
        if (!cancelled) setOptionsError(error instanceof Error ? error.message : "Unable to load filters.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Reads searchParams only once, at mount, to hydrate a shared/deep-linked URL — must
    // NOT re-run when the URL changes later, since runReport itself writes the URL back
    // (see below), which would otherwise loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshPresets() {
    try {
      setPresets(await fetchPresets());
    } catch {
      // ignore
    }
  }

  function applyPreset(preset: MarketingCoveragePreset) {
    startFilterTransition(() => setFilters(preset.filters));
    void runReport(preset.filters);
  }

  async function savePreset(makeDefault: boolean) {
    const name = presetName.trim();
    if (!name) return;
    setSavingPreset(true);
    try {
      const response = await fetch("/api/marketing-requests/coverage-report/presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, filters, isDefault: makeDefault }),
        cache: "no-store",
      });
      if (response.ok) {
        setPresetName("");
        await refreshPresets();
      } else {
        const payload = await response.json().catch(() => ({}));
        setReportError(payload.message ?? "Could not save the preset.");
      }
    } finally {
      setSavingPreset(false);
    }
  }

  async function deletePreset(id: string) {
    try {
      const response = await fetch(`/api/marketing-requests/coverage-report/presets?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (response.ok) await refreshPresets();
    } catch {
      // ignore
    }
  }

  async function runReport(next: MarketingCoverageFilterState) {
    setState("loading");
    setReportError(null);
    try {
      const response = await fetch("/api/marketing-requests/coverage-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filters: next }),
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) {
        setReport(null);
        setReportError(payload.message ?? "Unable to load the report.");
        setState("error");
        return;
      }
      setReport(payload as MarketingCoverageReport);
      setState("loaded");
      setExpandedRequestId(null);
      // Mirror the applied filters into the URL so the view is shareable — replace (not
      // push) so repeatedly adjusting filters doesn't spam browser history.
      const params = coverageFiltersToSearchParams(next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    } catch {
      setReport(null);
      setReportError("Unable to load the report.");
      setState("error");
    }
  }

  const faceted = React.useMemo(
    () => (facets ? computeFacetedCoverageDimensions(facets.entries, filters, facets.canRevealRestricted) : null),
    [facets, filters],
  );

  function setArray(key: MarketingCoverageFilterKey, values: string[]) {
    startFilterTransition(() => {
      setFilters((prev) => {
        const next = withCoverageFilterValues(prev, key, values);
        return facets ? pruneCoverageFilterState(facets.entries, next, key) : next;
      });
    });
  }

  function patchFilters(patch: Partial<MarketingCoverageFilterState>) {
    startFilterTransition(() => {
      setFilters((prev) => {
        const next = { ...prev, ...patch } as MarketingCoverageFilterState;
        return facets ? pruneCoverageFilterState(facets.entries, next) : next;
      });
    });
  }

  /** Sets one dimension to a single value and immediately re-runs the report — the same
   *  "click to filter" pathway the breakdown panel and clickable KPI cards both use. Mirrors
   *  applyPreset's pattern (compute next from current filters, set state, run report with
   *  that same next value) rather than setArray's functional updater, since we need the
   *  computed next value to pass into runReport. */
  function applyDimensionFilterAndRun(key: MarketingCoverageFilterKey, values: string[]) {
    const withValues = withCoverageFilterValues(filters, key, values);
    const next = facets ? pruneCoverageFilterState(facets.entries, withValues, key) : withValues;
    startFilterTransition(() => setFilters(next));
    void runReport(next);
  }

  /** Toggles the roiStatus filter to exactly one status (or clears it if already active).
   *  roiStatus isn't part of the faceted/cascading dimension system in this component (its
   *  own multiselect above reads/writes it directly), so this mirrors that direct pattern. */
  function toggleRoiStatusKpiFilter(status: MarketingRoiResultStatus) {
    const isActive = filters.roiStatus.length === 1 && filters.roiStatus[0] === status;
    const next: MarketingCoverageFilterState = { ...filters, roiStatus: isActive ? [] : [status] };
    startFilterTransition(() => setFilters(next));
    void runReport(next);
  }

  function renderableDimensions() {
    return (faceted?.dimensions ?? []).filter((dim) => dim.render && dim.type === "multiselect");
  }
  function autoAppliedDimensions() {
    return (faceted?.dimensions ?? []).filter((dim) => !dim.render && dim.autoApplied && dim.autoApplied.length > 0);
  }
  function dimensionByKey(key: MarketingCoverageFilterKey) {
    return faceted?.dimensions.find((dim) => dim.key === key);
  }
  function selectedFor(key: MarketingCoverageFilterKey): string[] {
    if (key === "requestType") return filters.requestType.map(String);
    const value = (filters as Record<string, unknown>)[key];
    return Array.isArray(value) ? (value as string[]) : [];
  }

  const durationDim = dimensionByKey("duration");
  const payDateDim = dimensionByKey("payDate");
  const restrictedDim = dimensionByKey("includeRestricted");
  const hasReport = state === "loaded" && report;
  const hasAnyFilter = Object.values(filters).some((value) => (Array.isArray(value) ? value.length > 0 : value !== null && value !== false));

  async function downloadExport() {
    setExporting(true);
    try {
      const response = await fetch("/api/marketing-requests/coverage-report/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filters }),
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setReportError(payload.message ?? "Export failed.");
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="(.+?)"/);
      const filename = match ? match[1] : "phoenix-marketing-coverage-report.xlsx";
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      setReportError("Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const kpi = report?.kpi ?? null;

  const [breakdownDimension, setBreakdownDimension] = React.useState<CoverageRollupDimension | "distributor">("line");
  const outlier = React.useMemo(() => (report ? findWorstZeroSalesOutlier(report.rows) : null), [report]);
  const dimensionRollup = React.useMemo(
    () =>
      report && breakdownDimension !== "distributor"
        ? computeCoverageRollupByDimension(report.rows, breakdownDimension)
        : [],
    [report, breakdownDimension],
  );
  const trend = React.useMemo(() => (report ? computeCoverageTrend(report.rows) : []), [report]);
  const sortedRows = React.useMemo(
    () => (report ? sortRequestRows(report.rows, requestSort.key, requestSort.direction) : []),
    [report, requestSort],
  );

  return (
    <WorkspaceErrorBoundary fallbackTitle="Marketing Coverage Report error">
      <div className="space-y-5" dir="auto">
        {/* ── Filters ───────────────────────────────────────────────────────── */}
        <section className="rounded-none border border-[#E2E8F0] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-[#F97316]" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#F97316]">Coverage Report</p>
                <h2 className="text-[15px] font-black tracking-tight text-[#0F172A]">Filter by hierarchy, geography or person</h2>
              </div>
            </div>
            {faceted ? (
              <span className="inline-flex items-center gap-1.5 rounded-none border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#64748B]">
                <Filter className="h-3 w-3" />
                {faceted.matchedCount === faceted.totalCount
                  ? `${faceted.totalCount} request${faceted.totalCount === 1 ? "" : "s"} in scope`
                  : `${faceted.matchedCount} of ${faceted.totalCount} match`}
              </span>
            ) : null}
          </div>

          <div className="p-4 sm:p-5">
            {optionsError ? (
              <div className="rounded-none border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{optionsError}</div>
            ) : !facets ? (
              <div className="flex items-center gap-2 py-6 text-[13px] font-semibold text-[#64748B]">
                <LoadingSpinner /> Loading filters…
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {renderableDimensions().map((dim) => (
                    <RoiMultiSelect
                      key={dim.key}
                      label={dim.label}
                      options={dim.options.map((option) => ({
                        value: option.value,
                        label: dim.key === "status" ? STATUS_LABELS[option.value] ?? option.label : option.label,
                        count: option.count,
                      }))}
                      selected={selectedFor(dim.key)}
                      onChange={(values) => setArray(dim.key, values)}
                    />
                  ))}

                  <RoiMultiSelect
                    label="ROI status"
                    options={ROI_STATUS_OPTIONS}
                    selected={filters.roiStatus}
                    onChange={(values) => startFilterTransition(() => setFilters((prev) => ({ ...prev, roiStatus: values as MarketingRoiResultStatus[] })))}
                  />

                  {durationDim?.render ? (
                    <div className="rounded-none border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">ROI duration (months)</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={durationDim.min}
                          max={durationDim.max}
                          placeholder={String(durationDim.min ?? "")}
                          value={filters.durationMin ?? ""}
                          onChange={(event) => patchFilters({ durationMin: event.target.value === "" ? null : Number(event.target.value) })}
                          className="h-8 w-full rounded-none border border-[#E2E8F0] px-2 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                        <span className="text-[#94A3B8]">–</span>
                        <input
                          type="number"
                          min={durationDim.min}
                          max={durationDim.max}
                          placeholder={String(durationDim.max ?? "")}
                          value={filters.durationMax ?? ""}
                          onChange={(event) => patchFilters({ durationMax: event.target.value === "" ? null : Number(event.target.value) })}
                          className="h-8 w-full rounded-none border border-[#E2E8F0] px-2 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                      </div>
                    </div>
                  ) : null}

                  {payDateDim?.render ? (
                    <div className="rounded-none border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">Pay date</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="date"
                          value={filters.payDateFrom ?? ""}
                          onChange={(event) => patchFilters({ payDateFrom: event.target.value || null })}
                          className="h-8 w-full rounded-none border border-[#E2E8F0] px-2 text-[12px] font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                        <span className="text-[#94A3B8]">–</span>
                        <input
                          type="date"
                          value={filters.payDateTo ?? ""}
                          onChange={(event) => patchFilters({ payDateTo: event.target.value || null })}
                          className="h-8 w-full rounded-none border border-[#E2E8F0] px-2 text-[12px] font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>

                {(() => {
                  type ActiveChip = { key: string; label: string; onClear: () => void };
                  const chips: ActiveChip[] = [];

                  for (const dim of renderableDimensions()) {
                    for (const value of selectedFor(dim.key)) {
                      const optionLabel = dim.options.find((option) => option.value === value)?.label ?? value;
                      chips.push({
                        key: `${dim.key}:${value}`,
                        label: `${dim.label}: ${optionLabel}`,
                        onClear: () => applyDimensionFilterAndRun(dim.key, selectedFor(dim.key).filter((v) => v !== value)),
                      });
                    }
                  }
                  for (const status of filters.roiStatus) {
                    chips.push({
                      key: `roiStatus:${status}`,
                      label: `ROI status: ${ROI_STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status}`,
                      onClear: () => {
                        const next = { ...filters, roiStatus: filters.roiStatus.filter((s) => s !== status) };
                        startFilterTransition(() => setFilters(next));
                        void runReport(next);
                      },
                    });
                  }
                  if (filters.durationMin !== null || filters.durationMax !== null) {
                    chips.push({
                      key: "duration",
                      label: `Duration: ${filters.durationMin ?? "…"}–${filters.durationMax ?? "…"}`,
                      onClear: () => {
                        const next = { ...filters, durationMin: null, durationMax: null };
                        startFilterTransition(() => setFilters(next));
                        void runReport(next);
                      },
                    });
                  }
                  if (filters.payDateFrom || filters.payDateTo) {
                    chips.push({
                      key: "payDate",
                      label: `Pay date: ${filters.payDateFrom ?? "…"}–${filters.payDateTo ?? "…"}`,
                      onClear: () => {
                        const next = { ...filters, payDateFrom: null, payDateTo: null };
                        startFilterTransition(() => setFilters(next));
                        void runReport(next);
                      },
                    });
                  }
                  if (filters.includeRestricted) {
                    chips.push({
                      key: "includeRestricted",
                      label: "Include confidential products",
                      onClear: () => {
                        const next = { ...filters, includeRestricted: false };
                        startFilterTransition(() => setFilters(next));
                        void runReport(next);
                      },
                    });
                  }

                  if (chips.length === 0) return null;
                  return (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-[#94A3B8]">Active filters:</span>
                      {chips.map((chip) => (
                        <button
                          key={chip.key}
                          type="button"
                          onClick={chip.onClear}
                          className="inline-flex items-center gap-1.5 rounded-none border border-[#FDBA74] bg-orange-50 px-2 py-1 text-[11px] font-bold text-[#9A3412] transition hover:border-[#F97316] hover:bg-orange-100"
                        >
                          {chip.label}
                          <span aria-hidden="true" className="text-[#C2410C]">×</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}

                {(() => {
                  const autoChips = autoAppliedDimensions()
                    .map((dim) => ({ dim, label: dim.options.find((option) => option.value === dim.autoApplied?.[0])?.label ?? null }))
                    .filter((chip) => chip.label !== null);
                  if (autoChips.length === 0) return null;
                  return (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-[#94A3B8]">Auto-applied:</span>
                      {autoChips.map(({ dim, label }) => (
                        <span key={dim.key} className="inline-flex items-center gap-1 rounded-none border border-[#E2E8F0] bg-[#F8FAFC] px-2 py-1 text-[11px] font-bold text-[#475569]">
                          {dim.label}: {label}
                        </span>
                      ))}
                    </div>
                  );
                })()}

                {restrictedDim?.render ? (
                  <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-none border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] font-bold text-amber-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#F97316]"
                      checked={filters.includeRestricted}
                      onChange={(event) => startFilterTransition(() => setFilters((prev) => ({ ...prev, includeRestricted: event.target.checked })))}
                    />
                    Include confidential products (LA003 / LA004 / SS001)
                  </label>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runReport(filters)}
                    disabled={state === "loading" || !hasAnyFilter}
                    className="inline-flex items-center gap-2 rounded-none bg-[#F97316] px-4 py-2 text-[13px] font-black uppercase tracking-wide text-white shadow-sm transition hover:bg-[#EA580C] disabled:opacity-60"
                  >
                    {state === "loading" ? <LoadingSpinner /> : <Filter className="h-3.5 w-3.5" />}
                    Apply Filters
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      startFilterTransition(() => setFilters(emptyMarketingCoverageFilterState()));
                      setReport(null);
                      setState("ready");
                    }}
                    className="inline-flex items-center gap-2 rounded-none border border-[#E2E8F0] bg-white px-3 py-2 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316]"
                  >
                    <RefreshCcw className="h-3.5 w-3.5" /> Reset
                  </button>
                  {!hasAnyFilter ? (
                    <span className="text-[12px] font-medium text-[#94A3B8]">Choose at least one filter to run the report.</span>
                  ) : null}
                  {hasReport ? (
                    <button
                      type="button"
                      onClick={() => void downloadExport()}
                      disabled={exporting}
                      className="inline-flex items-center gap-2 rounded-none border border-[#0F172A] bg-[#0F172A] px-3 py-2 text-[12px] font-black uppercase tracking-wide text-white transition hover:bg-black disabled:opacity-60"
                    >
                      {exporting ? <LoadingSpinner /> : <Download className="h-3.5 w-3.5" />} Export XLSX
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#F1F5F9] pt-3">
                  <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">
                    <Bookmark className="h-3.5 w-3.5" /> Presets
                  </span>
                  {presets.map((preset) => (
                    <span key={preset.id} className="inline-flex items-center gap-1 rounded-none border border-[#E2E8F0] bg-white pl-2 text-[12px] font-bold text-[#475569]">
                      {preset.isDefault ? <Star className="h-3 w-3 fill-[#F97316] text-[#F97316]" /> : null}
                      <button type="button" onClick={() => applyPreset(preset)} className="py-1 transition hover:text-[#F97316]">{preset.name}</button>
                      <button type="button" aria-label={`Delete ${preset.name}`} onClick={() => void deletePreset(preset.id)} className="px-1.5 py-1 text-[#CBD5E1] transition hover:text-red-500">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {presets.length === 0 ? <span className="text-[11px] font-medium text-[#94A3B8]">No saved views yet.</span> : null}
                  <span className="ml-auto flex items-center gap-1.5">
                    <input
                      type="text"
                      value={presetName}
                      onChange={(event) => setPresetName(event.target.value)}
                      placeholder="Name this view…"
                      className="h-8 w-40 rounded-none border border-[#E2E8F0] px-2 text-[12px] font-medium text-[#0F172A] outline-none focus:border-[#FDBA74]"
                    />
                    <button
                      type="button"
                      onClick={() => void savePreset(false)}
                      disabled={savingPreset || !presetName.trim()}
                      className="inline-flex h-8 items-center gap-1 rounded-none border border-[#E2E8F0] bg-white px-2 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-40"
                    >
                      <Save className="h-3.5 w-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={() => void savePreset(true)}
                      disabled={savingPreset || !presetName.trim()}
                      title="Save as my default view"
                      className="inline-flex h-8 items-center gap-1 rounded-none border border-[#E2E8F0] bg-white px-2 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-40"
                    >
                      <Star className="h-3.5 w-3.5" /> Default
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        </section>

        {reportError ? (
          <div className="rounded-none border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-800">{reportError}</div>
        ) : null}

        {/* ── Freshness banner ─────────────────────────────────────────────── */}
        {kpi ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] font-semibold text-[#64748B]">
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-[#94A3B8]" />
              Sales data current through {formatPeriod(kpi.salesDataAsOf)}
            </span>
            {facets?.lastExport ? (
              <span className="flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5 text-[#94A3B8]" />
                Last exported by {facets.lastExport.exportedByName} on {formatExportTimestamp(facets.lastExport.exportedAt)}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* ── Degraded-actuals banner ──────────────────────────────────────── */}
        {/* Only ever shown when at least one visible request had no marketing_roi_request_facts
            row yet (e.g. never refreshed since creation) and had to fall back to the slower
            live-RPC path — honest-zero convention: absent entirely otherwise, never a fabricated
            "everything's fine" line and never silent about a real degradation. */}
        {kpi && kpi.actualsDegraded.count > 0 ? (
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-none border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              {kpi.actualsDegraded.count} request{kpi.actualsDegraded.count === 1 ? "" : "s"} used a slower
              recalculation path — actuals may lag by a few minutes.
            </span>
          </div>
        ) : null}

        {/* ── Worst zero-sales outlier ─────────────────────────────────────── */}
        {outlier ? (
          <button
            type="button"
            onClick={() => setExpandedRequestId(outlier.requestId)}
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-none border border-amber-300 bg-amber-50 px-4 py-2.5 text-left text-[13px] font-semibold text-amber-900 transition hover:border-amber-400 hover:bg-amber-100"
          >
            <Flame className="h-4 w-4 shrink-0 text-amber-600" />
            <span className="font-black uppercase tracking-wide text-amber-700">Highest spend, zero attributed sales:</span>
            <span className="font-bold">{outlier.requestCode}</span>
            <span className="text-amber-700">{outlier.requesterName ?? outlier.requesterHrId}</span>
            <span className="ml-auto font-black tabular-nums">{money(outlier.estimatedCost)} EGP</span>
          </button>
        ) : null}

        {/* ── Premium KPI band ─────────────────────────────────────────────── */}
        {/* Sticky just below the topbar (sticky top-0 z-20, ~72–88px tall incl. padding —
            src/components/layout/topbar.tsx:58) so context never scrolls away; z-10 keeps
            it under the topbar, and the opaque background stops table rows showing through. */}
        {kpi ? (
          <section className="sticky top-[68px] z-10 grid grid-cols-1 gap-3 bg-[#F8FAFC] py-2 sm:top-20 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <CoverageKpiCard tone="slate" icon={<PackageSearch className="h-5 w-5" />} label="Requests" value={kpi.requestCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="orange" icon={<CircleDollarSign className="h-5 w-5" />} label="Total cost (EGP)" value={money(kpi.totalEstimatedCost)} />
            <CoverageKpiCard tone="orange" icon={<Target className="h-5 w-5" />} label="Required ROI (EGP)" value={money(kpi.totalRequiredRoi)} />
            <CoverageKpiCard tone="emerald" icon={<TrendingUp className="h-5 w-5" />} label="Actual sales (EGP)" value={money(kpi.totalActualValue)} />
            <CoverageKpiCard tone="blue" icon={<Filter className="h-5 w-5" />} label="Coverage" value={percent(kpi.coverageRatio)} />
            <CoverageKpiCard
              tone="emerald"
              icon={<CheckCircle2 className="h-5 w-5" />}
              label="On track"
              value={kpi.onTrackCount.toLocaleString("en-US")}
              onClick={() => toggleRoiStatusKpiFilter("on_track")}
              active={filters.roiStatus.length === 1 && filters.roiStatus[0] === "on_track"}
            />
            <CoverageKpiCard
              tone="amber"
              icon={<AlertTriangle className="h-5 w-5" />}
              label="Behind"
              value={kpi.behindCount.toLocaleString("en-US")}
              onClick={() => toggleRoiStatusKpiFilter("behind")}
              active={filters.roiStatus.length === 1 && filters.roiStatus[0] === "behind"}
            />
            <CoverageKpiCard
              tone="slate"
              icon={<CircleSlash className="h-5 w-5" />}
              label="No data"
              value={kpi.noDataCount.toLocaleString("en-US")}
              onClick={() => toggleRoiStatusKpiFilter("no_data")}
              active={filters.roiStatus.length === 1 && filters.roiStatus[0] === "no_data"}
            />
            <CoverageKpiCard tone="violet" icon={<Building2 className="h-5 w-5" />} label="Distinct pharmacies" value={kpi.distinctPharmacyCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="violet" icon={<Users2 className="h-5 w-5" />} label="Distinct customers" value={kpi.distinctCustomerCount.toLocaleString("en-US")} />
          </section>
        ) : null}

        {/* ── Coverage breakdown + trend ───────────────────────────────────── */}
        {report ? (
          <CoverageBreakdownPanel
            dimension={breakdownDimension}
            onDimensionChange={setBreakdownDimension}
            dimensionRollup={dimensionRollup}
            distributorRollup={report.distributorRollup}
            trend={trend}
            onFilterDimension={applyDimensionFilterAndRun}
          />
        ) : null}

        {/* ── Collapsible request list ─────────────────────────────────────── */}
        {report ? (
          <section className="overflow-hidden rounded-none border border-[#E2E8F0] bg-white shadow-sm">
            {report.rows.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] font-semibold text-[#64748B]">No requests match the applied filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[#E2E8F0] bg-slate-900 text-left text-[11px] font-black uppercase tracking-wide text-white">
                      <th className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleRequestSort("requestCode")} className="inline-flex items-center gap-1 font-black">Request {requestSortArrow("requestCode")}</button>
                      </th>
                      <th className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleRequestSort("requesterName")} className="inline-flex items-center gap-1 font-black">Requester {requestSortArrow("requesterName")}</button>
                      </th>
                      <th className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleRequestSort("line")} className="inline-flex items-center gap-1 font-black">Line / Region / Area {requestSortArrow("line")}</button>
                      </th>
                      <th className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleRequestSort("customerName")} className="inline-flex items-center gap-1 font-black">Customer {requestSortArrow("customerName")}</button>
                      </th>
                      <th className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleRequestSort("status")} className="inline-flex items-center gap-1 font-black">Status {requestSortArrow("status")}</button>
                      </th>
                      <th className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleRequestSort("payDate")} className="inline-flex items-center gap-1 font-black">Pay date {requestSortArrow("payDate")}</button>
                      </th>
                      <th className="px-3 py-2.5 text-right">
                        <button type="button" onClick={() => toggleRequestSort("estimatedCost")} className="inline-flex items-center gap-1 font-black">Cost {requestSortArrow("estimatedCost")}</button>
                      </th>
                      <th className="px-3 py-2.5 text-right">
                        <button type="button" onClick={() => toggleRequestSort("requiredRoiValue")} className="inline-flex items-center gap-1 font-black">Required {requestSortArrow("requiredRoiValue")}</button>
                      </th>
                      <th className="px-3 py-2.5 text-right">
                        <button type="button" onClick={() => toggleRequestSort("actualSalesValue")} className="inline-flex items-center gap-1 font-black">Actual {requestSortArrow("actualSalesValue")}</button>
                      </th>
                      <th className="px-3 py-2.5 text-right">
                        <button type="button" onClick={() => toggleRequestSort("actualCoverageRatio")} className="inline-flex items-center gap-1 font-black">Coverage {requestSortArrow("actualCoverageRatio")}</button>
                      </th>
                      <th className="px-3 py-2.5">
                        <button type="button" onClick={() => toggleRequestSort("resultStatus")} className="inline-flex items-center gap-1 font-black">Result {requestSortArrow("resultStatus")}</button>
                      </th>
                      <th className="px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => (
                      <RequestAccordionRow
                        key={row.requestId}
                        row={row}
                        expanded={expandedRequestId === row.requestId}
                        onToggle={() => setExpandedRequestId((current) => (current === row.requestId ? null : row.requestId))}
                        isSuperAdmin={isSuperAdmin}
                        cachedPharmacies={pharmacyCache.get(row.requestId) ?? null}
                        onPharmaciesLoaded={(pharmacies) => cachePharmacies(row.requestId, pharmacies)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </WorkspaceErrorBoundary>
  );
}

const BREAKDOWN_TABS: Array<{ key: CoverageRollupDimension | "distributor"; label: string }> = [
  { key: "line", label: "Line" },
  { key: "region", label: "Region" },
  { key: "requesterTier", label: "Requester tier" },
  { key: "distributor", label: "Distributor" },
];

/**
 * "Where is coverage failing" panel — a segmented control switching between Line/Region/
 * Requester-Tier (client-computed, real coverage %, worst-first) and Distributor
 * (server-computed weighted cost/required-ROI split — no coverage % column, since a real
 * per-distributor sales split isn't available at this grain yet; see
 * MarketingCoverageDistributorRollupRow's type comment). Clicking any row applies that
 * dimension's filter and re-runs the report. A month-by-month trend of the currently
 * filtered rows sits below.
 */
function CoverageBreakdownPanel({
  dimension,
  onDimensionChange,
  dimensionRollup,
  distributorRollup,
  trend,
  onFilterDimension,
}: {
  dimension: CoverageRollupDimension | "distributor";
  onDimensionChange: (dimension: CoverageRollupDimension | "distributor") => void;
  dimensionRollup: CoverageDimensionRollupRow[];
  distributorRollup: MarketingCoverageDistributorRollupRow[];
  trend: ReturnType<typeof computeCoverageTrend>;
  onFilterDimension: (key: MarketingCoverageFilterKey, values: string[]) => void;
}) {
  return (
    <section className="overflow-hidden rounded-none border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-3 sm:px-5">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#F97316]">Coverage breakdown</p>
          <h3 className="text-[14px] font-black tracking-tight text-[#0F172A]">Where is coverage failing?</h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {BREAKDOWN_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => onDimensionChange(tab.key)}
              className={cn(
                "rounded-none border px-3 py-1.5 text-[12px] font-bold uppercase tracking-wide transition",
                dimension === tab.key
                  ? "border-[#F97316] bg-[#F97316] text-white"
                  : "border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#FDBA74] hover:text-[#F97316]",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        {dimension === "distributor" ? (
          distributorRollup.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] font-semibold text-[#64748B]">No distributor data for the current filter.</p>
          ) : (
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-slate-900 text-left text-[11px] font-black uppercase tracking-wide text-white">
                  <th className="px-3 py-2.5">Distributor</th>
                  <th className="px-3 py-2.5 text-right">Requests</th>
                  <th className="px-3 py-2.5 text-right">Allocated cost</th>
                  <th className="px-3 py-2.5 text-right">Allocated required ROI</th>
                </tr>
              </thead>
              <tbody>
                {distributorRollup.map((row) => (
                  <tr
                    key={row.distributorCode}
                    role="button"
                    tabIndex={0}
                    onClick={() => onFilterDimension("distributor", [row.distributorCode])}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") onFilterDimension("distributor", [row.distributorCode]);
                    }}
                    className="cursor-pointer border-b border-[#F1F5F9] transition hover:bg-orange-50/40"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-bold text-slate-900">
                      {row.distributorName ?? row.distributorCode}
                      <span className="ml-1.5 text-[11px] font-semibold text-slate-400">({row.distributorCode})</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700">{row.requestCount.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700">{money(row.allocatedCost)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700">{money(row.allocatedRequiredRoi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : dimensionRollup.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] font-semibold text-[#64748B]">No data for the current filter.</p>
        ) : (
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[#E2E8F0] bg-slate-900 text-left text-[11px] font-black uppercase tracking-wide text-white">
                <th className="px-3 py-2.5">{ROLLUP_DIMENSION_LABELS[dimension]}</th>
                <th className="px-3 py-2.5 text-right">Requests</th>
                <th className="px-3 py-2.5 text-right">Cost</th>
                <th className="px-3 py-2.5 text-right">Actual</th>
                <th className="px-3 py-2.5 text-right">Coverage</th>
                <th className="px-3 py-2.5 text-right">Behind</th>
                <th className="px-3 py-2.5 text-right">No data</th>
              </tr>
            </thead>
            <tbody>
              {dimensionRollup.map((row) => {
                // "Unassigned" is a display fallback for a null/blank dimension value on
                // the row, not a real filterable value — filtering by it would silently
                // produce a wrong/empty result, so those rows render inert (no click).
                const filterable = row.key !== "Unassigned";
                return (
                  <tr
                    key={row.key}
                    role={filterable ? "button" : undefined}
                    tabIndex={filterable ? 0 : undefined}
                    onClick={filterable ? () => onFilterDimension(dimension, [row.key]) : undefined}
                    onKeyDown={
                      filterable
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ") onFilterDimension(dimension, [row.key]);
                          }
                        : undefined
                    }
                    className={cn(
                      "border-b border-[#F1F5F9] transition",
                      filterable ? "cursor-pointer hover:bg-orange-50/40" : "opacity-70",
                    )}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-bold text-slate-900">{row.label}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700">{row.requestCount.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700">{money(row.totalCost)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums font-semibold text-slate-900">{money(row.totalActualValue)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-700">{percent(row.coverageRatio)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-amber-700">{row.behindCount.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-500">{row.noDataCount.toLocaleString("en-US")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {trend.length > 0 ? (
        <div className="border-t border-[#F1F5F9] px-4 py-3 sm:px-5">
          <p className="mb-2 text-[11px] font-black uppercase tracking-wide text-[#94A3B8]">Trend by pay month</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-[11px] font-black uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-1.5">Month</th>
                  <th className="px-3 py-1.5 text-right">Requests</th>
                  <th className="px-3 py-1.5 text-right">Cost</th>
                  <th className="px-3 py-1.5 text-right">Actual</th>
                  <th className="px-3 py-1.5 text-right">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((point) => (
                  <tr key={point.month} className="border-t border-[#F1F5F9]">
                    <td className="whitespace-nowrap px-3 py-1.5 font-bold text-slate-900">{point.month}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{point.requestCount.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{money(point.totalCost)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums font-semibold text-slate-900">{money(point.totalActualValue)}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-slate-700">{percent(point.coverageRatio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RequestAccordionRow({
  row,
  expanded,
  onToggle,
  isSuperAdmin,
  cachedPharmacies,
  onPharmaciesLoaded,
}: {
  row: MarketingCoverageReportRow;
  expanded: boolean;
  onToggle: () => void;
  isSuperAdmin: boolean;
  /** Parent-level cache lookup — a request's target-pharmacy sales don't change on
   *  re-expand, so a cache hit skips the network fetch entirely. */
  cachedPharmacies: MarketingCoveragePharmacyRow[] | null;
  onPharmaciesLoaded: (pharmacies: MarketingCoveragePharmacyRow[]) => void;
}) {
  const [pharmacies, setPharmacies] = React.useState<MarketingCoveragePharmacyRow[] | null>(cachedPharmacies);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // A cache hit is already reflected via the useState(cachedPharmacies) initializer above,
    // so `pharmacies !== null` here covers both "already fetched locally" and "seeded from
    // the parent cache" — no separate synchronous setState-from-effect branch needed.
    if (!expanded || pharmacies !== null || loading) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/marketing-requests/coverage-report/${encodeURIComponent(row.requestId)}/pharmacies`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message ?? "Unable to load target pharmacies.");
        const loaded = (payload.pharmacies ?? []) as MarketingCoveragePharmacyRow[];
        if (!cancelled) {
          setPharmacies(loaded);
          onPharmaciesLoaded(loaded);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load target pharmacies.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const locationLabel = [row.line, row.region, row.areaName].filter(Boolean).join(" / ") || "—";

  return (
    <>
      <tr
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onToggle();
        }}
        className="cursor-pointer border-b border-[rgba(249,115,22,0.22)] align-middle transition hover:bg-orange-50/40"
      >
        <td className="whitespace-nowrap px-3 py-2.5 font-bold text-slate-900">{row.requestCode}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
          {row.requesterName ?? row.requesterHrId}
          {row.requesterTier ? <span className="ml-1.5 text-[11px] font-semibold text-slate-400">({row.requesterTier})</span> : null}
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{locationLabel}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">{row.customerName}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{STATUS_LABELS[row.status] ?? row.status}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{row.payDate ?? "—"}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-700">{money(row.estimatedCost)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-700">{money(row.requiredRoiValue)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{money(row.actualSalesValue)}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-slate-700">{percent(row.actualCoverageRatio)}</td>
        <td className="whitespace-nowrap px-3 py-2.5">
          <span className={cn("inline-flex rounded-none border px-2 py-0.5 text-[11px] font-bold", RESULT_BADGE_CLASS[row.resultStatus])}>
            {ROI_RESULT_STATUS_LABEL[row.resultStatus]}
          </span>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right">
          <ChevronDown className={cn("h-4 w-4 text-slate-400 transition", expanded ? "rotate-180" : "")} />
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-[rgba(249,115,22,0.22)] bg-slate-50">
          <td colSpan={12} className="px-3 py-3">
            {loading ? (
              <div className="flex items-center gap-2 py-3 text-[13px] font-semibold text-slate-500">
                <LoadingSpinner /> Loading target pharmacies…
              </div>
            ) : error ? (
              <div className="rounded-none border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] font-semibold text-rose-700">{error}</div>
            ) : !pharmacies || pharmacies.length === 0 ? (
              <p className="py-2 text-[13px] font-semibold text-slate-500">This request has no target pharmacy codes.</p>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">
                  {pharmacies.length} target pharmac{pharmacies.length === 1 ? "y" : "ies"} — sales shown even at zero
                </p>
                {pharmacies.map((pharmacy) => (
                  <div
                    key={pharmacy.pharmacyCode}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-none border border-slate-200 bg-white px-3 py-2"
                  >
                    <span className="whitespace-nowrap text-sm font-semibold text-slate-900">{pharmacy.pharmacyName}</span>
                    <span className="whitespace-nowrap text-xs font-medium text-slate-500">({pharmacy.pharmacyCode})</span>
                    <span className="text-slate-300">·</span>
                    <span className="whitespace-nowrap text-sm text-slate-700">{pharmacy.distributorName ?? "Unknown distributor"}</span>
                    <span className="ml-auto flex items-center gap-2">
                      <span className={cn("whitespace-nowrap text-sm font-bold tabular-nums", pharmacy.hasSalesRows ? "text-emerald-700" : "text-slate-400")}>
                        {money(pharmacy.salesValue)} EGP
                      </span>
                      {isSuperAdmin && pharmacy.parentDistributorCode ? (
                        <a
                          href={`/sales/customer-directory/${encodeURIComponent(pharmacy.parentDistributorCode)}/${encodeURIComponent(pharmacy.pharmacyCode)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded-none border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-700 transition hover:border-[#F97316] hover:text-[#F97316]"
                        >
                          <ExternalLink className="h-3 w-3" /> Full sales history
                        </a>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
