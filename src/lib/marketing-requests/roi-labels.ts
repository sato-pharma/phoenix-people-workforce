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
 */
export function resolveRoiDataCoverage(input: {
  windowStart: string | null;
  windowEnd: string | null;
  salesDataAsOf: string | null;
}): MarketingRoiDataCoverage {
  const { windowStart, windowEnd, salesDataAsOf } = input;
  if (!salesDataAsOf || !windowStart || !windowEnd) return "no_validated_data";
  if (windowEnd <= salesDataAsOf) return "complete";
  if (windowStart <= salesDataAsOf) return "partial_pending";
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
