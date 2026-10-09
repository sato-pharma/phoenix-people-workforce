// Shared, pure display labels for ROI Tracking.
//
// Every ROI surface must distinguish FORECAST (expected vs required, fixed at request
// creation — the stored roi_status / roi_coverage_ratio) from ACTUAL (attributed sales
// from phx_marketing_request_roi_actuals) using the SAME wording. Import these helpers
// instead of hard-coding "coverage" / "covers required" strings — those bare labels have
// been read as realized ROI when they are only a forecast.

import type {
  MarketingRoiDataCoverage,
  MarketingRoiResultStatus,
} from "@/lib/marketing-requests/roi-report-types";

export const ROI_FORECAST_LABEL = "Forecast";
export const ROI_ACTUAL_LABEL = "Actual";
export const ROI_FORECAST_COVERAGE_LABEL = "Forecast coverage";
export const ROI_ACTUAL_COVERAGE_LABEL = "Actual coverage";
export const ROI_DATA_PENDING_LABEL = "Data pending";
export const ROI_NO_VALIDATED_SOS_LABEL = "No validated SoS data";
export const ROI_NO_ATTRIBUTED_SALES_LABEL = "No attributed sales";
/** Shown wherever a forecast-only surface can't load actual attribution. */
export const ROI_ACTUAL_IN_TRACKING_NOTE = "Actual ROI is available in ROI Tracking";

/**
 * Tri-state data coverage: is the request's ROI window fully / partly / not backed by
 * validated Source-of-Sales data? Pure YYYY-MM string comparison against the latest
 * validated SoS period. Uses only fields already computed by the report service.
 *
 * 🔴 `hasAttributedSales` wins over the frontier: a window that starts after the validated
 * period can still hold attributed sales (a distributor's file lands before the month is
 * validated), and "No validated SoS data" beside a real attributed figure told the reader the
 * figure was not there. Measured 2026-10-09: a September request with EGP 35,751 attributed
 * read "—" on the live tracker. Such a window is PARTIAL — data is arriving — never "none".
 */
export function resolveRoiDataCoverage(input: {
  windowStart: string | null;
  windowEnd: string | null;
  salesDataAsOf: string | null;
  hasAttributedSales?: boolean;
}): MarketingRoiDataCoverage {
  const { windowStart, windowEnd, salesDataAsOf, hasAttributedSales = false } = input;
  if (!salesDataAsOf || !windowStart || !windowEnd) return hasAttributedSales ? "partial_pending" : "no_validated_data";
  if (windowEnd <= salesDataAsOf) return "complete";
  if (windowStart <= salesDataAsOf || hasAttributedSales) return "partial_pending";
  return "no_validated_data";
}

export const ROI_DATA_COVERAGE_LABEL: Record<MarketingRoiDataCoverage, string> = {
  complete: "Complete window",
  partial_pending: `Partial window · ${ROI_DATA_PENDING_LABEL}`,
  no_validated_data: ROI_NO_VALIDATED_SOS_LABEL,
};

/**
 * FORECAST status label (stored roi_status = expected vs required). Always prefixed
 * "Forecast:" so a forecast verdict can never be read as a realized ROI result. Accepts a
 * plain string (the stored `roi_status`) so every call site can pass it without casting.
 */
export function forecastRoiStatusLabel(status: string): string {
  switch (status) {
    case "covers_required":
      return `${ROI_FORECAST_LABEL}: covers target`;
    case "under_target":
      return `${ROI_FORECAST_LABEL}: below target`;
    default:
      return `${ROI_FORECAST_LABEL}: not calculated`;
  }
}

/**
 * A marketing request's workflow status, as a reader sees it. ONE map for the ROI and Coverage
 * surfaces: three private copies had drifted — the Coverage workbook's had no "cancelled", so a
 * cancelled request exported as the raw word, and the Coverage filter showed raw enums.
 */
export const MARKETING_REQUEST_STATUS_LABEL: Record<string, string> = {
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

/** Readable status — "Unknown status" for a value no map knows, never the raw enum. */
export function marketingRequestStatusLabel(status: string | null | undefined): string {
  return MARKETING_REQUEST_STATUS_LABEL[status ?? ""] ?? "Unknown status";
}

/** ACTUAL realized-ROI verdict, from attributed sales (never carries "Forecast"). */
export const ROI_RESULT_STATUS_LABEL: Record<MarketingRoiResultStatus, string> = {
  on_track: "On track",
  behind: "Behind",
  awaiting_data: ROI_DATA_PENDING_LABEL,
  no_data: ROI_NO_ATTRIBUTED_SALES_LABEL,
};

export function actualResultStatusLabel(status: MarketingRoiResultStatus): string {
  return ROI_RESULT_STATUS_LABEL[status];
}
