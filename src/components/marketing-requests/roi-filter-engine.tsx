"use client";

import * as React from "react";
import { Bookmark, Download, Filter, Link2, RefreshCcw, Save, SlidersHorizontal, Star, Trash2 } from "lucide-react";

import { LoadingSpinner } from "@/components/ui/loading-state";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { RoiMultiSelect } from "@/components/marketing-requests/roi-multi-select";
import { RoiReportView } from "@/components/marketing-requests/roi-report-panels";
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
  type MarketingRoiResultStatus,
  type RoiFilterDimension,
  type RoiFilterKey,
  type RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";
import { ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import {
  roiConfidentialToggleLabel,
  roiRunAllLabel,
  roiScopeLine,
  roiStatusWords,
} from "@/lib/marketing-requests/roi-tracking-summary";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";

/**
 * ROI Tracking's Filter Engine — both shells mount it (the admin page, and the portal page a Regional Sales Manager
 * opens from My Team's Reports). Filter first, then the report (`roi-report-panels.tsx`). Premium pass, 9 Nov 2026:
 * every word comes from `roi-tracking-summary.ts`; a viewer with nothing chosen yet can show everything in scope in
 * one press, which is the server's own role scope and never wider.
 */

// The four result VALUES are the filter contract (on_track / behind / awaiting_data / no_data); only their labels
// come from the shared roi-labels source of truth.
const ROI_STATUS_OPTIONS: Array<{ value: MarketingRoiResultStatus; label: string }> = [
  { value: "on_track", label: ROI_RESULT_STATUS_LABEL.on_track },
  { value: "behind", label: ROI_RESULT_STATUS_LABEL.behind },
  { value: "awaiting_data", label: ROI_RESULT_STATUS_LABEL.awaiting_data },
  { value: "no_data", label: ROI_RESULT_STATUS_LABEL.no_data },
];

const FIELD_LABEL = "mb-1 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint";

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

  function runAllInScope() {
    const empty = emptyRoiFilterState();
    startFilterTransition(() => setFilters(empty));
    void runReport(empty);
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
        <section className={adminPanelClassName}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-phx-line px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-phx-accent" />
              <div>
                <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-accent">Filter Engine</p>
                <h2 className="text-phx-lg font-black tracking-tight text-phx-ink">Build your ROI report</h2>
              </div>
            </div>
            {faceted ? (
              <span className="inline-flex items-center gap-1.5 border border-phx-line bg-phx-paper px-2.5 py-1 text-phx-xs font-bold text-phx-ink-soft">
                <Filter aria-hidden className="h-3 w-3" />
                {roiScopeLine(faceted.matchedCount, faceted.totalCount)}
              </span>
            ) : null}
          </div>

          <div className="p-4 sm:p-5">
            {optionsError ? (
              <div className="border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800" role="alert">{optionsError}</div>
            ) : !facets ? (
              <div className="flex items-center gap-2 py-6 text-phx-md font-semibold text-phx-ink-soft">
                <LoadingSpinner /> Loading the filters
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
                        label: dim.key === "status" ? roiStatusWords(option.value) : option.label,
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
                    <div className={cn(adminSoftPanelClassName, "px-3 py-2")}>
                      <p className={FIELD_LABEL}>ROI duration (months)</p>
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
                    <div className={cn(adminSoftPanelClassName, "px-3 py-2")}>
                      <p className={FIELD_LABEL}>Pay date</p>
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
                      <span className="text-phx-xs font-bold uppercase tracking-wide text-phx-ink-faint">Applied for you:</span>
                      {autoChips.map(({ dim, label }) => (
                        <span key={dim.key} className="inline-flex items-center gap-1 border border-phx-line bg-phx-paper px-2 py-1 text-phx-xs font-bold text-phx-ink-2">
                          {dim.label}: {label}
                        </span>
                      ))}
                    </div>
                  );
                })()}

                {/* Confidential toggle */}
                {restrictedDim?.render ? (
                  <label className="mt-3 inline-flex cursor-pointer items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-1.5 text-phx-sm font-bold text-amber-800">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-phx-accent"
                      checked={filters.includeRestricted}
                      onChange={(event) => startFilterTransition(() => setFilters((prev) => ({ ...prev, includeRestricted: event.target.checked })))}
                    />
                    {roiConfidentialToggleLabel()}
                  </label>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runReport(filters)}
                    disabled={state === "loading" || !roiFilterStateHasAny(filters)}
                    className="inline-flex items-center gap-2 bg-phx-accent px-4 py-2 text-phx-md font-black uppercase tracking-wide text-white shadow-sm transition hover:bg-phx-accent-hover disabled:opacity-60"
                  >
                    {state === "loading" ? <LoadingSpinner /> : <Filter aria-hidden className="h-3.5 w-3.5" />}
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
                    className="inline-flex items-center gap-2 border border-phx-line bg-white px-3 py-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
                  >
                    <RefreshCcw aria-hidden className="h-3.5 w-3.5" /> Reset
                  </button>
                  {!roiFilterStateHasAny(filters) && faceted && faceted.totalCount > 0 ? (
                    <button
                      type="button"
                      onClick={() => runAllInScope()}
                      disabled={state === "loading"}
                      className="inline-flex items-center gap-2 border border-phx-accent-line bg-white px-3 py-2 text-phx-sm font-black text-phx-accent transition hover:bg-phx-accent-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] disabled:opacity-60 disabled:shadow-none"
                    >
                      {roiRunAllLabel(faceted.totalCount)}
                    </button>
                  ) : null}
                  {!roiFilterStateHasAny(filters) ? (
                    <span className="text-phx-sm font-medium text-phx-ink-faint">Choose a filter, or show everything you can see.</span>
                  ) : null}
                  {hasReport ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void downloadExport()}
                        disabled={exporting}
                        className="inline-flex items-center gap-2 border border-phx-ink bg-phx-ink px-3 py-2 text-phx-sm font-black uppercase tracking-wide text-white transition hover:bg-black disabled:opacity-60"
                      >
                        {exporting ? <LoadingSpinner /> : <Download aria-hidden className="h-3.5 w-3.5" />} Download Excel
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyShareLink()}
                        className="inline-flex items-center gap-2 border border-phx-line bg-white px-3 py-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
                      >
                        <Link2 aria-hidden className="h-3.5 w-3.5" /> {copied ? "Link copied" : "Copy share link"}
                      </button>
                    </>
                  ) : null}
                </div>

                {/* Saved presets */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-phx-paper-2 pt-3">
                  <span className="inline-flex items-center gap-1 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">
                    <Bookmark aria-hidden className="h-3.5 w-3.5" /> Saved views
                  </span>
                  {presets.map((preset) => (
                    <span key={preset.id} className="inline-flex items-center gap-1 border border-phx-line bg-white pl-2 text-phx-sm font-bold text-phx-ink-2 shadow-[0_1px_1px_rgba(15,23,42,0.05)]">
                      {preset.isDefault ? <Star aria-label="Your default view" className="h-3 w-3 fill-phx-accent text-phx-accent" /> : null}
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
                      placeholder="Name this view"
                      aria-label="Name this view"
                      className={cn(phxFieldClassName, "w-40")}
                    />
                    <button
                      type="button"
                      onClick={() => void savePreset(false)}
                      disabled={savingPreset || !presetName.trim()}
                      className="inline-flex h-8 items-center gap-1 border border-phx-line bg-white px-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
                    >
                      <Save className="h-3.5 w-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={() => void savePreset(true)}
                      disabled={savingPreset || !presetName.trim()}
                      title="Save as my default view"
                      className="inline-flex h-8 items-center gap-1 border border-phx-line bg-white px-2 text-phx-sm font-bold text-phx-ink-soft transition hover:border-phx-accent-line hover:text-phx-accent disabled:opacity-40 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)] disabled:shadow-none"
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
          <div className="border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-phx-md font-semibold text-amber-800" role="alert">{reportError}</div>
        ) : null}

        {hasReport && report ? <RoiReportView key={report.generatedAtIso} report={report} viewSalesBasePath={viewSalesBasePath} /> : null}

        {state === "ready" && facets ? (
          <div className={cn(adminSoftPanelClassName, "border-dashed px-4 py-10 text-center")}>
            <Filter aria-hidden className="mx-auto h-6 w-6 text-phx-line-strong" />
            <p className="mt-2 text-phx-md font-bold text-phx-ink-soft">Choose your filters and press “Apply Filters”.</p>
            <p className="mt-1 text-phx-sm font-medium text-phx-ink-faint">
              {faceted && faceted.totalCount > 0
                ? `Or press “${roiRunAllLabel(faceted.totalCount)}” to read every request you can see.`
                : "No request is in your scope yet."}
            </p>
          </div>
        ) : null}
      </div>
    </WorkspaceErrorBoundary>
  );
}
