import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";
import {
  emptyMarketingCoverageFilterState,
  type MarketingCoverageFilterState,
  type MarketingRoiResultStatus,
} from "@/lib/marketing-requests/roi-report-types";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — shareable URL filter state.
//
// First-of-kind for this report, but mirrors the proven useSearchParams +
// URLSearchParams pattern already established in analytics-filter-bar.tsx:
// string arrays serialize as repeated `key=value` params, scalars as a single
// `key=value`, booleans are present only when true. Kept as pure functions
// (no React, no window) so the round-trip is independently unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

const STRING_ARRAY_KEYS = [
  "dm",
  "nsm",
  "rsm",
  "line",
  "approvedBy",
  "requester",
  "region",
  "distributor",
  "product",
  "pharmacy",
  "area",
  "requesterTier",
] as const;

export function coverageFiltersToSearchParams(filters: MarketingCoverageFilterState): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of STRING_ARRAY_KEYS) {
    for (const value of filters[key]) params.append(key, value);
  }
  for (const value of filters.status) params.append("status", value);
  for (const value of filters.roiStatus) params.append("roiStatus", value);
  for (const value of filters.requestType) params.append("requestType", String(value));
  if (filters.payDateFrom) params.set("payDateFrom", filters.payDateFrom);
  if (filters.payDateTo) params.set("payDateTo", filters.payDateTo);
  if (filters.durationMin !== null) params.set("durationMin", String(filters.durationMin));
  if (filters.durationMax !== null) params.set("durationMax", String(filters.durationMax));
  if (filters.includeRestricted) params.set("includeRestricted", "1");
  return params;
}

/** Returns null when the params carry no filter state at all (nothing to hydrate from). */
export function coverageFiltersFromSearchParams(params: URLSearchParams): MarketingCoverageFilterState | null {
  if (![...params.keys()].length) return null;

  const next = emptyMarketingCoverageFilterState();
  for (const key of STRING_ARRAY_KEYS) {
    const values = params.getAll(key);
    if (values.length > 0) next[key] = values;
  }
  const status = params.getAll("status");
  if (status.length > 0) next.status = status as MarketingRequestStatus[];
  const roiStatus = params.getAll("roiStatus");
  if (roiStatus.length > 0) next.roiStatus = roiStatus as MarketingRoiResultStatus[];
  const requestType = params
    .getAll("requestType")
    .map(Number)
    .filter((value) => Number.isFinite(value));
  if (requestType.length > 0) next.requestType = requestType;

  const payDateFrom = params.get("payDateFrom");
  if (payDateFrom) next.payDateFrom = payDateFrom;
  const payDateTo = params.get("payDateTo");
  if (payDateTo) next.payDateTo = payDateTo;
  const durationMin = params.get("durationMin");
  if (durationMin !== null && durationMin !== "" && Number.isFinite(Number(durationMin))) next.durationMin = Number(durationMin);
  const durationMax = params.get("durationMax");
  if (durationMax !== null && durationMax !== "" && Number.isFinite(Number(durationMax))) next.durationMax = Number(durationMax);
  next.includeRestricted = params.get("includeRestricted") === "1";

  return next;
}
