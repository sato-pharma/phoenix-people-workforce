"use client";

import * as React from "react";
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
import {
  emptyMarketingCoverageFilterState,
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

        const fallbackDefault = presetList.find((preset) => preset.isDefault);
        if (fallbackDefault) {
          startFilterTransition(() => setFilters(fallbackDefault.filters));
          void runReport(fallbackDefault.filters);
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

        {/* ── Premium KPI band ─────────────────────────────────────────────── */}
        {kpi ? (
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <CoverageKpiCard tone="slate" icon={<PackageSearch className="h-5 w-5" />} label="Requests" value={kpi.requestCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="orange" icon={<CircleDollarSign className="h-5 w-5" />} label="Total cost (EGP)" value={money(kpi.totalEstimatedCost)} />
            <CoverageKpiCard tone="orange" icon={<Target className="h-5 w-5" />} label="Required ROI (EGP)" value={money(kpi.totalRequiredRoi)} />
            <CoverageKpiCard tone="emerald" icon={<TrendingUp className="h-5 w-5" />} label="Actual sales (EGP)" value={money(kpi.totalActualValue)} />
            <CoverageKpiCard tone="blue" icon={<Filter className="h-5 w-5" />} label="Coverage" value={percent(kpi.coverageRatio)} />
            <CoverageKpiCard tone="emerald" icon={<CheckCircle2 className="h-5 w-5" />} label="On track" value={kpi.onTrackCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="amber" icon={<AlertTriangle className="h-5 w-5" />} label="Behind" value={kpi.behindCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="slate" icon={<CircleSlash className="h-5 w-5" />} label="No data" value={kpi.noDataCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="violet" icon={<Building2 className="h-5 w-5" />} label="Distinct pharmacies" value={kpi.distinctPharmacyCount.toLocaleString("en-US")} />
            <CoverageKpiCard tone="violet" icon={<Users2 className="h-5 w-5" />} label="Distinct customers" value={kpi.distinctCustomerCount.toLocaleString("en-US")} />
          </section>
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
                      <th className="px-3 py-2.5">Request</th>
                      <th className="px-3 py-2.5">Requester</th>
                      <th className="px-3 py-2.5">Line / Region / Area</th>
                      <th className="px-3 py-2.5">Customer</th>
                      <th className="px-3 py-2.5">Status</th>
                      <th className="px-3 py-2.5">Pay date</th>
                      <th className="px-3 py-2.5 text-right">Cost</th>
                      <th className="px-3 py-2.5 text-right">Required</th>
                      <th className="px-3 py-2.5 text-right">Actual</th>
                      <th className="px-3 py-2.5 text-right">Coverage</th>
                      <th className="px-3 py-2.5">Result</th>
                      <th className="px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <RequestAccordionRow
                        key={row.requestId}
                        row={row}
                        expanded={expandedRequestId === row.requestId}
                        onToggle={() => setExpandedRequestId((current) => (current === row.requestId ? null : row.requestId))}
                        isSuperAdmin={isSuperAdmin}
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

function RequestAccordionRow({
  row,
  expanded,
  onToggle,
  isSuperAdmin,
}: {
  row: MarketingCoverageReportRow;
  expanded: boolean;
  onToggle: () => void;
  isSuperAdmin: boolean;
}) {
  const [pharmacies, setPharmacies] = React.useState<MarketingCoveragePharmacyRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!expanded || pharmacies !== null || loading) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/marketing-requests/coverage-report/${encodeURIComponent(row.requestId)}/pharmacies`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message ?? "Unable to load target pharmacies.");
        if (!cancelled) setPharmacies((payload.pharmacies ?? []) as MarketingCoveragePharmacyRow[]);
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
