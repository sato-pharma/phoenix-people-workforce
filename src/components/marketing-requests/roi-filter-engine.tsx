"use client";

import * as React from "react";
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  Filter,
  Link2,
  RefreshCcw,
  Save,
  Search,
  SlidersHorizontal,
  Star,
  Target,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
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
import { cn } from "@/lib/utils";

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(value: number) {
  return moneyFormatter.format(Math.round(Number.isFinite(value) ? value : 0));
}

function percent(ratio: number) {
  return `${Math.round((Number.isFinite(ratio) ? ratio : 0) * 100)}%`;
}

const RESULT_STATUS_META: Record<MarketingRoiResultStatus, { label: string; className: string }> = {
  on_track: { label: "On track", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  behind: { label: "Behind", className: "border-amber-200 bg-amber-50 text-amber-700" },
  awaiting_data: { label: "Awaiting data", className: "border-sky-200 bg-sky-50 text-sky-700" },
  no_data: { label: "No data", className: "border-slate-200 bg-slate-50 text-slate-500" },
};

const ROI_STATUS_OPTIONS: Array<{ value: MarketingRoiResultStatus; label: string }> = [
  { value: "on_track", label: "On track" },
  { value: "behind", label: "Behind" },
  { value: "awaiting_data", label: "Awaiting data" },
  { value: "no_data", label: "No data" },
];

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

// ── include-only multiselect, matching the sales filter visual language ───────
function RoiMultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string; count?: number }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = React.useState("");
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? options.filter((option) => option.label.toLowerCase().includes(normalized) || option.value.toLowerCase().includes(normalized))
    : options;
  const summary = selected.length === 0 ? "All" : `${selected.length} selected`;

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <details className="group relative">
      <summary className="flex h-[58px] cursor-pointer list-none items-center justify-between gap-3 rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm outline-none transition hover:border-[#FDBA74] focus-visible:border-[#FDBA74] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">{label}</span>
          <span className="flex items-center gap-1.5">
            <span className="block truncate text-sm font-black text-[#0F172A]">{summary}</span>
            {selected.length > 0 ? (
              <span className="shrink-0 rounded-[3px] bg-[#F97316] px-1 text-[9px] font-black uppercase tracking-wide text-white">incl</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[#94A3B8] transition group-open:rotate-180" />
      </summary>

      <div className="absolute left-0 top-full z-30 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-[6px] border border-[#E2E8F0] bg-white shadow-lg">
        <div className="flex items-center justify-end gap-2 border-b border-[#E2E8F0] p-2 text-[11px] font-black">
          <button type="button" className="text-[#64748B] transition hover:text-[#F97316]" onClick={() => onChange(options.map((option) => option.value))}>
            All
          </button>
          <span className="text-[#E2E8F0]">|</span>
          <button
            type="button"
            className="text-[#64748B] transition hover:text-[#F97316] disabled:opacity-40"
            disabled={selected.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </button>
        </div>
        <div className="border-b border-[#E2E8F0] p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 w-full rounded-[5px] border border-[#E2E8F0] bg-white pl-8 pr-7 text-sm font-medium text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/10"
            />
            {query ? (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94A3B8] transition hover:text-[#F97316]">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs font-semibold text-[#94A3B8]">{options.length === 0 ? "No options." : "No matches."}</p>
          ) : (
            visible.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm text-[#0F172A] transition hover:bg-[#F8FAFC]">
                <input type="checkbox" className="h-4 w-4 accent-[#F97316]" checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} />
                <span className="flex-1 truncate">{option.label}</span>
                {typeof option.count === "number" ? <span className="shrink-0 text-[11px] font-bold text-[#94A3B8]">{option.count}</span> : null}
              </label>
            ))
          )}
        </div>
      </div>
    </details>
  );
}

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
    orange: "border-l-[#F97316]",
  }[accent];
  const iconColor = {
    slate: "text-slate-600",
    green: "text-emerald-600",
    amber: "text-amber-600",
    sky: "text-sky-600",
    orange: "text-[#F97316]",
  }[accent];
  return (
    <div className={cn("rounded-[6px] border border-[#E2E8F0] border-l-[3px] bg-white px-3.5 py-3 shadow-sm", border)}>
      <div className="flex items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">{label}</p>
      </div>
      <p className="mt-1.5 text-[22px] font-black leading-none text-[#0F172A]">{value}</p>
      {hint ? <p className="mt-1 text-[11px] font-semibold text-[#94A3B8]">{hint}</p> : null}
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
        const response = await fetch("/api/marketing-requests/roi-tracking/filter-options", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setOptionsError(payload.message ?? "Unable to load filters.");
          return;
        }
        setFacets(payload as MarketingRoiFilterFacets);

        // Load saved presets (best-effort) and auto-apply the default when the URL is empty.
        let presetList: MarketingRoiPreset[] = [];
        try {
          const presetResponse = await fetch("/api/marketing-requests/roi-tracking/presets", { cache: "no-store" });
          if (presetResponse.ok) {
            const presetPayload = await presetResponse.json();
            presetList = (presetPayload.presets ?? []) as MarketingRoiPreset[];
            if (!cancelled) setPresets(presetList);
          }
        } catch {
          // presets are optional
        }

        if (hasUrl) {
          setFilters(urlFilters);
          void runReport(urlFilters);
        } else {
          const fallbackDefault = presetList.find((preset) => preset.isDefault);
          if (fallbackDefault) {
            setFilters(fallbackDefault.filters);
            void runReport(fallbackDefault.filters);
          }
        }
      } catch {
        if (!cancelled) setOptionsError("Unable to load filters.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshPresets() {
    try {
      const response = await fetch("/api/marketing-requests/roi-tracking/presets", { cache: "no-store" });
      if (response.ok) setPresets(((await response.json()).presets ?? []) as MarketingRoiPreset[]);
    } catch {
      // ignore
    }
  }

  function applyPreset(preset: MarketingRoiPreset) {
    setFilters(preset.filters);
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
    setFilters((prev) => {
      const next = withRoiFilterValues(prev, key, values);
      // `key` is the anchor — preserve the user's just-made choice, fit the others to it.
      return facets ? pruneRoiFilterState(facets.entries, next, key) : next;
    });
  }

  // Patch scalar/range/toggle filters and auto-fit the multi-selects (a narrower date
  // or duration range can make a previously-chosen DM/product impossible).
  function patchFilters(patch: Partial<RoiFilterState>) {
    setFilters((prev) => {
      const next = { ...prev, ...patch } as RoiFilterState;
      return facets ? pruneRoiFilterState(facets.entries, next) : next;
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
        <section className="rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-[#F97316]" />
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#F97316]">Filter Engine</p>
                <h2 className="text-[15px] font-black tracking-tight text-[#0F172A]">Build your ROI report</h2>
              </div>
            </div>
            {faceted ? (
              <span className="inline-flex items-center gap-1.5 rounded-[5px] border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#64748B]">
                <Filter className="h-3 w-3" />
                {faceted.matchedCount === faceted.totalCount
                  ? `${faceted.totalCount} request${faceted.totalCount === 1 ? "" : "s"} in scope`
                  : `${faceted.matchedCount} of ${faceted.totalCount} match`}
              </span>
            ) : null}
          </div>

          <div className="p-4 sm:p-5">
            {optionsError ? (
              <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{optionsError}</div>
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

                  {/* ROI status — always meaningful (fixed enum) */}
                  <RoiMultiSelect
                    label="ROI status"
                    options={ROI_STATUS_OPTIONS}
                    selected={filters.roiStatus}
                    onChange={(values) => setFilters((prev) => ({ ...prev, roiStatus: values as MarketingRoiResultStatus[] }))}
                  />

                  {/* ROI duration range */}
                  {durationDim?.render ? (
                    <div className="rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">ROI duration (months)</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={durationDim.min}
                          max={durationDim.max}
                          placeholder={String(durationDim.min ?? "")}
                          value={filters.durationMin ?? ""}
                          onChange={(event) => patchFilters({ durationMin: event.target.value === "" ? null : Number(event.target.value) })}
                          className="h-8 w-full rounded-[5px] border border-[#E2E8F0] px-2 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                        <span className="text-[#94A3B8]">–</span>
                        <input
                          type="number"
                          min={durationDim.min}
                          max={durationDim.max}
                          placeholder={String(durationDim.max ?? "")}
                          value={filters.durationMax ?? ""}
                          onChange={(event) => patchFilters({ durationMax: event.target.value === "" ? null : Number(event.target.value) })}
                          className="h-8 w-full rounded-[5px] border border-[#E2E8F0] px-2 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                      </div>
                    </div>
                  ) : null}

                  {/* Pay date range */}
                  {payDateDim?.render ? (
                    <div className="rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm">
                      <p className="mb-1 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">Pay date</p>
                      <div className="flex items-center gap-2">
                        <input
                          type="date"
                          value={filters.payDateFrom ?? ""}
                          onChange={(event) => patchFilters({ payDateFrom: event.target.value || null })}
                          className="h-8 w-full rounded-[5px] border border-[#E2E8F0] px-2 text-[12px] font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                        <span className="text-[#94A3B8]">–</span>
                        <input
                          type="date"
                          value={filters.payDateTo ?? ""}
                          onChange={(event) => patchFilters({ payDateTo: event.target.value || null })}
                          className="h-8 w-full rounded-[5px] border border-[#E2E8F0] px-2 text-[12px] font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Auto-applied (single-value) dimensions — shown read-only */}
                {autoAppliedDimensions().length > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-[#94A3B8]">Scope:</span>
                    {autoAppliedDimensions().map((dim) => (
                      <span key={dim.key} className="inline-flex items-center gap-1 rounded-[4px] border border-[#E2E8F0] bg-[#F8FAFC] px-2 py-1 text-[11px] font-bold text-[#475569]">
                        {dim.label}: {dim.options.find((option) => option.value === dim.autoApplied?.[0])?.label ?? dim.autoApplied?.[0]}
                      </span>
                    ))}
                  </div>
                ) : null}

                {/* Confidential toggle */}
                {restrictedDim?.render ? (
                  <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-[5px] border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] font-bold text-amber-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#F97316]"
                      checked={filters.includeRestricted}
                      onChange={(event) => setFilters((prev) => ({ ...prev, includeRestricted: event.target.checked }))}
                    />
                    Include confidential products (LA003 / LA004 / SS001)
                  </label>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runReport(filters)}
                    disabled={state === "loading"}
                    className="inline-flex items-center gap-2 rounded-[6px] bg-[#F97316] px-4 py-2 text-[13px] font-black uppercase tracking-wide text-white shadow-sm transition hover:bg-[#EA580C] disabled:opacity-60"
                  >
                    {state === "loading" ? <LoadingSpinner /> : <Filter className="h-3.5 w-3.5" />}
                    Apply Filters
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFilters(emptyRoiFilterState());
                      setReport(null);
                      setState("ready");
                      window.history.replaceState(null, "", window.location.pathname);
                    }}
                    className="inline-flex items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316]"
                  >
                    <RefreshCcw className="h-3.5 w-3.5" /> Reset
                  </button>
                  {hasReport ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void downloadExport()}
                        disabled={exporting}
                        className="inline-flex items-center gap-2 rounded-[6px] border border-[#0F172A] bg-[#0F172A] px-3 py-2 text-[12px] font-black uppercase tracking-wide text-white transition hover:bg-black disabled:opacity-60"
                      >
                        {exporting ? <LoadingSpinner /> : <Download className="h-3.5 w-3.5" />} Export XLSX
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyShareLink()}
                        className="inline-flex items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316]"
                      >
                        <Link2 className="h-3.5 w-3.5" /> {copied ? "Copied!" : "Copy share link"}
                      </button>
                    </>
                  ) : null}
                </div>

                {/* Saved presets */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#F1F5F9] pt-3">
                  <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">
                    <Bookmark className="h-3.5 w-3.5" /> Presets
                  </span>
                  {presets.map((preset) => (
                    <span key={preset.id} className="inline-flex items-center gap-1 rounded-[5px] border border-[#E2E8F0] bg-white pl-2 text-[12px] font-bold text-[#475569]">
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
                      className="h-8 w-40 rounded-[5px] border border-[#E2E8F0] px-2 text-[12px] font-medium text-[#0F172A] outline-none focus:border-[#FDBA74]"
                    />
                    <button
                      type="button"
                      onClick={() => void savePreset(false)}
                      disabled={savingPreset || !presetName.trim()}
                      className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-[#E2E8F0] bg-white px-2 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-40"
                    >
                      <Save className="h-3.5 w-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={() => void savePreset(true)}
                      disabled={savingPreset || !presetName.trim()}
                      title="Save as my default view"
                      className="inline-flex h-8 items-center gap-1 rounded-[5px] border border-[#E2E8F0] bg-white px-2 text-[12px] font-bold text-[#64748B] transition hover:border-[#FDBA74] hover:text-[#F97316] disabled:opacity-40"
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
          <div className="rounded-[6px] border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] font-semibold text-amber-800">{reportError}</div>
        ) : null}

        {hasReport && report ? <ReportView report={report} viewSalesBasePath={viewSalesBasePath} /> : null}

        {state === "ready" && facets ? (
          <div className="rounded-[6px] border border-dashed border-[#E2E8F0] bg-[#F8FAFC] px-4 py-10 text-center">
            <Filter className="mx-auto h-6 w-6 text-[#CBD5E1]" />
            <p className="mt-2 text-[13px] font-bold text-[#64748B]">Choose your filters and press “Apply Filters”.</p>
            <p className="mt-1 text-[12px] font-medium text-[#94A3B8]">Nothing loads until you apply — so the report is fast and scoped to exactly what you ask for.</p>
          </div>
        ) : null}
      </div>
    </WorkspaceErrorBoundary>
  );
}

function ReportView({ report, viewSalesBasePath }: { report: MarketingRoiReport; viewSalesBasePath: string }) {
  const { kpi, rows } = report;
  return (
    <div className="space-y-4">
      {/* KPI band */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard accent="slate" icon={Target} label="Requests" value={kpi.requestCount} />
        <KpiCard accent="orange" icon={TrendingUp} label="Cost" value={money(kpi.totalEstimatedCost)} />
        <KpiCard accent="sky" icon={Target} label="Required ROI" value={money(kpi.totalRequiredRoi)} />
        <KpiCard
          accent="green"
          icon={TrendingUp}
          label="Actual sales"
          value={money(kpi.totalActualValue)}
          hint={`${percent(kpi.coverageRatio)} of required`}
        />
        <KpiCard accent="amber" icon={TrendingDown} label="Behind" value={kpi.behindCount} hint={`${kpi.onTrackCount} on track`} />
        <KpiCard accent="sky" icon={Clock} label="Awaiting data" value={kpi.awaitingDataCount} hint={`${kpi.noDataCount} no data`} />
      </div>

      {/* trust signals */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
        <span className="inline-flex items-center gap-1 rounded-[4px] border border-[#E2E8F0] bg-white px-2 py-1 text-[#475569]">
          Sales data as of {kpi.salesDataAsOf ?? "n/a"}
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
          <span className="inline-flex items-center gap-1 rounded-[4px] border border-[#E2E8F0] bg-[#F8FAFC] px-2 py-1 text-[#64748B]">
            {kpi.restrictedExcludedCount} request(s) with confidential products excluded
          </span>
        ) : null}
      </div>

      {/* results table */}
      <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-3 sm:px-5">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#F97316]">ROI Report</p>
            <h3 className="text-[15px] font-black tracking-tight text-[#0F172A]">Actual vs required return</h3>
          </div>
          <span className="inline-flex items-center rounded-[5px] border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#64748B]">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] border-collapse text-left text-[13px]">
            <thead className="bg-[#0F172A] text-[10px] font-black uppercase tracking-[0.12em] text-white">
              <tr>
                <th className="px-3 py-2.5">Request</th>
                <th className="px-3 py-2.5">Requester</th>
                <th className="px-3 py-2.5">Line</th>
                <th className="px-3 py-2.5">Customer</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">ROI window</th>
                <th className="px-3 py-2.5 text-right">Required</th>
                <th className="px-3 py-2.5 text-right">Actual</th>
                <th className="px-3 py-2.5 text-right">Coverage</th>
                <th className="px-3 py-2.5">Result</th>
                <th className="px-3 py-2.5 text-right">Sales</th>
              </tr>
            </thead>
            <tbody className="bg-white">
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-center text-[13px] font-medium text-[#64748B]" colSpan={11}>
                    No requests match these filters.
                  </td>
                </tr>
              ) : (
                rows.map((row) => <ReportRow key={row.requestId} row={row} viewSalesBasePath={viewSalesBasePath} />)
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ReportRow({ row, viewSalesBasePath }: { row: MarketingRoiReportRow; viewSalesBasePath: string }) {
  const meta = RESULT_STATUS_META[row.resultStatus];
  return (
    <tr className="border-t border-[#FEE7D2]">
      <td className="px-3 py-2.5 font-mono text-[12px] font-bold text-[#0F172A]">{row.requestCode}</td>
      <td className="px-3 py-2.5 font-semibold text-[#334155]">{row.requesterName ?? row.requesterHrId}</td>
      <td className="px-3 py-2.5 font-medium text-[#64748B]">{row.line ?? "—"}</td>
      <td className="px-3 py-2.5 font-semibold text-[#334155]">{row.customerName}</td>
      <td className="px-3 py-2.5 font-medium text-[#64748B]">{STATUS_LABELS[row.status] ?? row.status}</td>
      <td className="px-3 py-2.5 font-medium text-[#64748B]">{row.roiWindow ?? "—"}</td>
      <td className="px-3 py-2.5 text-right font-semibold text-[#475569]">{money(row.requiredRoiValue)}</td>
      <td className="px-3 py-2.5 text-right font-bold text-[#0F172A]">{money(row.actualSalesValue)}</td>
      <td className="px-3 py-2.5 text-right font-bold text-[#0F172A]">{row.hasSalesData ? percent(row.actualCoverageRatio) : "—"}</td>
      <td className="px-3 py-2.5">
        <span
          className={cn("inline-flex items-center rounded-[4px] border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", meta.className)}
          title={row.attributionGapReason ?? undefined}
        >
          {meta.label}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right">
        <a
          href={`${viewSalesBasePath}/marketing-requests/${row.requestId}/view-sales`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-[5px] border border-[#E2E8F0] bg-white px-2 py-1 text-[11px] font-black text-[#F97316] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
        >
          <ExternalLink className="h-3 w-3" /> View Sales
        </a>
      </td>
    </tr>
  );
}
