"use client";

import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
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
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { cairoDateTime, utcDate } from "@/lib/format/cairo-datetime";
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
import { MARKETING_REQUEST_STATUS_LABEL, ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminPanelHeaderClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}
function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}
// DATE-ONLY (a "YYYY-MM" period key off a synthetic `Date.UTC`), which `new Date` parses as UTC
// midnight. UTC here is CORRECT and must stay: it is what stops the calendar day being shifted by a
// zone offset. Not an instant — do not "fix" this one to Cairo.
function formatPeriod(period: string | null): string {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return "not yet available";
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
// An INSTANT, so it is shown on the Cairo clock — the reader's own device zone used to decide it.
function formatExportTimestamp(iso: string): string {
  return cairoDateTime(iso);
}
// A DATE-ONLY `pay_date` column, so UTC (see formatPeriod above) — "15 Jul 2026", never "2026-07-15".
function formatPayDate(payDate: string | null): string {
  return payDate ? utcDate(payDate) : "—";
}
/** Who asked. A missing name reads "Unknown" — never the raw HR ID behind it. */
function requesterLabel(row: { requesterName: string | null }): string {
  return row.requesterName?.trim() || "Unknown";
}

/**
 * The table shell every table here shares: desktop and tablet only (phones get cards), and
 * `table-fixed` over a percentage `<colgroup>`, so the columns divide the container's width and no
 * long name or figure can push the page sideways. It replaces PortalDesktopTable, whose default
 * was a 980px minimum width inside a sideways scroller — the pattern the fits-the-screen rule bans.
 */
function FittedTable({
  children,
  className,
  widths,
}: {
  children: React.ReactNode;
  className?: string;
  /** Percentages, left to right; they must add up to 100. */
  widths: number[];
}) {
  return (
    <div className="hidden md:block">
      <table className={cn("w-full table-fixed border-collapse text-left text-sm", className)} data-portal-desktop-table>
        <colgroup>
          {widths.map((width, index) => (
            <col key={index} style={{ width: `${width}%` }} />
          ))}
        </colgroup>
        {children}
      </table>
    </div>
  );
}

const ROLLUP_DIMENSION_LABELS: Record<CoverageRollupDimension, string> = {
  line: "Line",
  region: "Region",
  requesterTier: "Requester tier",
};

const STATUS_LABELS: Record<string, string> = MARKETING_REQUEST_STATUS_LABEL;

const RESULT_BADGE_CLASS: Record<MarketingRoiResultStatus, string> = {
  on_track: "border-emerald-200 bg-emerald-50 text-emerald-700",
  behind: "border-amber-200 bg-amber-50 text-amber-700",
  awaiting_data: "border-sky-200 bg-sky-50 text-sky-700",
  no_data: "border-slate-200 bg-slate-50 text-slate-500",
};

/** Mirrors RESULT_BADGE_CLASS's own color choice per result status, for the mobile
 *  request card's left accent bar (PortalRecordCard's `accent` prop) — same signal,
 *  just a different rendering surface, never a new color convention. */
const RESULT_ACCENT: Record<MarketingRoiResultStatus, "emerald" | "amber" | "sky" | "slate"> = {
  on_track: "emerald",
  behind: "amber",
  awaiting_data: "sky",
  no_data: "slate",
};

/** Only the 3 requested states get a color; every other status keeps the plain-text look
 *  it already had (draft/returned/active/roi_tracking/closed/finance_hold are unaffected). */
const STATUS_BADGE_CLASS: Partial<Record<string, string>> = {
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-rose-200 bg-rose-50 text-rose-700",
  pending_validation: "border-amber-200 bg-amber-50 text-amber-700",
  pending_approval: "border-amber-200 bg-amber-50 text-amber-700",
};

const ROI_STATUS_OPTIONS: Array<{ value: MarketingRoiResultStatus; label: string }> = [
  { value: "on_track", label: ROI_RESULT_STATUS_LABEL.on_track },
  { value: "behind", label: ROI_RESULT_STATUS_LABEL.behind },
  { value: "awaiting_data", label: ROI_RESULT_STATUS_LABEL.awaiting_data },
  { value: "no_data", label: ROI_RESULT_STATUS_LABEL.no_data },
];

type EngineState = "ready" | "loading" | "loaded" | "error";

/** Request · Requester and customer · Cost and required · Actual and coverage · Result · expand. */
const REQUEST_TABLE_WIDTHS = [19, 29, 16, 16, 14, 6];
const REQUEST_TABLE_COLUMN_COUNT = REQUEST_TABLE_WIDTHS.length;

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
  /** One header's sort control. Merged columns carry one per figure, so nothing lost its sort. */
  function sortButton(key: RequestSortKey, label: string) {
    return (
      <button type="button" onClick={() => toggleRequestSort(key)} className="inline-flex items-center gap-1 font-black">
        {label} {requestSortArrow(key)}
      </button>
    );
  }
  // The cache is keyed by request AND by whether confidential products are revealed: the same
  // request's drill-down is a different answer with the confidential toggle on or off.
  const pharmacyCacheKey = (requestId: string) => `${requestId}|${report?.includedRestricted ? "revealed" : "masked"}`;
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
      // The filters the ON-SCREEN report ran with, not the panel's unapplied edits — the workbook
      // must be the page the viewer is looking at.
      const response = await fetch("/api/marketing-requests/coverage-report/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filters: report?.appliedFilters ?? filters }),
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
        ? computeCoverageRollupByDimension(report.rows, breakdownDimension, report.attributionLines ?? [])
        : [],
    [report, breakdownDimension],
  );
  const trend = React.useMemo(() => (report ? computeCoverageTrend(report.rows, report.attributionLines ?? []) : []), [report]);
  const sortedRows = React.useMemo(
    () => (report ? sortRequestRows(report.rows, requestSort.key, requestSort.direction) : []),
    [report, requestSort],
  );

  return (
    <WorkspaceErrorBoundary fallbackTitle="Marketing Coverage Report error">
      <div className="space-y-5" dir="auto">
        {/* ── Filters ───────────────────────────────────────────────────────── */}
        <section className={`${adminPanelClassName} rounded-none`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-phx-accent" />
              <div>
                <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-accent">Coverage Report</p>
                <h2 className="text-phx-lg font-black tracking-tight text-phx-ink">Filter by hierarchy, geography or person</h2>
              </div>
            </div>
            {faceted ? (
              <span className="inline-flex items-center gap-1.5 rounded-none border border-phx-line bg-phx-paper px-2.5 py-1 text-phx-xs font-bold text-phx-ink-soft">
                <Filter className="h-3 w-3" />
                {faceted.matchedCount === faceted.totalCount
                  ? `${faceted.totalCount} request${faceted.totalCount === 1 ? "" : "s"} in scope`
                  : `${faceted.matchedCount} of ${faceted.totalCount} match`}
              </span>
            ) : null}
          </div>

          <div className="p-4 sm:p-5">
            {optionsError ? (
              <div className="rounded-none border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{optionsError}</div>
            ) : !facets ? (
              <div className="flex items-center gap-2 py-6 text-phx-md font-semibold text-phx-ink-soft">
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
                    <div className={`${adminSoftPanelClassName} rounded-none px-3 py-2`}>
                      <p className="mb-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">ROI duration (months)</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={durationDim.min}
                          max={durationDim.max}
                          placeholder={String(durationDim.min ?? "")}
                          value={filters.durationMin ?? ""}
                          onChange={(event) => patchFilters({ durationMin: event.target.value === "" ? null : Number(event.target.value) })}
                          className={phxFieldClassName}
                        />
                        <span className="text-phx-ink-faint">–</span>
                        <input
                          type="number"
                          min={durationDim.min}
                          max={durationDim.max}
                          placeholder={String(durationDim.max ?? "")}
                          value={filters.durationMax ?? ""}
                          onChange={(event) => patchFilters({ durationMax: event.target.value === "" ? null : Number(event.target.value) })}
                          className={phxFieldClassName}
                        />
                      </div>
                    </div>
                  ) : null}

                  {payDateDim?.render ? (
                    <div className={`${adminSoftPanelClassName} rounded-none px-3 py-2`}>
                      <p className="mb-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">Pay date</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="date"
                          value={filters.payDateFrom ?? ""}
                          onChange={(event) => patchFilters({ payDateFrom: event.target.value || null })}
                          className={phxFieldClassName}
                        />
                        <span className="text-phx-ink-faint">–</span>
                        <input
                          type="date"
                          value={filters.payDateTo ?? ""}
                          onChange={(event) => patchFilters({ payDateTo: event.target.value || null })}
                          className={phxFieldClassName}
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
                      label: `Pay date: ${filters.payDateFrom ? formatPayDate(filters.payDateFrom) : "…"}–${filters.payDateTo ? formatPayDate(filters.payDateTo) : "…"}`,
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
                      <span className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">Active filters:</span>
                      {chips.map((chip) => (
                        <button
                          key={chip.key}
                          type="button"
                          onClick={chip.onClear}
                          className="inline-flex items-center gap-1.5 rounded-none border border-phx-accent-line bg-orange-50 px-2 py-1 text-phx-xs font-bold text-[#9A3412] transition hover:border-phx-accent hover:bg-orange-100"
                        >
                          {chip.label}
                          <span aria-hidden="true" className="text-phx-accent-press">×</span>
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
                      <span className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">Auto-applied:</span>
                      {autoChips.map(({ dim, label }) => (
                        <span key={dim.key} className="inline-flex items-center gap-1 rounded-none border border-phx-line bg-phx-paper px-2 py-1 text-phx-xs font-bold text-phx-ink-2">
                          {dim.label}: {label}
                        </span>
                      ))}
                    </div>
                  );
                })()}

                {restrictedDim?.render ? (
                  <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-none border border-amber-200 bg-amber-50 px-3 py-1.5 text-phx-sm font-bold text-amber-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-phx-accent"
                      checked={filters.includeRestricted}
                      onChange={(event) => startFilterTransition(() => setFilters((prev) => ({ ...prev, includeRestricted: event.target.checked })))}
                    />
                    Include confidential products
                  </label>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runReport(filters)}
                    disabled={state === "loading" || !hasAnyFilter}
                    className="inline-flex items-center gap-2 rounded-none bg-phx-accent px-4 py-2 text-phx-md font-black uppercase tracking-wide text-white shadow-sm transition hover:bg-phx-accent-hover disabled:opacity-60"
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
                    className="inline-flex items-center gap-2 rounded-none border border-phx-line bg-white px-3 py-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
                  >
                    <RefreshCcw className="h-3.5 w-3.5" /> Reset
                  </button>
                  {!hasAnyFilter ? (
                    <span className="text-phx-sm font-medium text-phx-ink-faint">Choose at least one filter to run the report.</span>
                  ) : null}
                  {hasReport ? (
                    <button
                      type="button"
                      onClick={() => void downloadExport()}
                      disabled={exporting}
                      className="inline-flex items-center gap-2 rounded-none border border-phx-ink bg-phx-ink px-3 py-2 text-phx-sm font-black uppercase tracking-wide text-white transition hover:bg-black disabled:opacity-60"
                    >
                      {exporting ? <LoadingSpinner /> : <Download className="h-3.5 w-3.5" />} Export XLSX
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-phx-paper-2 pt-3">
                  <span className="inline-flex items-center gap-1 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                    <Bookmark className="h-3.5 w-3.5" /> Presets
                  </span>
                  {presets.map((preset) => (
                    <span key={preset.id} className="inline-flex items-center gap-1 rounded-none border border-phx-line bg-white pl-2 text-phx-sm font-bold text-phx-ink-2 shadow-[0_1px_1px_rgba(15,23,42,0.05)]">
                      {preset.isDefault ? <Star className="h-3 w-3 fill-phx-accent text-phx-accent" /> : null}
                      <button type="button" onClick={() => applyPreset(preset)} className="py-1 transition hover:text-phx-accent">{preset.name}</button>
                      <button type="button" aria-label={`Delete ${preset.name}`} onClick={() => void deletePreset(preset.id)} className="px-1.5 py-1 text-phx-line-strong transition hover:text-red-500">
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {presets.length === 0 ? <span className="text-phx-xs font-medium text-phx-ink-faint">No saved views yet.</span> : null}
                  <span className="ml-auto flex items-center gap-1.5">
                    <input
                      type="text"
                      value={presetName}
                      onChange={(event) => setPresetName(event.target.value)}
                      placeholder="Name this view…"
                      className={cn(phxFieldClassName, "w-40")}
                    />
                    <button
                      type="button"
                      onClick={() => void savePreset(false)}
                      disabled={savingPreset || !presetName.trim()}
                      className="inline-flex h-8 items-center gap-1 rounded-none border border-phx-line bg-white px-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
                    >
                      <Save className="h-3.5 w-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={() => void savePreset(true)}
                      disabled={savingPreset || !presetName.trim()}
                      title="Save as my default view"
                      className="inline-flex h-8 items-center gap-1 rounded-none border border-phx-line bg-white px-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
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
          <div className="rounded-none border border-rose-200 bg-rose-50 px-4 py-3 text-phx-md font-semibold text-rose-800">{reportError}</div>
        ) : null}

        {/* ── Freshness banner ─────────────────────────────────────────────── */}
        {kpi ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-phx-sm font-semibold text-phx-ink-soft">
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5 text-phx-ink-faint" />
              Sales data current through {formatPeriod(kpi.salesDataAsOf)}
            </span>
            {facets?.lastExport ? (
              <span className="flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5 text-phx-ink-faint" />
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
          <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-none border border-amber-300 bg-amber-50 px-4 py-2.5 text-phx-md font-semibold text-amber-900">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              {kpi.actualsDegraded.count} request{kpi.actualsDegraded.count === 1 ? " has" : "s have"} no stored ROI
              figures yet, so {kpi.actualsDegraded.count === 1 ? "its" : "their"} actual sales were calculated live —
              current, but the page took longer to load.
            </span>
          </div>
        ) : null}

        {/* ── Worst zero-sales outlier ─────────────────────────────────────── */}
        {outlier ? (
          <button
            type="button"
            onClick={() => setExpandedRequestId(outlier.requestId)}
            className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-none border border-amber-300 bg-amber-50 px-4 py-2.5 text-left text-phx-md font-semibold text-amber-900 transition hover:border-amber-400 hover:bg-amber-100"
          >
            <Flame className="h-4 w-4 shrink-0 text-amber-600" />
            <span className="font-black uppercase tracking-wide text-amber-700">Highest spend, zero attributed sales:</span>
            <span className="font-bold">{outlier.requestCode}</span>
            <span className="min-w-0 break-words text-amber-700">{requesterLabel(outlier)}</span>
            <span className="ml-auto font-black tabular-nums">{money(outlier.estimatedCost)} EGP</span>
          </button>
        ) : null}

        {/* ── Premium KPI band ─────────────────────────────────────────────── */}
        {/* Pinned under the top bar ONLY from `xl` (1280px), where the ten cards are two rows of
            five and the band is short. Below that it scrolls with the page: stacked one per row
            on a phone it was ~1,060px tall — taller than the screen — so pinning it covered the
            breakdown and the whole request list, which then scrolled underneath it unseen, and at
            tablet width it still hid half the screen. z-10 keeps it under the top bar (sticky
            top-0 z-20), and the opaque background stops table rows showing through. Two cards to
            a row on a phone, three on a tablet, five on a desktop. */}
        {/* The default status scope is applied on the server (approved money only, the ROI
            report's own default). Said on screen, because a scope nobody can see is a figure
            nobody can check. */}
        {report && report.appliedFilters.status.length === 0 ? (
          <p className="text-phx-sm font-semibold text-phx-ink-soft">
            Approved money only: Approved, Active, ROI tracking, Closed and Finance hold. Choose statuses in the
            Status filter to include pending, sent-back, rejected or cancelled requests.
          </p>
        ) : null}

        {kpi ? (
          <section className="grid grid-cols-2 gap-2 bg-phx-paper py-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5 xl:sticky xl:top-20 xl:z-10">
            <CoverageKpiCard tone="slate" icon={<PackageSearch className="h-5 w-5" />} label="Requests" value={kpi.requestCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="orange" icon={<CircleDollarSign className="h-5 w-5" />} label="Total cost (EGP)" value={money(kpi.totalEstimatedCost)} />
            <CoverageKpiCard tone="orange" icon={<Target className="h-5 w-5" />} label="Required ROI (EGP)" value={money(kpi.totalRequiredRoi)} />
            <CoverageKpiCard tone="emerald" icon={<TrendingUp className="h-5 w-5" />} label="Actual sales (EGP)" value={money(kpi.totalActualValue)} />
            <CoverageKpiCard tone="blue" icon={<Filter className="h-5 w-5" />} label="Coverage" value={percent(kpi.coverageRatio)} />
            <CoverageKpiCard
              tone="emerald"
              icon={<CheckCircle2 className="h-5 w-5" />}
              label={ROI_RESULT_STATUS_LABEL.on_track}
              value={kpi.onTrackCount.toLocaleString("en-US")}
              onClick={() => toggleRoiStatusKpiFilter("on_track")}
              active={filters.roiStatus.length === 1 && filters.roiStatus[0] === "on_track"}
            />
            <CoverageKpiCard
              tone="amber"
              icon={<AlertTriangle className="h-5 w-5" />}
              label={ROI_RESULT_STATUS_LABEL.behind}
              value={kpi.behindCount.toLocaleString("en-US")}
              onClick={() => toggleRoiStatusKpiFilter("behind")}
              active={filters.roiStatus.length === 1 && filters.roiStatus[0] === "behind"}
            />
            {/* Every result status has its card. There was none for "Data pending", so while every
                window was still open (all of them, 2026-10-09) the three status cards read 0 / 0 / 0
                of 52 and the requests seemed to have no result at all. */}
            <CoverageKpiCard
              tone="blue"
              icon={<CalendarClock className="h-5 w-5" />}
              label={ROI_RESULT_STATUS_LABEL.awaiting_data}
              value={kpi.awaitingDataCount.toLocaleString("en-US")}
              onClick={() => toggleRoiStatusKpiFilter("awaiting_data")}
              active={filters.roiStatus.length === 1 && filters.roiStatus[0] === "awaiting_data"}
            />
            <CoverageKpiCard
              tone="slate"
              icon={<CircleSlash className="h-5 w-5" />}
              label={ROI_RESULT_STATUS_LABEL.no_data}
              value={kpi.noDataCount.toLocaleString("en-US")}
              onClick={() => toggleRoiStatusKpiFilter("no_data")}
              active={filters.roiStatus.length === 1 && filters.roiStatus[0] === "no_data"}
            />
            {/* Pharmacies and customers share one card so the band stays at ten. */}
            <CoverageKpiCard
              tone="violet"
              icon={<Building2 className="h-5 w-5" />}
              label="Pharmacies · customers"
              value={`${kpi.distinctPharmacyCount.toLocaleString("en-US")} · ${kpi.distinctCustomerCount.toLocaleString("en-US")}`}
            />
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
          <section className={`${adminPanelClassName} overflow-hidden rounded-none`}>
            <PortalResponsiveDataList
              empty={<div className="px-4 py-10 text-center text-phx-md font-semibold text-phx-ink-soft">No requests match the applied filters.</div>}
              getKey={(row) => row.requestId}
              items={sortedRows}
              renderCard={(row) => (
                <RequestAccordionCard
                  key={row.requestId}
                  row={row}
                  expanded={expandedRequestId === row.requestId}
                  onToggle={() => setExpandedRequestId((current) => (current === row.requestId ? null : row.requestId))}
                  isSuperAdmin={isSuperAdmin}
                  cachedPharmacies={pharmacyCache.get(pharmacyCacheKey(row.requestId)) ?? null}
                  includeRestricted={Boolean(report?.includedRestricted)}
                  onPharmaciesLoaded={(pharmacies) => cachePharmacies(pharmacyCacheKey(row.requestId), pharmacies)}
                />
              )}
              renderTable={() => (
                // Eleven columns MERGED to six so the table fits a tablet (768px) and a laptop with
                // the sidebar open without scrolling sideways — every figure is still here, and
                // every one still sorts from its own header button.
                <FittedTable widths={REQUEST_TABLE_WIDTHS}>
                  <thead>
                    <tr className={`${adminPanelHeaderClassName} text-left text-phx-xs font-black uppercase tracking-wide text-white`}>
                      <th className="px-2 py-2.5">
                        <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">
                          {sortButton("requestCode", "Request")}
                          {sortButton("status", "Status")}
                          {sortButton("payDate", "Pay date")}
                        </span>
                      </th>
                      <th className="px-2 py-2.5">
                        <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">
                          {sortButton("requesterName", "Requester")}
                          {sortButton("customerName", "Customer")}
                        </span>
                      </th>
                      <th className="px-2 py-2.5 text-right">
                        <span className="inline-flex flex-wrap justify-end gap-x-2 gap-y-0.5">
                          {sortButton("estimatedCost", "Cost")}
                          {sortButton("requiredRoiValue", "Required")}
                        </span>
                      </th>
                      <th className="px-2 py-2.5 text-right">
                        <span className="inline-flex flex-wrap justify-end gap-x-2 gap-y-0.5">
                          {sortButton("actualSalesValue", "Actual")}
                          {sortButton("actualCoverageRatio", "Coverage")}
                        </span>
                      </th>
                      <th className="px-2 py-2.5">{sortButton("resultStatus", "Result")}</th>
                      <th className="px-2 py-2.5">
                        <span className="sr-only">Target pharmacies</span>
                      </th>
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
                        cachedPharmacies={pharmacyCache.get(pharmacyCacheKey(row.requestId)) ?? null}
                        includeRestricted={Boolean(report?.includedRestricted)}
                        onPharmaciesLoaded={(pharmacies) => cachePharmacies(pharmacyCacheKey(row.requestId), pharmacies)}
                      />
                    ))}
                  </tbody>
                </FittedTable>
              )}
            />
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
    <section className={`${adminPanelClassName} overflow-hidden rounded-none`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line px-4 py-3 sm:px-5">
        <div>
          <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-accent">Coverage breakdown</p>
          <h3 className="text-phx-base font-black tracking-tight text-phx-ink">Where is coverage failing?</h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {BREAKDOWN_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => onDimensionChange(tab.key)}
              className={cn(
                "rounded-none border px-3 py-1.5 text-phx-sm font-bold uppercase tracking-wide transition",
                dimension === tab.key
                  ? "border-phx-accent bg-phx-accent text-white"
                  : "border-phx-line bg-white text-phx-ink-soft hover:border-phx-accent-line hover:text-phx-accent",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        {dimension === "distributor" ? (
          <PortalResponsiveDataList
            empty={<p className="px-4 py-6 text-center text-phx-md font-semibold text-phx-ink-soft">No distributor data for the current filter.</p>}
            getKey={(row) => row.distributorCode}
            items={distributorRollup}
            renderCard={(row) => (
              <div
                role="button"
                tabIndex={0}
                onClick={() => onFilterDimension("distributor", [row.distributorCode])}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onFilterDimension("distributor", [row.distributorCode]);
                }}
              >
                {/* The distributor by NAME; its code is shown only when no name is on file. */}
                <PortalRecordCard
                  className="cursor-pointer transition hover:bg-orange-50/40"
                  meta={`${row.requestCount.toLocaleString("en-US")} request${row.requestCount === 1 ? "" : "s"}`}
                  title={row.distributorName ?? row.distributorCode}
                >
                  <PortalRecordFields
                    fields={[
                      { label: "Allocated cost", value: money(row.allocatedCost) },
                      { label: "Allocated required ROI", value: money(row.allocatedRequiredRoi) },
                    ]}
                  />
                </PortalRecordCard>
              </div>
            )}
            renderTable={() => (
              <FittedTable widths={[40, 16, 22, 22]}>
                <thead>
                  <tr className={`${adminPanelHeaderClassName} text-left text-phx-xs font-black uppercase tracking-wide text-white`}>
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
                      className="cursor-pointer border-b border-phx-paper-2 transition hover:bg-orange-50/40"
                    >
                      <td className="break-words px-3 py-2 font-bold text-slate-900">{row.distributorName ?? row.distributorCode}</td>
                      <td className="break-words px-3 py-2 text-right tabular-nums text-slate-700">{row.requestCount.toLocaleString("en-US")}</td>
                      <td className="break-words px-3 py-2 text-right tabular-nums text-slate-700">{money(row.allocatedCost)}</td>
                      <td className="break-words px-3 py-2 text-right tabular-nums text-slate-700">{money(row.allocatedRequiredRoi)}</td>
                    </tr>
                  ))}
                </tbody>
              </FittedTable>
            )}
          />
        ) : (
          <PortalResponsiveDataList
            empty={<p className="px-4 py-6 text-center text-phx-md font-semibold text-phx-ink-soft">No data for the current filter.</p>}
            getKey={(row) => row.key}
            items={dimensionRollup}
            renderCard={(row) => {
              // "Unassigned" is a display fallback for a null/blank dimension value on
              // the row, not a real filterable value — filtering by it would silently
              // produce a wrong/empty result, so those rows render inert (no click).
              const filterable = row.key !== "Unassigned";
              const card = (
                <PortalRecordCard
                  accent={filterable ? "orange" : "slate"}
                  className={cn("transition", filterable ? "cursor-pointer hover:bg-orange-50/40" : "opacity-70")}
                  meta={`${row.requestCount.toLocaleString("en-US")} request${row.requestCount === 1 ? "" : "s"}`}
                  status={<span className="whitespace-nowrap text-sm font-black text-slate-900">{percent(row.coverageRatio)}</span>}
                  title={row.label}
                >
                  <PortalRecordFields
                    fields={[
                      { label: "Cost", value: money(row.totalCost) },
                      { label: "Actual", value: money(row.totalActualValue) },
                      { label: ROI_RESULT_STATUS_LABEL.behind, value: row.behindCount.toLocaleString("en-US") },
                      { label: ROI_RESULT_STATUS_LABEL.awaiting_data, value: row.awaitingDataCount.toLocaleString("en-US") },
                      { label: ROI_RESULT_STATUS_LABEL.no_data, value: row.noDataCount.toLocaleString("en-US") },
                    ]}
                  />
                </PortalRecordCard>
              );
              if (!filterable) return card;
              return (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onFilterDimension(dimension, [row.key])}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") onFilterDimension(dimension, [row.key]);
                  }}
                >
                  {card}
                </div>
              );
            }}
            renderTable={() => (
              // "Behind", "Data pending" and "No attributed sales" share one column (the counts side by side, in their
              // own colours) — seven columns did not fit a laptop with the sidebar open.
              <FittedTable widths={[26, 10, 15, 15, 12, 22]}>
                <thead>
                  <tr className={`${adminPanelHeaderClassName} text-left text-phx-xs font-black uppercase tracking-wide text-white`}>
                    <th className="px-3 py-2.5">{ROLLUP_DIMENSION_LABELS[dimension]}</th>
                    <th className="px-3 py-2.5 text-right">Requests</th>
                    <th className="px-3 py-2.5 text-right">Cost</th>
                    <th className="px-3 py-2.5 text-right">Actual</th>
                    <th className="px-3 py-2.5 text-right">Coverage</th>
                    <th className="px-3 py-2.5 text-right">
                      {ROI_RESULT_STATUS_LABEL.behind} · {ROI_RESULT_STATUS_LABEL.awaiting_data} · {ROI_RESULT_STATUS_LABEL.no_data}
                    </th>
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
                          "border-b border-phx-paper-2 transition",
                          filterable ? "cursor-pointer hover:bg-orange-50/40" : "opacity-70",
                        )}
                      >
                        <td className="break-words px-3 py-2 font-bold text-slate-900">{row.label}</td>
                        <td className="break-words px-3 py-2 text-right tabular-nums text-slate-700">{row.requestCount.toLocaleString("en-US")}</td>
                        <td className="break-words px-3 py-2 text-right tabular-nums text-slate-700">{money(row.totalCost)}</td>
                        <td className="break-words px-3 py-2 text-right tabular-nums font-semibold text-slate-900">{money(row.totalActualValue)}</td>
                        <td className="break-words px-3 py-2 text-right tabular-nums text-slate-700">{percent(row.coverageRatio)}</td>
                        <td className="break-words px-3 py-2 text-right tabular-nums">
                          <span className="text-amber-700">{row.behindCount.toLocaleString("en-US")}</span>
                          <span className="text-slate-300"> · </span>
                          <span className="text-sky-700">{row.awaitingDataCount.toLocaleString("en-US")}</span>
                          <span className="text-slate-300"> · </span>
                          <span className="text-slate-500">{row.noDataCount.toLocaleString("en-US")}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </FittedTable>
            )}
          />
        )}
      </div>

      {trend.length > 0 ? (
        <div className="border-t border-phx-paper-2 px-4 py-3 sm:px-5">
          <p className="mb-2 text-phx-xs font-black uppercase tracking-wide text-phx-ink-faint">Trend by pay month</p>
          <PortalResponsiveDataList
            empty={<p className="text-phx-md font-semibold text-phx-ink-soft">No trend data for the current filter.</p>}
            getKey={(point) => point.month}
            items={trend}
            renderCard={(point) => (
              <PortalRecordCard
                meta={`${point.requestCount.toLocaleString("en-US")} request${point.requestCount === 1 ? "" : "s"}`}
                status={<span className="whitespace-nowrap text-sm font-black text-slate-900">{percent(point.coverageRatio)}</span>}
                title={formatPeriod(point.month)}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Cost", value: money(point.totalCost) },
                    { label: "Actual", value: money(point.totalActualValue) },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <FittedTable widths={[28, 16, 20, 20, 16]}>
                <thead>
                  <tr className="text-left text-phx-xs font-black uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-1.5">Month</th>
                    <th className="px-3 py-1.5 text-right">Requests</th>
                    <th className="px-3 py-1.5 text-right">Cost</th>
                    <th className="px-3 py-1.5 text-right">Actual</th>
                    <th className="px-3 py-1.5 text-right">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((point) => (
                    <tr key={point.month} className="border-t border-phx-paper-2">
                      <td className="break-words px-3 py-1.5 font-bold text-slate-900">{formatPeriod(point.month)}</td>
                      <td className="break-words px-3 py-1.5 text-right tabular-nums text-slate-700">{point.requestCount.toLocaleString("en-US")}</td>
                      <td className="break-words px-3 py-1.5 text-right tabular-nums text-slate-700">{money(point.totalCost)}</td>
                      <td className="break-words px-3 py-1.5 text-right tabular-nums font-semibold text-slate-900">{money(point.totalActualValue)}</td>
                      <td className="break-words px-3 py-1.5 text-right tabular-nums text-slate-700">{percent(point.coverageRatio)}</td>
                    </tr>
                  ))}
                </tbody>
              </FittedTable>
            )}
          />
        </div>
      ) : null}
    </section>
  );
}

/** Fetches (and caches, via the parent-level pharmacyCache) a request's target pharmacies
 *  when its accordion row/card is expanded. Extracted so both the desktop row and mobile
 *  card presentations of the same request share byte-identical fetch/cache/error behavior —
 *  each still holds its own local copy (seeded from the shared cache), exactly like the
 *  single-presentation implementation this was lifted from. */
function useExpandedPharmacies({
  cachedPharmacies,
  expanded,
  includeRestricted,
  onPharmaciesLoaded,
  requestId,
}: {
  cachedPharmacies: MarketingCoveragePharmacyRow[] | null;
  expanded: boolean;
  /** Mirrors the report's own confidential toggle — the drill-down must never reveal more than the row. */
  includeRestricted: boolean;
  onPharmaciesLoaded: (pharmacies: MarketingCoveragePharmacyRow[]) => void;
  requestId: string;
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
        const query = includeRestricted ? "?includeRestricted=1" : "";
        const response = await fetch(`/api/marketing-requests/coverage-report/${encodeURIComponent(requestId)}/pharmacies${query}`, { cache: "no-store" });
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

  return { pharmacies, loading, error };
}

/** The "target pharmacies" drill-down shown under an expanded request — shared by both the
 *  desktop row (inside its TableRowDetail panel) and the mobile card (inside a plain <div>) so the two
 *  presentations never drift. Each pharmacy can itself expand to show its matched sales detail
 *  (Product / Month / Qty / Value), which gets its own desktop-table/mobile-card split. */
function PharmacyDrilldownPanel({
  error,
  isSuperAdmin,
  loading,
  pharmacies,
}: {
  error: string | null;
  isSuperAdmin: boolean;
  loading: boolean;
  pharmacies: MarketingCoveragePharmacyRow[] | null;
}) {
  // Only one pharmacy's sales-detail drill-down open at a time per request, mirroring the
  // single-expanded-request convention at the parent level — no separate fetch on toggle,
  // salesDetail is already present on each pharmacy row from the same load above.
  const [expandedPharmacyCode, setExpandedPharmacyCode] = React.useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-phx-md font-semibold text-slate-500">
        <LoadingSpinner /> Loading target pharmacies…
      </div>
    );
  }
  if (error) {
    return <div className="rounded-none border border-rose-200 bg-rose-50 px-3 py-2 text-phx-md font-semibold text-rose-700">{error}</div>;
  }
  if (!pharmacies || pharmacies.length === 0) {
    return <p className="py-2 text-phx-md font-semibold text-slate-500">This request has no target pharmacy codes.</p>;
  }

  return (
    <div className="space-y-1.5">
      <p className="text-phx-xs font-black uppercase tracking-wide text-slate-400">
        {pharmacies.length} target pharmac{pharmacies.length === 1 ? "y" : "ies"} — sales shown even at zero
      </p>
      {pharmacies.map((pharmacy) => {
        const pharmacyExpanded = expandedPharmacyCode === pharmacy.pharmacyCode;
        return (
          <div key={pharmacy.pharmacyCode} className="rounded-none border border-slate-200 bg-white">
            {/* The toggle is a real <button> and the "Full sales history" link sits BESIDE it, not
                inside it — a link nested in a clickable row is two controls a screen reader and a
                keyboard cannot tell apart. Names wrap (never clipped by the card's edge). */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 transition hover:bg-orange-50/40">
              <button
                type="button"
                aria-expanded={pharmacyExpanded}
                onClick={() => setExpandedPharmacyCode((current) => (current === pharmacy.pharmacyCode ? null : pharmacy.pharmacyCode))}
                className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left md:min-h-0"
              >
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-slate-400 transition", pharmacyExpanded ? "rotate-180" : "")} />
                <span className="min-w-0 break-words text-sm font-semibold text-slate-900">{pharmacy.pharmacyName}</span>
                <span className="min-w-0 break-words text-xs font-medium text-slate-500">({pharmacy.pharmacyCode})</span>
                <span className="text-slate-300">·</span>
                <span className="min-w-0 break-words text-sm text-slate-700">{pharmacy.distributorName ?? "Unknown distributor"}</span>
                <span className={cn("ml-auto whitespace-nowrap text-sm font-bold tabular-nums", pharmacy.hasSalesRows ? "text-emerald-700" : "text-slate-400")}>
                  {money(pharmacy.salesValue)} EGP
                </span>
              </button>
              {isSuperAdmin && pharmacy.parentDistributorCode ? (
                <a
                  href={`/sales/customer-directory/${encodeURIComponent(pharmacy.parentDistributorCode)}/${encodeURIComponent(pharmacy.pharmacyCode)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-none border border-slate-300 px-2 py-1 text-phx-xs font-bold text-slate-700 transition hover:border-phx-accent hover:text-phx-accent"
                >
                  <ExternalLink className="h-3 w-3" /> Full sales history
                </a>
              ) : null}
            </div>
            {pharmacyExpanded ? (
              <div className="border-t border-slate-200 bg-slate-50 px-3 py-2 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)]">
                <PortalResponsiveDataList
                  empty={<p className="py-1 text-phx-sm font-medium text-slate-500">No matched sales in this window.</p>}
                  getKey={(sale, index) => `${sale.productCode}-${sale.invoicePeriod}-${index}`}
                  items={pharmacy.salesDetail}
                  renderCard={(sale) => (
                    <PortalRecordCard accent="slate" meta={formatPeriod(sale.invoicePeriod)} title={sale.productName}>
                      <PortalRecordFields
                        fields={[
                          { label: "Qty", value: sale.qty.toLocaleString("en-US") },
                          { label: "Value (EGP)", value: money(sale.value) },
                        ]}
                      />
                    </PortalRecordCard>
                  )}
                  renderTable={() => (
                    <FittedTable className="text-phx-sm" widths={[40, 24, 14, 22]}>
                      <thead>
                        <tr className="text-left text-phx-2xs font-black uppercase tracking-wide text-slate-400">
                          <th className="px-2 py-1">Product</th>
                          <th className="px-2 py-1">Month</th>
                          <th className="px-2 py-1 text-right">Qty</th>
                          <th className="px-2 py-1 text-right">Value (EGP)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pharmacy.salesDetail.map((sale, index) => (
                          <tr key={`${sale.productCode}-${sale.invoicePeriod}-${index}`} className="border-t border-slate-200">
                            <td className="break-words px-2 py-1 font-semibold text-slate-900">{sale.productName}</td>
                            <td className="break-words px-2 py-1 text-slate-600">{formatPeriod(sale.invoicePeriod)}</td>
                            <td className="break-words px-2 py-1 text-right tabular-nums text-slate-700">{sale.qty.toLocaleString("en-US")}</td>
                            <td className="break-words px-2 py-1 text-right tabular-nums font-bold text-emerald-700">{money(sale.value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </FittedTable>
                  )}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RequestAccordionRow({
  row,
  expanded,
  onToggle,
  isSuperAdmin,
  cachedPharmacies,
  includeRestricted,
  onPharmaciesLoaded,
}: {
  row: MarketingCoverageReportRow;
  expanded: boolean;
  onToggle: () => void;
  isSuperAdmin: boolean;
  includeRestricted: boolean;
  /** Parent-level cache lookup — a request's target-pharmacy sales don't change on
   *  re-expand, so a cache hit skips the network fetch entirely. */
  cachedPharmacies: MarketingCoveragePharmacyRow[] | null;
  onPharmaciesLoaded: (pharmacies: MarketingCoveragePharmacyRow[]) => void;
}) {
  const { pharmacies, loading, error } = useExpandedPharmacies({ cachedPharmacies, expanded, includeRestricted, onPharmaciesLoaded, requestId: row.requestId });

  const locationLabel = [row.line, row.region, row.areaName].filter(Boolean).join(" / ") || "—";
  const detailId = `coverage-request-detail-${row.requestId}`;

  return (
    <>
      <tr
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") onToggle();
        }}
        {...rowDetailToggleProps(detailId, expanded)}
        className="cursor-pointer border-b border-[rgba(249,115,22,0.22)] align-top transition hover:bg-orange-50/40"
      >
        {/* Request · status · pay date */}
        <td className="break-words px-2 py-2.5">
          <span className="block font-bold text-slate-900">{row.requestCode}</span>
          <span className="mt-1 block text-slate-600">
            {STATUS_BADGE_CLASS[row.status] ? (
              <span className={cn("inline-flex rounded-none border px-2 py-0.5 text-phx-xs font-bold", STATUS_BADGE_CLASS[row.status])}>
                {STATUS_LABELS[row.status] ?? requestStatusLabel(row.status)}
              </span>
            ) : (
              <span className="text-phx-xs font-semibold">{STATUS_LABELS[row.status] ?? requestStatusLabel(row.status)}</span>
            )}
          </span>
          <span className="mt-1 block text-xs text-slate-500">Paid {row.payDate ? formatPayDate(row.payDate) : "not yet"}</span>
        </td>
        {/* Requester (with location and tier) · customer */}
        <td className="break-words px-2 py-2.5">
          <span className="block font-bold text-slate-900">{requesterLabel(row)}</span>
          <span className="block text-xs text-slate-400">
            {locationLabel}
            {row.requesterTier ? <span className="ml-1.5 font-semibold">({row.requesterTier})</span> : null}
          </span>
          <span className="mt-1 block text-slate-700">{row.customerName}</span>
        </td>
        {/* Cost · required */}
        <td className="break-words px-2 py-2.5 text-right tabular-nums">
          <span className="block text-slate-700">{money(row.estimatedCost)}</span>
          <span className="block text-xs text-slate-500">{money(row.requiredRoiValue)} required</span>
        </td>
        {/* Actual · coverage */}
        <td className="break-words px-2 py-2.5 text-right tabular-nums">
          <span className="block font-semibold text-slate-900">{money(row.actualSalesValue)}</span>
          <span className="block text-xs text-slate-500">{percent(row.actualCoverageRatio)} covered</span>
        </td>
        <td className="break-words px-2 py-2.5">
          <span className={cn("inline-flex rounded-none border px-2 py-0.5 text-phx-xs font-bold", RESULT_BADGE_CLASS[row.resultStatus])}>
            {ROI_RESULT_STATUS_LABEL[row.resultStatus]}
          </span>
        </td>
        <td className="px-2 py-2.5 text-right">
          <ChevronDown aria-hidden="true" className={cn("ml-auto h-4 w-4 text-slate-400 transition", expanded ? "rotate-180" : "")} />
        </td>
      </tr>
      {expanded ? (
        <TableRowDetail colSpan={REQUEST_TABLE_COLUMN_COUNT} id={detailId}>
          <PharmacyDrilldownPanel error={error} isSuperAdmin={isSuperAdmin} loading={loading} pharmacies={pharmacies} />
        </TableRowDetail>
      ) : null}
    </>
  );
}

/** Mobile counterpart of RequestAccordionRow — same expand/fetch behavior (via
 *  useExpandedPharmacies) and the same PharmacyDrilldownPanel drill-down, rendered as a
 *  PortalRecordCard instead of a <tr>. Not every column carries equal weight on a phone: the
 *  Result badge (this report's headline signal, already used to drive the KPI toggle buttons
 *  above) takes the card's title-row status slot and its accent color, requester + location
 *  become the meta line, and the remaining workflow-status/pay-date/money/coverage figures
 *  move into the fields grid. */
function RequestAccordionCard({
  row,
  expanded,
  onToggle,
  isSuperAdmin,
  cachedPharmacies,
  includeRestricted,
  onPharmaciesLoaded,
}: {
  row: MarketingCoverageReportRow;
  expanded: boolean;
  onToggle: () => void;
  isSuperAdmin: boolean;
  includeRestricted: boolean;
  cachedPharmacies: MarketingCoveragePharmacyRow[] | null;
  onPharmaciesLoaded: (pharmacies: MarketingCoveragePharmacyRow[]) => void;
}) {
  const { pharmacies, loading, error } = useExpandedPharmacies({ cachedPharmacies, expanded, includeRestricted, onPharmaciesLoaded, requestId: row.requestId });

  const locationLabel = [row.line, row.region, row.areaName].filter(Boolean).join(" / ") || "—";

  // The card itself is NOT a button any more. It used to be one, with the whole drill-down — each
  // pharmacy's own toggle and the "Full sales history" link — nested inside it: controls inside a
  // control, which a screen reader cannot separate and which needed stopPropagation to work at all.
  // One real <button> now opens and closes the drill-down, and the drill-down sits beside it.
  return (
    <PortalRecordCard
      accent={RESULT_ACCENT[row.resultStatus]}
      meta={
        <>
          <span className="block break-words font-bold text-slate-700">{requesterLabel(row)}</span>
          <span className="block break-words text-slate-400">
            {locationLabel}
            {row.requesterTier ? <span className="ml-1.5 font-semibold">({row.requesterTier})</span> : null}
          </span>
        </>
      }
      status={
        <span className={cn("inline-flex whitespace-nowrap rounded-none border px-2 py-0.5 text-phx-xs font-bold", RESULT_BADGE_CLASS[row.resultStatus])}>
          {ROI_RESULT_STATUS_LABEL[row.resultStatus]}
        </span>
      }
      title={row.requestCode}
    >
      <PortalRecordFields
        fields={[
          { label: "Customer", value: row.customerName },
          {
            label: "Status",
            value: STATUS_BADGE_CLASS[row.status] ? (
              <span className={cn("inline-flex rounded-none border px-2 py-0.5 text-phx-xs font-bold", STATUS_BADGE_CLASS[row.status])}>
                {STATUS_LABELS[row.status] ?? requestStatusLabel(row.status)}
              </span>
            ) : (
              STATUS_LABELS[row.status] ?? requestStatusLabel(row.status)
            ),
          },
          { label: "Pay date", value: formatPayDate(row.payDate) },
          { label: "Cost (EGP)", value: money(row.estimatedCost) },
          { label: "Required ROI (EGP)", value: money(row.requiredRoiValue) },
          { label: "Actual sales (EGP)", value: money(row.actualSalesValue) },
          { label: "Coverage", value: percent(row.actualCoverageRatio) },
        ]}
      />
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="mt-3 flex min-h-10 w-full items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-3 text-left text-phx-sm font-bold text-slate-700 transition hover:border-phx-accent-line hover:bg-orange-50/40 hover:text-phx-accent"
      >
        {expanded ? "Hide target pharmacies" : "Show target pharmacies"}
        <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-slate-400 transition", expanded ? "rotate-180" : "")} />
      </button>
      {expanded ? (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <PharmacyDrilldownPanel error={error} isSuperAdmin={isSuperAdmin} loading={loading} pharmacies={pharmacies} />
        </div>
      ) : null}
    </PortalRecordCard>
  );
}
