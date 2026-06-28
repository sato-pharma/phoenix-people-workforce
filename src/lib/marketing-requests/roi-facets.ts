import type {
  MarketingRoiRequestIndexEntry,
  RoiFilterDimension,
  RoiFilterKey,
  RoiFilterOption,
  RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";

// ─────────────────────────────────────────────────────────────────────────────
// Smart, cascading (faceted) filter options for the ROI Filter Engine.
//
// Pure + client-safe (types only). Every dimension's options are recomputed from
// the requests that match the CURRENT selection in all OTHER dimensions — so the
// filters are dependent: choose an NSM and the DM list collapses to that NSM's
// DMs; choose line = Pedia and every other filter narrows to fit. Dimensions are
// returned broadest-scope first (NSM → RSM → DM → Requester → line/region → …).
//
// `roiStatus` and `includeRestricted` are intentionally NOT used to match entries
// (ROI status needs the attribution math done at Apply; the confidential toggle is
// a reveal switch, not a row filter), so they never distort the cascade.
// ─────────────────────────────────────────────────────────────────────────────

type ValueLabel = { value: string; label: string };

type MultiselectSpec = {
  key: RoiFilterKey;
  label: string;
  extract: (entry: MarketingRoiRequestIndexEntry) => ValueLabel[];
};

const pair = (value: string | null | undefined, label: string | null | undefined): ValueLabel[] => {
  const v = (value ?? "").trim();
  return v ? [{ value: v, label: (label ?? v) || v }] : [];
};

/** Broadest-scope-first order: the management chain leads (NSM → RSM → DM →
 *  Requester), then geography, then the operational dimensions. */
const MULTISELECT_SPECS: MultiselectSpec[] = [
  { key: "nsm", label: "National Sales Manager", extract: (e) => pair(e.nsmHrId, e.nsmName) },
  { key: "rsm", label: "Regional Manager", extract: (e) => pair(e.rsmHrId, e.rsmName) },
  { key: "dm", label: "District Manager", extract: (e) => pair(e.dmHrId, e.dmName) },
  { key: "requester", label: "Requester", extract: (e) => pair(e.requesterHrId, e.requesterName) },
  { key: "line", label: "Line", extract: (e) => pair(e.lineName, e.lineName) },
  { key: "region", label: "Region", extract: (e) => pair(e.regionName, e.regionName) },
  { key: "approvedBy", label: "Approved by", extract: (e) => e.approverRoleKeys.map((r) => ({ value: r, label: r })) },
  { key: "distributor", label: "Distributor", extract: (e) => e.distributorCodes.map((c) => ({ value: c, label: c })) },
  { key: "product", label: "Product", extract: (e) => e.productCodes.map((c, i) => ({ value: c, label: e.productNames[i] ?? c })) },
  { key: "pharmacy", label: "Target pharmacy", extract: (e) => e.pharmacyKeys.map((k, i) => ({ value: k, label: e.pharmacyNames[i] ?? k })) },
  { key: "requestType", label: "Request type", extract: (e) => (e.requestTypeId ? [{ value: String(e.requestTypeId), label: e.requestTypeName ?? `Type ${e.requestTypeId}` }] : []) },
  { key: "status", label: "Status", extract: (e) => pair(e.status, e.status) },
];

/** Current selected values for a multi-select dimension (request type stored as numbers). */
export function selectedRoiValues(filters: RoiFilterState, key: RoiFilterKey): string[] {
  if (key === "requestType") return filters.requestType.map(String);
  const value = (filters as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as string[]).map(String) : [];
}

/** Write values back into a copy of the filter state, coercing request type to numbers. */
export function withRoiFilterValues(filters: RoiFilterState, key: RoiFilterKey, values: string[]): RoiFilterState {
  if (key === "requestType") {
    return { ...filters, requestType: values.map((v) => Number(v)).filter((v) => Number.isFinite(v)) };
  }
  return { ...filters, [key]: values } as RoiFilterState;
}

/**
 * Does an entry satisfy every active multi-select + range filter — optionally
 * IGNORING one dimension (so a dimension's own options aren't collapsed by its own
 * selection, the standard faceted-search rule)? roiStatus + includeRestricted are
 * never matched here.
 */
export function entryMatchesRoiFilters(
  entry: MarketingRoiRequestIndexEntry,
  filters: RoiFilterState,
  exceptKey?: RoiFilterKey,
): boolean {
  for (const spec of MULTISELECT_SPECS) {
    if (spec.key === exceptKey) continue;
    const selected = selectedRoiValues(filters, spec.key);
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

function tally(entries: MarketingRoiRequestIndexEntry[], extract: MultiselectSpec["extract"]): RoiFilterOption[] {
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

export type FacetedFilterOptions = {
  dimensions: RoiFilterDimension[];
  /** requests matching ALL current filters (the live result-set size). */
  matchedCount: number;
  totalCount: number;
  canRevealRestricted: boolean;
};

/**
 * Compute the dependent (faceted) dimensions for the current filter state. Each
 * dimension's options come from the entries matching every OTHER active filter, so
 * the panel cascades. Render rule (unchanged): ≥2 live options → render; exactly 1
 * → auto-applied + hidden; 0 → hidden.
 */
export function computeFacetedDimensions(
  entries: MarketingRoiRequestIndexEntry[],
  filters: RoiFilterState,
  canRevealRestricted: boolean,
): FacetedFilterOptions {
  const dimensions: RoiFilterDimension[] = [];

  for (const spec of MULTISELECT_SPECS) {
    const subset = entries.filter((entry) => entryMatchesRoiFilters(entry, filters, spec.key));
    const options = tally(subset, spec.extract);
    // Auto-apply a lone value ONLY when it is universal — every entry in the subset
    // carries a value for this dimension. A single value present on just a MINORITY of
    // entries (e.g. the company's only Regional Manager, who sits in only some chains
    // while most requests have no RM at all) is not a real constraint: auto-applying it
    // would mislead every viewer and, if selected, drop every value-less request. Hide it.
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

  // ROI duration range — faceted over entries matching every filter except duration.
  const durSubset = entries.filter((entry) => entryMatchesRoiFilters(entry, filters, "duration"));
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

  // Pay date range — faceted over entries matching every filter except pay date.
  const dateSubset = entries.filter((entry) => entryMatchesRoiFilters(entry, filters, "payDate"));
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

  // Confidential toggle — only when the viewer may reveal AND a matching request hides one.
  const matched = entries.filter((entry) => entryMatchesRoiFilters(entry, filters));
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
 * Auto-fit: drop any selected multi-select value that is no longer available given
 * the OTHER current selections (so an impossible combination can never be held).
 * Iterates to a fixed point because dropping one value can free/invalidate others.
 *
 * `anchorKey` is the dimension the user JUST changed — it is preserved and the OTHER
 * dimensions adjust to fit it (so choosing an NSM keeps that NSM and drops a now-stale
 * DM/product, never the other way round).
 */
export function pruneRoiFilterState(
  entries: MarketingRoiRequestIndexEntry[],
  filters: RoiFilterState,
  anchorKey?: RoiFilterKey,
): RoiFilterState {
  let current = filters;
  for (let iteration = 0; iteration <= MULTISELECT_SPECS.length; iteration += 1) {
    let changed = false;
    for (const spec of MULTISELECT_SPECS) {
      if (spec.key === anchorKey) continue;
      const selected = selectedRoiValues(current, spec.key);
      if (selected.length === 0) continue;
      const available = new Set<string>();
      for (const entry of entries) {
        if (!entryMatchesRoiFilters(entry, current, spec.key)) continue;
        for (const { value } of spec.extract(entry)) available.add(value);
      }
      const kept = selected.filter((v) => available.has(v));
      if (kept.length !== selected.length) {
        current = withRoiFilterValues(current, spec.key, kept);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}
