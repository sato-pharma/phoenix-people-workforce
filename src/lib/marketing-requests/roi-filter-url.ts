import {
  emptyRoiFilterState,
  type MarketingRoiResultStatus,
  type RoiFilterState,
} from "@/lib/marketing-requests/roi-report-types";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";

// Pure codec between RoiFilterState and URLSearchParams so a filtered report view is
// shareable (and a preset is storable) as a plain query string. The server always
// re-validates scope on every request, so a shared/old link can never widen
// visibility — it can only narrow within the recipient's own scope.

const ARRAY_KEYS = [
  "dm",
  "nsm",
  "rsm",
  "line",
  "approvedBy",
  "requester",
  "status",
  "region",
  "distributor",
  "product",
  "pharmacy",
  "roiStatus",
] as const;

export function roiFilterStateToParams(filters: RoiFilterState): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ARRAY_KEYS) {
    for (const value of filters[key]) {
      if (value !== undefined && value !== null && String(value).length > 0) params.append(key, String(value));
    }
  }
  for (const value of filters.requestType) params.append("requestType", String(value));
  if (filters.payDateFrom) params.set("payDateFrom", filters.payDateFrom);
  if (filters.payDateTo) params.set("payDateTo", filters.payDateTo);
  if (filters.durationMin != null) params.set("durationMin", String(filters.durationMin));
  if (filters.durationMax != null) params.set("durationMax", String(filters.durationMax));
  if (filters.includeRestricted) params.set("includeRestricted", "1");
  return params;
}

export function roiFilterStateFromParams(params: URLSearchParams): RoiFilterState {
  const state = emptyRoiFilterState();
  state.dm = params.getAll("dm");
  state.nsm = params.getAll("nsm");
  state.rsm = params.getAll("rsm");
  state.line = params.getAll("line");
  state.approvedBy = params.getAll("approvedBy");
  state.requester = params.getAll("requester");
  state.status = params.getAll("status") as MarketingRequestStatus[];
  state.region = params.getAll("region");
  state.distributor = params.getAll("distributor");
  state.product = params.getAll("product");
  state.pharmacy = params.getAll("pharmacy");
  state.roiStatus = params.getAll("roiStatus") as MarketingRoiResultStatus[];
  state.requestType = params
    .getAll("requestType")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  state.payDateFrom = params.get("payDateFrom") || null;
  state.payDateTo = params.get("payDateTo") || null;
  const durationMin = params.get("durationMin");
  const durationMax = params.get("durationMax");
  state.durationMin = durationMin != null && durationMin !== "" && Number.isFinite(Number(durationMin)) ? Number(durationMin) : null;
  state.durationMax = durationMax != null && durationMax !== "" && Number.isFinite(Number(durationMax)) ? Number(durationMax) : null;
  state.includeRestricted = params.get("includeRestricted") === "1";
  return state;
}

/** True when any filter is set — used to decide whether to auto-apply on load. */
export function roiFilterStateHasAny(filters: RoiFilterState): boolean {
  if (
    filters.dm.length ||
    filters.nsm.length ||
    filters.rsm.length ||
    filters.line.length ||
    filters.approvedBy.length ||
    filters.requester.length ||
    filters.status.length ||
    filters.requestType.length ||
    filters.region.length ||
    filters.distributor.length ||
    filters.product.length ||
    filters.pharmacy.length ||
    filters.roiStatus.length
  ) {
    return true;
  }
  return Boolean(
    filters.payDateFrom ||
      filters.payDateTo ||
      filters.durationMin != null ||
      filters.durationMax != null ||
      filters.includeRestricted,
  );
}
