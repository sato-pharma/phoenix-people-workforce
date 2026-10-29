"use client";

import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
import { countOf } from "@/lib/i18n/format";
import * as React from "react";
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  Filter,
  Link2,
  RefreshCcw,
  Save,
  SlidersHorizontal,
  Star,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { RoiMultiSelect } from "@/components/marketing-requests/roi-multi-select";
import {
  roiFilterStateFromParams,
  roiFilterStateHasAny,
  roiFilterStateToParams,
} from "@/lib/marketing-requests/roi-filter-url";
import {
  computeFacetedDimensions,
  pruneRoiFilterState,
  withRoiFilterValues,
} from "@/lib/marketing-requests/roi-facets";
import {
  emptyRoiFilterState,
  type MarketingRoiFilterFacets,
  type MarketingRoiPreset,
  type MarketingRoiReport,
  type MarketingRoiReportRow,
  type MarketingRoiResultStatus,
  type RoiFilterDimension,
  type RoiFilterKey,
  type RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";
import {
  ROI_ACTUAL_COVERAGE_LABEL,
  ROI_DATA_COVERAGE_LABEL,
  ROI_FORECAST_COVERAGE_LABEL,
  ROI_RESULT_STATUS_LABEL,
} from "@/lib/marketing-requests/roi-labels";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}

function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

type RoiSortDirection = "asc" | "desc";
type RoiSortKey = "requestCode" | "requesterName" | "line" | "customerName" | "status" | "roiWindow" | "requiredRoiValue" | "actualSalesValue" | "actualCoverageRatio" | "resultStatus";
type RoiSortState = { key: RoiSortKey; direction: RoiSortDirection };

const RESULT_STATUS_SORT_WEIGHT: Record<MarketingRoiResultStatus, number> = {
  on_track: 0,
  behind: 1,
  awaiting_data: 2,
  no_data: 3,
};

const ROI_SORT_LABELS: Record<RoiSortKey, string> = {
  requestCode: "Request",
  requesterName: "Requester",
  line: "Line",
  customerName: "Customer",
  status: "Status",
  roiWindow: "ROI window",
  requiredRoiValue: "Required",
  actualSalesValue: "Actual",
  actualCoverageRatio: "Coverage",
  resultStatus: "Result",
};

// Result-status DISPLAY labels come from the shared roi-labels source of truth so the report,
// the drafts list and the export never drift. The underlying VALUES (on_track/behind/…) are the
// filter contract and are intentionally left unchanged.
const RESULT_STATUS_META: Record<MarketingRoiResultStatus, { label: string; className: string }> = {
  on_track: { label: ROI_RESULT_STATUS_LABEL.on_track, className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  behind: { label: ROI_RESULT_STATUS_LABEL.behind, className: "border-amber-200 bg-amber-50 text-amber-700" },
  awaiting_data: { label: ROI_RESULT_STATUS_LABEL.awaiting_data, className: "border-sky-200 bg-sky-50 text-sky-700" },
  no_data: { label: ROI_RESULT_STATUS_LABEL.no_data, className: "border-slate-200 bg-slate-50 text-slate-500" },
};

const ROI_STATUS_OPTIONS: Array<{ value: MarketingRoiResultStatus; label: string }> = [
  { value: "on_track", label: ROI_RESULT_STATUS_LABEL.on_track },
  { value: "behind", label: ROI_RESULT_STATUS_LABEL.behind },
  { value: "awaiting_data", label: ROI_RESULT_STATUS_LABEL.awaiting_data },
  { value: "no_data", label: ROI_RESULT_STATUS_LABEL.no_data },
];

const ROI_ROWS_PER_PAGE = 10;

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
  archived: "Archived",
  cancelled: "Cancelled",
};

function KpiCard({
  accent,
  icon: Icon,
  label,
  value,
  hint,
}: {
  accent: "slate" | "green" | "amber" | "sky" | "orange";
  icon: typeof CheckCircle2;
  label: string;
  value: string | number;
  hint?: string | null;
}) {
  const border = {
    slate: "border-l-slate-500",
    green: "border-l-emerald-500",
    amber: "border-l-amber-500",
    sky: "border-l-sky-500",
    orange: "border-l-phx-accent",
  }[accent];
  const iconColor = {
    slate: "text-slate-600",
    green: "text-emerald-600",
    amber: "text-amber-600",
    sky: "text-sky-600",
    orange: "text-phx-accent",
  }[accent];
  return (
    <div className={cn("rounded-[6px] border border-phx-line border-l-[3px] bg-white px-3.5 py-3 shadow-sm", border)}>
      <div className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
        <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">{label}</p>
      </div>
      <p className="mt-1.5 text-[22px] font-black leading-none text-phx-ink">{value}</p>
      {hint ? <p className="mt-1 text-phx-xs font-semibold text-phx-ink-faint">{hint}</p> : null}
    </div>
  );
}

type EngineState = "ready" | "loading" | "loaded" | "error";

export function MarketingRoiFilterEngine({ viewSalesBasePath }: { viewSalesBasePath: string }) {
  const [facets, setFacets] = React.useState<MarketingRoiFilterFacets | null>(null);
  const [optionsError, setOptionsError] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState<RoiFilterState>(emptyRoiFilterState);
  const [report, setReport] = React.useState<MarketingRoiReport | null>(null);
  const [state, setState] = React.useState<EngineState>("ready");
  const [reportError, setReportError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [presets, setPresets] = React.useState<MarketingRoiPreset[]>([]);
  const [presetName, setPresetName] = React.useState("");
  const [savingPreset, setSavingPreset] = React.useState(false);
  const [, startFilterTransition] = React.useTransition();

  async function fetchPresets(): Promise<MarketingRoiPreset[]> {
    const response = await fetch("/api/marketing-requests/roi-tracking/presets", { cache: "no-store" });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.presets ?? []) as MarketingRoiPreset[];
  }

  // Load filter options once; hydrate filters from the URL and auto-apply if present.
  // The URL read + setState live inside the async callback (after the first await) so
  // the server and client initial render both start from the empty state (no hydration
  // mismatch) and we never call setState synchronously in the effect body.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const urlFilters = roiFilterStateFromParams(new URLSearchParams(window.location.search));
      const hasUrl = roiFilterStateHasAny(urlFilters);
      try {
        const filterOptionsPromise = fetch("/api/marketing-requests/roi-tracking/filter-options", { cache: "no-store" })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message ?? "Unable to load filters.");
            return payload as MarketingRoiFilterFacets;
          });
        const presetsPromise = fetchPresets().catch(() => []);
        const [payload, presetList] = await Promise.all([filterOptionsPromise, presetsPromise]);
        if (cancelled) return;
        setFacets(payload);
        setPresets(presetList);

        if (hasUrl) {
          startFilterTransition(() => setFilters(urlFilters));
          void runReport(urlFilters);
        } else {
          const fallbackDefault = presetList.find((preset) => preset.isDefault);
          if (fallbackDefault) {
            startFilterTransition(() => setFilters(fallbackDefault.filters));
            void runReport(fallbackDefault.filters);
          }
        }
      } catch (error) {
        if (!cancelled) setOptionsError(error instanceof Error ? error.message : "Unable to load filters.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshPresets() {
    try {
      setPresets(await fetchPresets());
    } catch {
      // ignore
    }
  }

  function applyPreset(preset: MarketingRoiPreset) {
    startFilterTransition(() => setFilters(preset.filters));
    void runReport(preset.filters);
  }

  async function savePreset(makeDefault: boolean) {
    const name = presetName.trim();
    if (!name) return;
    setSavingPreset(true);
    try {
      const response = await fetch("/api/marketing-requests/roi-tracking/presets", {
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
      const response = await fetch(`/api/marketing-requests/roi-tracking/presets?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      if (response.ok) await refreshPresets();
    } catch {
      // ignore
    }
  }

  async function runReport(next: RoiFilterState) {
    setState("loading");
    setReportError(null);
    try {
      const response = await fetch("/api/marketing-requests/roi-tracking", {
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
      setReport(payload as MarketingRoiReport);
      setState("loaded");
      const params = roiFilterStateToParams(next);
      const query = params.toString();
      window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
    } catch {
      setReport(null);
      setReportError("Unable to load the report.");
      setState("error");
    }
  }

  // Live, dependent (faceted) dimensions: recomputed from the scoped index on every
  // selection change so the filters cascade (pick an NSM → DM collapses to that NSM's
  // DMs; pick line = Pedia → everything narrows to fit).
  const faceted = React.useMemo(
    () => (facets ? computeFacetedDimensions(facets.entries, filters, facets.canRevealRestricted) : null),
    [facets, filters],
  );

  // Mutate a filter and auto-fit: drop any other selection that no longer fits.
  function setArray(key: RoiFilterKey, values: string[]) {
    startFilterTransition(() => {
      setFilters((prev) => {
        const next = withRoiFilterValues(prev, key, values);
        // `key` is the anchor — preserve the user's just-made choice, fit the others to it.
        return facets ? pruneRoiFilterState(facets.entries, next, key) : next;
      });
    });
  }

  // Patch scalar/range/toggle filters and auto-fit the multi-selects (a narrower date
  // or duration range can make a previously-chosen DM/product impossible).
  function patchFilters(patch: Partial<RoiFilterState>) {
    startFilterTransition(() => {
      setFilters((prev) => {
        const next = { ...prev, ...patch } as RoiFilterState;
        return facets ? pruneRoiFilterState(facets.entries, next) : next;
      });
    });
  }

  function renderableDimensions(): RoiFilterDimension[] {
    return (faceted?.dimensions ?? []).filter((dim) => dim.render && dim.type === "multiselect");
  }

  function autoAppliedDimensions(): RoiFilterDimension[] {
    return (faceted?.dimensions ?? []).filter((dim) => !dim.render && dim.autoApplied && dim.autoApplied.length > 0);
  }

  function dimensionByKey(key: RoiFilterKey): RoiFilterDimension | undefined {
    return faceted?.dimensions.find((dim) => dim.key === key);
  }

  function selectedFor(key: RoiFilterKey): string[] {
    if (key === "requestType") return filters.requestType.map(String);
    const value = (filters as Record<string, unknown>)[key];
    return Array.isArray(value) ? (value as string[]) : [];
  }

  const durationDim = dimensionByKey("duration");
  const payDateDim = dimensionByKey("payDate");
  const restrictedDim = dimensionByKey("includeRestricted");
  const hasReport = state === "loaded" && report;

  async function downloadExport() {
    setExporting(true);
    try {
      const response = await fetch("/api/marketing-requests/roi-tracking/export", {
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
      const filename = match ? match[1] : "phoenix-marketing-roi.xlsx";
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

  async function copyShareLink() {
    try {
      const params = roiFilterStateToParams(filters);
      const url = `${window.location.origin}${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard not available — ignore
    }
  }

  return (
    <WorkspaceErrorBoundary fallbackTitle="ROI tracking error">
      <div className="space-y-4" dir="auto">
        {/* ── Filter Engine ─────────────────────────────────────────────────── */}
        <section className={`${adminPanelClassName} rounded-[6px]`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-phx-accent" />
              <div>
                <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-accent">Filter Engine</p>
                <h2 className="text-phx-lg font-black tracking-tight text-phx-ink">Build your ROI report</h2>
              </div>
            </div>
            {faceted ? (
              <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-phx-line bg-phx-paper px-2.5 py-1 text-phx-xs font-bold text-phx-ink-soft">
                <Filter className="h-3 w-3" />
                {faceted.matchedCount === faceted.totalCount
                  ? `${faceted.totalCount} request${faceted.totalCount === 1 ? "" : "s"} in scope`
                  : `${faceted.matchedCount} of ${faceted.totalCount} match`}
              </span>
            ) : null}
          </div>

          <div className="p-4 sm:p-5">
            {optionsError ? (
              <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{optionsError}</div>
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

                  {/* ROI status — always meaningful (fixed enum) */}
                  <RoiMultiSelect
                    label="ROI status"
                    options={ROI_STATUS_OPTIONS}
                    selected={filters.roiStatus}
                    onChange={(values) => startFilterTransition(() => setFilters((prev) => ({ ...prev, roiStatus: values as MarketingRoiResultStatus[] })))}
                  />

                  {/* ROI duration range */}
                  {durationDim?.render ? (
                    <div className={`${adminSoftPanelClassName} rounded-[6px] px-3 py-2`}>
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

                  {/* Pay date range */}
                  {payDateDim?.render ? (
                    <div className={`${adminSoftPanelClassName} rounded-[6px] px-3 py-2`}>
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

                {/* Auto-applied (single-value) dimensions — shown read-only. A chip is only
                    rendered when its single value resolves to a human label; we never fall
                    back to the raw value (e.g. an hr_id). */}
                {(() => {
                  const autoChips = autoAppliedDimensions()
                    .map((dim) => ({
                      dim,
                      label: dim.options.find((option) => option.value === dim.autoApplied?.[0])?.label ?? null,
                    }))
                    .filter((chip) => chip.label !== null);
                  if (autoChips.length === 0) return null;
                  return (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">Auto-applied:</span>
                      {autoChips.map(({ dim, label }) => (
                        <span key={dim.key} className="inline-flex items-center gap-1 rounded-[4px] border border-phx-line bg-phx-paper px-2 py-1 text-phx-xs font-bold text-phx-ink-2">
                          {dim.label}: {label}
                        </span>
                      ))}
                    </div>
                  );
                })()}

                {/* Confidential toggle */}
                {restrictedDim?.render ? (
                  <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-[5px] border border-amber-200 bg-amber-50 px-3 py-1.5 text-phx-sm font-bold text-amber-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-phx-accent"
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
                    disabled={state === "loading" || !roiFilterStateHasAny(filters)}
                    className="inline-flex items-center gap-2 rounded-[6px] bg-phx-accent px-4 py-2 text-phx-md font-black uppercase tracking-wide text-white shadow-sm transition hover:bg-phx-accent-hover disabled:opacity-60"
                  >
                    {state === "loading" ? <LoadingSpinner /> : <Filter className="h-3.5 w-3.5" />}
                    Apply Filters
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      startFilterTransition(() => setFilters(emptyRoiFilterState()));
                      setReport(null);
                      setState("ready");
                      window.history.replaceState(null, "", window.location.pathname);
                    }}
                    className="inline-flex items-center gap-2 rounded-[6px] border border-phx-line bg-white px-3 py-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
                  >
                    <RefreshCcw className="h-3.5 w-3.5" /> Reset
                  </button>
                  {!roiFilterStateHasAny(filters) ? (
                    <span className="text-phx-sm font-medium text-phx-ink-faint">Choose at least one filter to run the report.</span>
                  ) : null}
                  {hasReport ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void downloadExport()}
                        disabled={exporting}
                        className="inline-flex items-center gap-2 rounded-[6px] border border-phx-ink bg-phx-ink px-3 py-2 text-phx-sm font-black uppercase tracking-wide text-white transition hover:bg-black disabled:opacity-60"
                      >
                        {exporting ? <LoadingSpinner /> : <Download className="h-3.5 w-3.5" />} Export XLSX
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyShareLink()}
                        className="inline-flex items-center gap-2 rounded-[6px] border border-phx-line bg-white px-3 py-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
                      >
                        <Link2 className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy share link"}
                      </button>
                    </>
                  ) : null}
                </div>

                {/* Saved presets */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-phx-paper-2 pt-3">
                  <span className="inline-flex items-center gap-1 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                    <Bookmark className="h-3.5 w-3.5" /> Presets
                  </span>
                  {presets.map((preset) => (
                    <span key={preset.id} className="inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-white pl-2 text-phx-sm font-bold text-phx-ink-2 shadow-[0_1px_1px_rgba(15,23,42,0.05)]">
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
                      className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-phx-line bg-white px-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
                    >
                      <Save className="h-3.5 w-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={() => void savePreset(true)}
                      disabled={savingPreset || !presetName.trim()}
                      title="Save as my default view"
                      className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-phx-line bg-white px-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
                    >
                      <Star className="h-3.5 w-3.5" /> Default
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        </section>

        {/* ── Results ───────────────────────────────────────────────────────── */}
        {reportError ? (
          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800">{reportError}</div>
        ) : null}

        {hasReport && report ? <ReportView key={report.generatedAtIso} report={report} viewSalesBasePath={viewSalesBasePath} /> : null}

        {state === "ready" && facets ? (
          <div className="rounded-[6px] border border-dashed border-phx-line bg-phx-paper px-4 py-10 text-center">
            <Filter className="mx-auto h-6 w-6 text-phx-line-strong" />
            <p className="mt-2 text-phx-md font-bold text-phx-ink-soft">Choose your filters and press “Apply Filters”.</p>
            <p className="mt-1 text-phx-sm font-medium text-phx-ink-faint">Nothing loads until you apply — so the report is fast and scoped to exactly what you ask for.</p>
          </div>
        ) : null}
      </div>
    </WorkspaceErrorBoundary>
  );
}

function ReportView({ report, viewSalesBasePath }: { report: MarketingRoiReport; viewSalesBasePath: string }) {
  const { kpi, rows } = report;
  const [sort, setSort] = React.useState<RoiSortState>({ key: "actualCoverageRatio", direction: "desc" });
  const [page, setPage] = React.useState(1);

  const sortKeyLabel = ROI_SORT_LABELS[sort.key];

  function getSortValue(row: MarketingRoiReportRow, key: RoiSortKey): string | number | null {
    switch (key) {
      case "requestCode":
        return row.requestCode;
      case "requesterName":
        return row.requesterName ?? "";
      case "line":
        return row.line ?? "";
      case "customerName":
        return row.customerName;
      case "status":
        return STATUS_LABELS[row.status] ?? requestStatusLabel(row.status);
      case "roiWindow":
        return row.roiWindow ?? "";
      case "requiredRoiValue":
        return row.requiredRoiValue;
      case "actualSalesValue":
        return row.actualSalesValue;
      case "actualCoverageRatio":
        return row.hasSalesData ? row.actualCoverageRatio : null;
      case "resultStatus":
        return RESULT_STATUS_SORT_WEIGHT[row.resultStatus];
    }
  }

  function compareSortValues(left: string | number | null, right: string | number | null): number {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left).localeCompare(String(right), undefined, { sensitivity: "base" });
  }

  const sortedRows = React.useMemo(() => {
    const next = [...rows];
    next.sort((a, b) => {
      const aValue = getSortValue(a, sort.key);
      const bValue = getSortValue(b, sort.key);
      const cmp = compareSortValues(aValue, bValue);
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return next;
  }, [rows, sort]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / ROI_ROWS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * ROI_ROWS_PER_PAGE;
  const pageEnd = Math.min(pageStart + ROI_ROWS_PER_PAGE, sortedRows.length);
  const visibleRows = React.useMemo(() => sortedRows.slice(pageStart, pageStart + ROI_ROWS_PER_PAGE), [pageStart, sortedRows]);
  const pageSummary = sortedRows.length === 0 ? "No rows" : `Showing ${pageStart + 1}-${pageEnd} of ${sortedRows.length}`;

  function toggleSort(nextKey: RoiSortKey) {
    setPage(1);
    setSort((current) => {
      if (current.key !== nextKey) return { key: nextKey, direction: "asc" };
      return { key: nextKey, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  }

  function sortArrow(forKey: RoiSortKey) {
    if (sort.key !== forKey) return "↕";
    return sort.direction === "asc" ? "↑" : "↓";
  }

  function goToPage(nextPage: number) {
    setPage(Math.min(Math.max(nextPage, 1), totalPages));
  }

  return (
    <div className="space-y-4">
      {/* KPI band */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard accent="slate" icon={Target} label="Requests" value={kpi.requestCount} />
        <KpiCard accent="orange" icon={TrendingUp} label="Cost" value={money(kpi.totalEstimatedCost)} />
        <KpiCard
          accent="sky"
          icon={Target}
          label="Required ROI"
          value={money(kpi.totalRequiredRoi)}
          hint={`${percent(kpi.totalRequiredRoi > 0 ? kpi.totalExpectedRoi / kpi.totalRequiredRoi : 0)} ${ROI_FORECAST_COVERAGE_LABEL.toLowerCase()}`}
        />
        <KpiCard
          accent="green"
          icon={TrendingUp}
          label="Actual sales"
          value={money(kpi.totalActualValue)}
          hint={`${percent(kpi.coverageRatio)} ${ROI_ACTUAL_COVERAGE_LABEL.toLowerCase()}`}
        />
        <KpiCard accent="amber" icon={TrendingDown} label="Behind" value={kpi.behindCount} hint={`${kpi.onTrackCount} on track`} />
        <KpiCard accent="sky" icon={Clock} label={ROI_RESULT_STATUS_LABEL.awaiting_data} value={kpi.awaitingDataCount} hint={`${kpi.noDataCount} ${ROI_RESULT_STATUS_LABEL.no_data.toLowerCase()}`} />
      </div>

      {/* trust signals */}
      <div className="flex flex-wrap items-center gap-2 text-phx-xs font-bold">
        <span className="inline-flex items-center gap-1 rounded-[4px] border border-phx-line bg-white px-2 py-1 text-phx-ink-2 shadow-[0_1px_1px_rgba(15,23,42,0.05)]">
          Sales data as of {kpi.salesDataAsOf ?? "—"}
        </span>
        {kpi.pendingValue > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-[4px] border border-sky-200 bg-sky-50 px-2 py-1 text-sky-700">
            {money(kpi.pendingValue)} held in pending requests
          </span>
        ) : null}
        {kpi.incompleteWindowCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-[4px] border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">
            <AlertTriangle className="h-3 w-3" />
            {kpi.incompleteWindowCount} with an incomplete ROI window
          </span>
        ) : null}
        {kpi.restrictedExcludedCount > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-[4px] border border-phx-line bg-phx-paper px-2 py-1 text-phx-ink-soft">
            {countOf(kpi.restrictedExcludedCount, "request")} with confidential products excluded
          </span>
        ) : null}
      </div>

      {/* results table */}
      <section className={`${adminPanelClassName} overflow-hidden rounded-[6px]`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line px-4 py-3 sm:px-5">
          <div>
            <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-phx-accent">ROI Report</p>
            <h3 className="text-phx-lg font-black tracking-tight text-phx-ink">Actual vs required return</h3>
          </div>
          <span className="inline-flex max-w-full flex-wrap items-center gap-x-1 rounded-[5px] border border-phx-line bg-phx-paper px-2.5 py-1 text-phx-xs font-bold text-phx-ink-soft">
            <span>{pageSummary}</span>
            {rows.length > 0 ? <span>| Page {currentPage} of {totalPages} | {ROI_ROWS_PER_PAGE} per page</span> : null}
            {sort ? <span>| Sort: {sortKeyLabel} ({sort.direction === "asc" ? "Asc" : "Desc"})</span> : null}
          </span>
        </div>
        <div className="md:hidden">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-phx-md font-medium text-phx-ink-soft">
              No requests match these filters.
            </div>
          ) : (
            <div className="space-y-2 p-3">
              {visibleRows.map((row) => <ReportCard key={row.requestId} row={row} viewSalesBasePath={viewSalesBasePath} />)}
            </div>
          )}
        </div>
        <div className="hidden md:block">
          <table className="w-full table-fixed border-collapse text-left text-phx-sm lg:text-phx-md">
            <colgroup>
              <col className="w-[18%]" />
              <col className="w-[22%]" />
              <col className="w-[15%]" />
              <col className="w-[16%]" />
              <col className="w-[12%]" />
              <col className="w-[10%]" />
              <col className="w-[7%]" />
            </colgroup>
            <thead className="bg-phx-ink text-phx-2xs font-black uppercase tracking-[0.12em] text-white">
              <tr>
                <th className="px-3 py-2.5">
                  <div className="flex flex-col items-start gap-1">
                    <button type="button" onClick={() => toggleSort("requestCode")} className="inline-flex items-center gap-1 font-black">
                      Request <span className="text-phx-2xs font-black">{sortArrow("requestCode")}</span>
                    </button>
                    <button type="button" onClick={() => toggleSort("requesterName")} className="text-left text-phx-3xs font-black text-white/70">
                      Requester {sortArrow("requesterName")}
                    </button>
                  </div>
                </th>
                <th className="px-3 py-2.5">
                  <div className="flex flex-col items-start gap-1">
                    <button type="button" onClick={() => toggleSort("customerName")} className="inline-flex items-center gap-1 font-black">
                      Customer <span className="text-phx-2xs font-black">{sortArrow("customerName")}</span>
                    </button>
                    <button type="button" onClick={() => toggleSort("line")} className="text-left text-phx-3xs font-black text-white/70">
                      Line {sortArrow("line")}
                    </button>
                  </div>
                </th>
                <th className="px-3 py-2.5">
                  <div className="flex flex-col items-start gap-1">
                    <button type="button" onClick={() => toggleSort("status")} className="inline-flex items-center gap-1 font-black">
                      Status <span className="text-phx-2xs font-black">{sortArrow("status")}</span>
                    </button>
                    <button type="button" onClick={() => toggleSort("roiWindow")} className="text-left text-phx-3xs font-black text-white/70">
                      ROI window {sortArrow("roiWindow")}
                    </button>
                  </div>
                </th>
                <th className="px-3 py-2.5 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <button type="button" onClick={() => toggleSort("requiredRoiValue")} className="inline-flex items-center justify-end gap-1 font-black">
                      Required <span className="text-phx-2xs font-black">{sortArrow("requiredRoiValue")}</span>
                    </button>
                    <button type="button" onClick={() => toggleSort("actualSalesValue")} className="text-right text-phx-3xs font-black text-white/70">
                      Actual {sortArrow("actualSalesValue")}
                    </button>
                  </div>
                </th>
                <th className="px-3 py-2.5 text-right">
                  <button type="button" onClick={() => toggleSort("actualCoverageRatio")} className="inline-flex w-full items-center justify-end gap-1 font-black">
                    Actual coverage <span className="text-phx-2xs font-black">{sortArrow("actualCoverageRatio")}</span>
                  </button>
                </th>
                <th className="px-3 py-2.5">
                  <button type="button" onClick={() => toggleSort("resultStatus")} className="inline-flex items-center gap-1 font-black">
                    Result <span className="text-phx-2xs font-black">{sortArrow("resultStatus")}</span>
                  </button>
                </th>
                <th className="px-2 py-2.5 text-right">Sales</th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-phx-md font-medium text-phx-ink-soft" colSpan={7}>
                    No requests match these filters.
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => <ReportRow key={row.requestId} row={row} viewSalesBasePath={viewSalesBasePath} />)
              )}
            </tbody>
          </table>
        </div>
        {rows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-phx-line bg-phx-paper px-4 py-3 text-phx-sm font-bold text-phx-ink-soft sm:px-5">
            <span>{pageSummary}</span>
            <div className="flex items-center gap-2">
              <span className="hidden text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint sm:inline">
                Page {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                aria-label="Previous page"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage === 1}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-phx-line bg-white text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next page"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-phx-line bg-white text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:cursor-not-allowed disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ResultStatusBadge({ row }: { row: MarketingRoiReportRow }) {
  const meta = RESULT_STATUS_META[row.resultStatus];
  return (
    <span
      className={cn("inline-flex items-center rounded-[4px] border px-2 py-0.5 text-phx-2xs font-bold uppercase tracking-wide", meta.className)}
      title={row.attributionGapReason ?? undefined}
    >
      {meta.label}
    </span>
  );
}

function ViewSalesAction({
  row,
  viewSalesBasePath,
  compact = false,
}: {
  row: MarketingRoiReportRow;
  viewSalesBasePath: string;
  compact?: boolean;
}) {
  return (
    <a
      href={`${viewSalesBasePath}/marketing-requests/${row.requestId}/view-sales`}
      target="_blank"
      rel="noopener noreferrer"
      title="View sales"
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] border border-phx-line bg-white text-phx-xs font-black text-phx-accent transition hover:border-phx-accent-line hover:bg-phx-accent-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]",
        compact ? "h-8 w-8 justify-center p-0 lg:w-auto lg:px-2" : "px-2 py-1",
      )}
    >
      <ExternalLink className="h-3 w-3 shrink-0" />
      <span className={compact ? "sr-only lg:not-sr-only" : undefined}>View Sales</span>
    </a>
  );
}

const ReportRow = React.memo(function ReportRow({ row, viewSalesBasePath }: { row: MarketingRoiReportRow; viewSalesBasePath: string }) {
  return (
    <tr className="border-t border-[#FEE7D2] align-top">
      <td className="px-3 py-3">
        <p className="break-words font-mono text-phx-sm font-bold text-phx-ink">
          {row.requestCode}
        </p>
        <p className="mt-1 break-words text-phx-xs font-semibold leading-4 text-phx-ink-soft">
          {row.requesterName ?? "—"}
        </p>
      </td>
      <td className="px-3 py-3">
        <p className="break-words font-semibold leading-5 text-phx-ink-2" title={row.customerName}>
          {row.customerName}
        </p>
        <p className="mt-1 break-words text-phx-xs font-bold uppercase tracking-[0.08em] text-phx-ink-faint">
          {row.line ?? "—"}
        </p>
      </td>
      <td className="px-3 py-3">
        <p className="break-words font-semibold text-phx-ink-2">{STATUS_LABELS[row.status] ?? requestStatusLabel(row.status)}</p>
        <p className="mt-1 break-words text-phx-xs font-medium text-phx-ink-faint">{row.roiWindow ?? "—"}</p>
      </td>
      <td className="px-3 py-3 text-right">
        <div className="space-y-1">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Required (target)</p>
          <p className="font-semibold text-phx-ink-2">{money(row.requiredRoiValue)}</p>
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Expected (forecast)</p>
          <p className="font-medium text-phx-ink-soft">{money(row.expectedRoiValue)}</p>
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Actual</p>
          <p className="font-bold text-phx-ink">{money(row.actualSalesValue)}</p>
        </div>
      </td>
      <td className="px-3 py-3 text-right">
        <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Actual</p>
        <p className="font-bold text-phx-ink">{row.hasSalesData ? percent(row.actualCoverageRatio) : "No attributed sales"}</p>
        <p className="mt-1 text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Forecast</p>
        <p className="font-medium text-phx-ink-soft">{percent(row.forecastCoverageRatio)}</p>
        {row.dataCoverage !== "complete" ? (
          <p className="mt-1 break-words text-phx-2xs font-bold leading-4 text-amber-600">{ROI_DATA_COVERAGE_LABEL[row.dataCoverage]}</p>
        ) : null}
        {row.attributionGapReason ? <p className="mt-1 break-words text-phx-2xs font-medium leading-4 text-phx-ink-faint">{row.attributionGapReason}</p> : null}
      </td>
      <td className="px-3 py-2.5">
        <ResultStatusBadge row={row} />
      </td>
      <td className="px-2 py-3 text-right">
        <ViewSalesAction row={row} viewSalesBasePath={viewSalesBasePath} compact />
      </td>
    </tr>
  );
});

const ReportCard = React.memo(function ReportCard({ row, viewSalesBasePath }: { row: MarketingRoiReportRow; viewSalesBasePath: string }) {
  return (
    <article className={`${adminPanelClassName} rounded-[6px] p-3`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-mono text-phx-sm font-bold text-phx-ink">
            {row.requestCode}
          </p>
          <h4 className="mt-1 break-words text-phx-md font-black leading-5 text-phx-ink-2">{row.customerName}</h4>
          {row.requesterName ? <p className="mt-1 break-words text-phx-xs font-semibold text-phx-ink-soft">{row.requesterName}</p> : null}
        </div>
        <ResultStatusBadge row={row} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-phx-sm">
        <div className="rounded-[5px] bg-phx-paper px-2.5 py-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Required (target)</p>
          <p className="mt-0.5 font-bold text-phx-ink-2">{money(row.requiredRoiValue)}</p>
        </div>
        <div className="rounded-[5px] bg-phx-paper px-2.5 py-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Expected (forecast)</p>
          <p className="mt-0.5 font-bold text-phx-ink-soft">{money(row.expectedRoiValue)}</p>
        </div>
        <div className="rounded-[5px] bg-phx-paper px-2.5 py-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Actual sales</p>
          <p className="mt-0.5 font-bold text-phx-ink">{money(row.actualSalesValue)}</p>
        </div>
        <div className="rounded-[5px] bg-phx-paper px-2.5 py-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Actual coverage</p>
          <p className="mt-0.5 font-bold text-phx-ink">{row.hasSalesData ? percent(row.actualCoverageRatio) : "No attributed sales"}</p>
          <p className="mt-0.5 text-phx-2xs font-bold text-phx-ink-faint">Forecast {percent(row.forecastCoverageRatio)}</p>
        </div>
        <div className="rounded-[5px] bg-phx-paper px-2.5 py-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Window</p>
          <p className="mt-0.5 break-words font-bold text-phx-ink-soft">{row.roiWindow ?? "—"}</p>
        </div>
        <div className="rounded-[5px] bg-phx-paper px-2.5 py-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Data coverage</p>
          <p className={cn("mt-0.5 break-words font-bold", row.dataCoverage === "complete" ? "text-phx-ink-soft" : "text-amber-600")}>{ROI_DATA_COVERAGE_LABEL[row.dataCoverage]}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="break-words text-phx-xs font-semibold text-phx-ink-soft">
          {[STATUS_LABELS[row.status] ?? requestStatusLabel(row.status), row.line].filter(Boolean).join(" / ")}
        </p>
        <ViewSalesAction row={row} viewSalesBasePath={viewSalesBasePath} />
      </div>
      {row.attributionGapReason ? <p className="mt-2 break-words text-phx-xs font-medium leading-4 text-phx-ink-faint">{row.attributionGapReason}</p> : null}
    </article>
  );
});
