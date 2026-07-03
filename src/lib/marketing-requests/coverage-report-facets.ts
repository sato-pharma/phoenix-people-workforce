import type {
  CoverageFilterDimension,
  MarketingCoverageFilterKey,
  MarketingCoverageFilterState,
  MarketingCoverageRequestIndexEntry,
  RoiFilterOption,
} from "@/lib/marketing-requests/roi-report-types";

// ─────────────────────────────────────────────────────────────────────────────
// Smart, cascading (faceted) filter options for the Marketing Coverage Report.
//
// Pure + client-safe. Mirrors roi-facets.ts exactly, plus 2 extra dimensions
// (area, requesterTier). Kept as a SEPARATE module (not a union-edit of
// roi-facets.ts) because MarketingCoverageFilterKey is a superset of
// RoiFilterKey — sharing one cascade function across both key types would force
// every ROI Tracking call site to pass area/requesterTier they don't have.
// ─────────────────────────────────────────────────────────────────────────────

type ValueLabel = { value: string; label: string };

type MultiselectSpec = {
  key: MarketingCoverageFilterKey;
  label: string;
  extract: (entry: MarketingCoverageRequestIndexEntry) => ValueLabel[];
};

const pair = (value: string | null | undefined, label: string | null | undefined): ValueLabel[] => {
  const v = (value ?? "").trim();
  return v ? [{ value: v, label: (label ?? v) || v }] : [];
};

/** Broadest-scope-first: management chain, then the requester's own tier, then
 *  geography, then the operational dimensions. */
const MULTISELECT_SPECS: MultiselectSpec[] = [
  { key: "nsm", label: "National Sales Manager", extract: (e) => pair(e.nsmHrId, e.nsmName) },
  { key: "rsm", label: "Regional Manager", extract: (e) => pair(e.rsmHrId, e.rsmName) },
  { key: "dm", label: "District Manager", extract: (e) => pair(e.dmHrId, e.dmName) },
  { key: "requester", label: "Requester", extract: (e) => pair(e.requesterHrId, e.requesterName) },
  { key: "requesterTier", label: "Requester tier", extract: (e) => pair(e.requesterTier, e.requesterTier) },
  { key: "line", label: "Line", extract: (e) => pair(e.lineName, e.lineName) },
  { key: "region", label: "Region", extract: (e) => pair(e.regionName, e.regionName) },
  { key: "area", label: "Area", extract: (e) => pair(e.areaName, e.areaName) },
  { key: "approvedBy", label: "Approved by", extract: (e) => e.approverRoleKeys.map((r) => ({ value: r, label: r })) },
  { key: "distributor", label: "Distributor", extract: (e) => e.distributorCodes.map((c) => ({ value: c, label: c })) },
  { key: "product", label: "Product", extract: (e) => e.productCodes.map((c, i) => ({ value: c, label: e.productNames[i] ?? c })) },
  { key: "pharmacy", label: "Target pharmacy", extract: (e) => e.pharmacyKeys.map((k, i) => ({ value: k, label: e.pharmacyNames[i] ?? k })) },
  { key: "requestType", label: "Request type", extract: (e) => (e.requestTypeId ? [{ value: String(e.requestTypeId), label: e.requestTypeName ?? `Type ${e.requestTypeId}` }] : []) },
  { key: "status", label: "Status", extract: (e) => pair(e.status, e.status) },
];

export function selectedCoverageValues(filters: MarketingCoverageFilterState, key: MarketingCoverageFilterKey): string[] {
  if (key === "requestType") return filters.requestType.map(String);
  const value = (filters as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as string[]).map(String) : [];
}

export function withCoverageFilterValues(
  filters: MarketingCoverageFilterState,
  key: MarketingCoverageFilterKey,
  values: string[],
): MarketingCoverageFilterState {
  if (key === "requestType") {
    return { ...filters, requestType: values.map((v) => Number(v)).filter((v) => Number.isFinite(v)) };
  }
  return { ...filters, [key]: values } as MarketingCoverageFilterState;
}

export function entryMatchesCoverageFilters(
  entry: MarketingCoverageRequestIndexEntry,
  filters: MarketingCoverageFilterState,
  exceptKey?: MarketingCoverageFilterKey,
): boolean {
  for (const spec of MULTISELECT_SPECS) {
    if (spec.key === exceptKey) continue;
    const selected = selectedCoverageValues(filters, spec.key);
    if (selected.length === 0) continue;
    const values = spec.extract(entry).map((v) => v.value);
    if (!values.some((v) => selected.includes(v))) return false;
  }
  if (exceptKey !== "payDate") {
    if (filters.payDateFrom && (!entry.payDate || entry.payDate < filters.payDateFrom)) return false;
    if (filters.payDateTo && (!entry.payDate || entry.payDate > filters.payDateTo)) return false;
  }
  if (exceptKey !== "duration") {
    if (filters.durationMin != null && entry.roiDurationMonths < filters.durationMin) return false;
    if (filters.durationMax != null && entry.roiDurationMonths > filters.durationMax) return false;
  }
  return true;
}

function tally(entries: MarketingCoverageRequestIndexEntry[], extract: MultiselectSpec["extract"]): RoiFilterOption[] {
  const map = new Map<string, { label: string; count: number }>();
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const { value, label } of extract(entry)) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const cur = map.get(value);
      if (cur) cur.count += 1;
      else map.set(value, { label: label || value, count: 1 });
    }
  }
  return Array.from(map.entries())
    .map(([value, { label, count }]) => ({ value, label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export type FacetedCoverageFilterOptions = {
  dimensions: CoverageFilterDimension[];
  matchedCount: number;
  totalCount: number;
  canRevealRestricted: boolean;
};

export function computeFacetedCoverageDimensions(
  entries: MarketingCoverageRequestIndexEntry[],
  filters: MarketingCoverageFilterState,
  canRevealRestricted: boolean,
): FacetedCoverageFilterOptions {
  const dimensions: CoverageFilterDimension[] = [];

  for (const spec of MULTISELECT_SPECS) {
    const subset = entries.filter((entry) => entryMatchesCoverageFilters(entry, filters, spec.key));
    const options = tally(subset, spec.extract);
    const everyEntryHasValue = subset.every((entry) => spec.extract(entry).length > 0);
    dimensions.push({
      key: spec.key,
      label: spec.label,
      type: "multiselect",
      options,
      render: options.length >= 2,
      autoApplied: options.length === 1 && everyEntryHasValue ? [options[0].value] : null,
    });
  }

  const durSubset = entries.filter((entry) => entryMatchesCoverageFilters(entry, filters, "duration"));
  const durations = durSubset.map((e) => e.roiDurationMonths).filter((n) => Number.isFinite(n) && n > 0);
  const durMin = durations.length ? Math.min(...durations) : null;
  const durMax = durations.length ? Math.max(...durations) : null;
  dimensions.push({
    key: "duration",
    label: "ROI duration (months)",
    type: "numberRange",
    options: [],
    render: durMin !== null && durMax !== null && durMin !== durMax,
    autoApplied: null,
    min: durMin ?? undefined,
    max: durMax ?? undefined,
  });

  const dateSubset = entries.filter((entry) => entryMatchesCoverageFilters(entry, filters, "payDate"));
  const payDates = dateSubset.map((e) => e.payDate).filter((d): d is string => Boolean(d)).sort();
  const earliest = payDates.length ? payDates[0] : null;
  const latest = payDates.length ? payDates[payDates.length - 1] : null;
  dimensions.push({
    key: "payDate",
    label: "Pay date",
    type: "dateRange",
    options: [],
    render: Boolean(earliest && latest && earliest !== latest),
    autoApplied: null,
    earliest,
    latest,
  });

  const matched = entries.filter((entry) => entryMatchesCoverageFilters(entry, filters));
  dimensions.push({
    key: "includeRestricted",
    label: "Include confidential products",
    type: "toggle",
    options: [],
    render: canRevealRestricted && matched.some((e) => e.hasRestrictedProduct),
    autoApplied: null,
  });

  return { dimensions, matchedCount: matched.length, totalCount: entries.length, canRevealRestricted };
}

/**
 * Auto-fit: drop any selected multi-select value no longer available given the
 * OTHER current selections. Mirrors pruneRoiFilterState. `anchorKey` is
 * preserved; other dimensions adjust to fit it.
 */
export function pruneCoverageFilterState(
  entries: MarketingCoverageRequestIndexEntry[],
  filters: MarketingCoverageFilterState,
  anchorKey?: MarketingCoverageFilterKey,
): MarketingCoverageFilterState {
  let current = filters;
  for (let iteration = 0; iteration <= MULTISELECT_SPECS.length; iteration += 1) {
    let changed = false;
    for (const spec of MULTISELECT_SPECS) {
      if (spec.key === anchorKey) continue;
      const selected = selectedCoverageValues(current, spec.key);
      if (selected.length === 0) continue;
      const available = new Set<string>();
      for (const entry of entries) {
        if (!entryMatchesCoverageFilters(entry, current, spec.key)) continue;
        for (const { value } of spec.extract(entry)) available.add(value);
      }
      const kept = selected.filter((v) => available.has(v));
      if (kept.length !== selected.length) {
        current = withCoverageFilterValues(current, spec.key, kept);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}
