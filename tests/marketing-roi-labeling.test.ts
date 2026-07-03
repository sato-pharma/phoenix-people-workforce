import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ROI_ACTUAL_COVERAGE_LABEL,
  ROI_ACTUAL_IN_TRACKING_NOTE,
  ROI_DATA_COVERAGE_LABEL,
  ROI_FORECAST_COVERAGE_LABEL,
  ROI_NO_ATTRIBUTED_SALES_LABEL,
  ROI_NO_VALIDATED_SOS_LABEL,
  ROI_RESULT_STATUS_LABEL,
  actualResultStatusLabel,
  forecastRoiStatusLabel,
  resolveRoiDataCoverage,
} from "../src/lib/marketing-requests/roi-labels.ts";

// Tri-state data coverage: window end/start vs the latest validated SoS period.
function testDataCoverage() {
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-04", windowEnd: "2026-06", salesDataAsOf: "2026-06" }),
    "complete",
    "window fully within validated range",
  );
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-03", windowEnd: "2026-08", salesDataAsOf: "2026-06" }),
    "partial_pending",
    "window starts covered but runs past the validated tail",
  );
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-07", windowEnd: "2026-09", salesDataAsOf: "2026-06" }),
    "no_validated_data",
    "window entirely in the not-yet-loaded future",
  );
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-04", windowEnd: "2026-06", salesDataAsOf: null }),
    "no_validated_data",
    "nothing validated yet",
  );
  assert.equal(
    resolveRoiDataCoverage({ windowStart: null, windowEnd: null, salesDataAsOf: "2026-06" }),
    "no_validated_data",
    "no ROI window (no pay date)",
  );
  // boundaries
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-06", windowEnd: "2026-06", salesDataAsOf: "2026-06" }),
    "complete",
    "end exactly at the validated period is complete",
  );
  assert.equal(
    resolveRoiDataCoverage({ windowStart: "2026-06", windowEnd: "2026-07", salesDataAsOf: "2026-06" }),
    "partial_pending",
    "start at the validated period, end just past it is partial",
  );

  assert.equal(ROI_DATA_COVERAGE_LABEL.no_validated_data, ROI_NO_VALIDATED_SOS_LABEL);
  assert.match(ROI_DATA_COVERAGE_LABEL.no_validated_data, /No validated SoS data/);
  assert.match(ROI_DATA_COVERAGE_LABEL.partial_pending, /Data pending/i);
  assert.match(ROI_DATA_COVERAGE_LABEL.complete, /Complete/i);
}

// Every FORECAST label must carry "Forecast" and never read as a realized result.
function testForecastLabels() {
  for (const status of ["covers_required", "under_target", "not_calculated"]) {
    assert.match(forecastRoiStatusLabel(status), /Forecast/, `${status} label must contain "Forecast"`);
  }
  assert.match(forecastRoiStatusLabel("covers_required"), /covers target/i);
  assert.match(forecastRoiStatusLabel("under_target"), /below target/i);
  assert.match(forecastRoiStatusLabel(""), /Forecast: not calculated/, "unknown status falls back safely");
  // the confusing legacy phrasing must not survive verbatim
  assert.doesNotMatch(forecastRoiStatusLabel("covers_required"), /covers required/i);

  assert.match(ROI_FORECAST_COVERAGE_LABEL, /Forecast/);
  assert.doesNotMatch(ROI_FORECAST_COVERAGE_LABEL, /Actual/);
}

// ACTUAL labels must never carry "Forecast".
function testActualLabels() {
  assert.equal(actualResultStatusLabel("on_track"), "On track");
  assert.equal(actualResultStatusLabel("behind"), "Behind");
  assert.equal(actualResultStatusLabel("awaiting_data"), "Data pending");
  assert.equal(actualResultStatusLabel("no_data"), ROI_NO_ATTRIBUTED_SALES_LABEL);
  assert.equal(ROI_NO_ATTRIBUTED_SALES_LABEL, "No attributed sales");

  for (const status of ["on_track", "behind", "awaiting_data", "no_data"] as const) {
    assert.doesNotMatch(ROI_RESULT_STATUS_LABEL[status], /Forecast/i, `actual "${status}" must not be labeled Forecast`);
  }

  assert.match(ROI_ACTUAL_COVERAGE_LABEL, /Actual/);
  assert.doesNotMatch(ROI_ACTUAL_COVERAGE_LABEL, /Forecast/);
  assert.notEqual(ROI_FORECAST_COVERAGE_LABEL, ROI_ACTUAL_COVERAGE_LABEL, "forecast coverage is not the same label as actual coverage");
  assert.match(ROI_ACTUAL_IN_TRACKING_NOTE, /ROI Tracking/);
}

// The three display surfaces must show forecast-vs-actual clearly (source-level guards,
// matching the repo convention in marketing-request-service.test.ts).
function testSurfaceSourceGuards() {
  const drafts = readFileSync("src/components/employee-portal/marketing-request-drafts.tsx", "utf8");
  assert.match(drafts, /forecastRoiStatusLabel\(/, "drafts must render forecast status via the shared forecast label");
  assert.match(drafts, /forecast coverage/i, "drafts must label the coverage % as forecast coverage");
  assert.match(drafts, /ROI_ACTUAL_IN_TRACKING_NOTE/, "drafts must point users to ROI Tracking for actual ROI");
  // the bare, confusing status text must be gone
  assert.doesNotMatch(drafts, /draft\.roiStatus\.replace/, "drafts must not print the raw roi_status verbatim");
  assert.doesNotMatch(drafts, /roiPreview\.roiStatus\.replace/, "preview must not print the raw roi_status verbatim");

  const engine = readFileSync("src/components/marketing-requests/roi-filter-engine.tsx", "utf8");
  assert.match(engine, /Actual coverage/, "filter engine must label the coverage column as Actual coverage");
  assert.match(engine, /Expected \(forecast\)/, "filter engine must surface the forecast (expected) figure");
  // filter contract intact: the four result-status VALUES must remain referenced (labels only changed)
  for (const value of ["on_track", "behind", "awaiting_data", "no_data"]) {
    assert.match(engine, new RegExp(`\\b${value}\\b`), `filter engine must keep the ${value} status value`);
  }

  const workspace = readFileSync("src/components/employee-portal/marketing-roi-tracking-workspace.tsx", "utf8");
  assert.match(workspace, /Actual coverage/, "portal workspace must label coverage as Actual coverage");
  assert.match(workspace, /Expected \(forecast\)/, "portal workspace must label expected as forecast");

  const types = readFileSync("src/lib/marketing-requests/roi-report-types.ts", "utf8");
  assert.match(types, /forecastCoverageRatio: number/, "report row must carry forecastCoverageRatio");
  assert.match(types, /dataCoverage: MarketingRoiDataCoverage/, "report row must carry dataCoverage");
}

export function runMarketingRoiLabelingTests() {
  testDataCoverage();
  testForecastLabels();
  testActualLabels();
  testSurfaceSourceGuards();
}
