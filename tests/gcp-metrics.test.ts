import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  AVAILABILITY_SLO_GOAL,
  LATENCY_SLO_GOAL,
  LATENCY_SLO_THRESHOLD_MS,
  computeAvailability,
  getServiceHealthSnapshot,
  meanLatestAcrossSeries,
  pointToNumber,
  sumLatestAcrossSeries,
  type MonitoringTimeSeries,
} from "../src/lib/observability/gcp-metrics.ts";

export async function runGcpMetricsTests() {
  // ── pointToNumber: INT64 arrives JSON-encoded as a string; DOUBLE as a number ──
  assert.equal(pointToNumber({ int64Value: "1234" }), 1234);
  assert.equal(pointToNumber({ int64Value: 42 }), 42);
  assert.equal(pointToNumber({ doubleValue: 12.5 }), 12.5);
  assert.equal(pointToNumber({ doubleValue: 0 }), 0, "zero is a valid value, not null");
  assert.equal(pointToNumber(undefined), null);
  assert.equal(pointToNumber({}), null);
  assert.equal(pointToNumber({ int64Value: "not-a-number" }), null);

  // ── computeAvailability: (total − 5xx) / total, grouped by response_code_class ──
  const series: MonitoringTimeSeries[] = [
    { metric: { labels: { response_code_class: "2xx" } }, points: [{ value: { int64Value: "900" } }] },
    { metric: { labels: { response_code_class: "4xx" } }, points: [{ value: { int64Value: "80" } }] },
    { metric: { labels: { response_code_class: "5xx" } }, points: [{ value: { int64Value: "20" } }] },
  ];
  const a = computeAvailability(series);
  assert.equal(a.requestCount, 1000);
  assert.equal(a.error5xxCount, 20, "only the 5xx class counts as an error");
  assert.equal(a.availabilityPct, 98, "(1000 − 20) / 1000 × 100 = 98 (4xx does NOT reduce availability)");

  // Multiple aligned points in one series are summed.
  const multi = computeAvailability([
    {
      metric: { labels: { response_code_class: "2xx" } },
      points: [{ value: { int64Value: "5" } }, { value: { int64Value: "5" } }],
    },
  ]);
  assert.equal(multi.requestCount, 10);
  assert.equal(multi.availabilityPct, 100);

  // No traffic → availability is null, never a misleading 100%.
  const empty = computeAvailability([]);
  assert.equal(empty.requestCount, 0);
  assert.equal(empty.error5xxCount, 0);
  assert.equal(empty.availabilityPct, null);

  // ── latest-point reducers (Cloud Monitoring returns points newest-first) ──
  // instance_count: sum the newest value across revisions.
  assert.equal(
    sumLatestAcrossSeries([
      { points: [{ value: { doubleValue: 2 } }, { value: { doubleValue: 9 } }] },
      { points: [{ value: { doubleValue: 3 } }] },
    ]),
    5,
    "sums the FIRST (newest) point of each series: 2 + 3",
  );
  assert.equal(sumLatestAcrossSeries([]), null);
  assert.equal(sumLatestAcrossSeries([{ points: [] }]), null);

  // percentile: mean of the newest value across revisions.
  assert.equal(
    meanLatestAcrossSeries([
      { points: [{ value: { doubleValue: 100 } }] },
      { points: [{ value: { doubleValue: 300 } }] },
    ]),
    200,
  );
  assert.equal(meanLatestAcrossSeries([]), null);

  // ── SLO constants mirror the two Cloud Monitoring SLOs under phoenix-hr-prod ──
  assert.equal(AVAILABILITY_SLO_GOAL, 0.995, "availability-99-5");
  assert.equal(LATENCY_SLO_GOAL, 0.95, "latency-95-2s: 95% of requests…");
  assert.equal(LATENCY_SLO_THRESHOLD_MS, 2000, "…under 2s");

  // ── never throws; returns { available:false } when GCP_PROJECT_ID is unset ──
  const savedProject = process.env.GCP_PROJECT_ID;
  delete process.env.GCP_PROJECT_ID;
  try {
    const result = await getServiceHealthSnapshot();
    assert.equal(result.available, false, "no project id → not available");
    if (result.available === false) {
      assert.match(result.error, /GCP_PROJECT_ID/, "error must name the missing config");
    }
  } finally {
    if (savedProject === undefined) delete process.env.GCP_PROJECT_ID;
    else process.env.GCP_PROJECT_ID = savedProject;
  }

  // ── the query builder targets the intended metrics/aligners/grouping ──
  const source = readFileSync("src/lib/observability/gcp-metrics.ts", "utf8");
  assert.match(source, /run\.googleapis\.com\/request_count/);
  assert.match(source, /run\.googleapis\.com\/request_latencies/);
  assert.match(source, /run\.googleapis\.com\/container\/instance_count/);
  assert.match(source, /resource\.type="cloud_run_revision"/);
  assert.match(source, /resource\.labels\.service_name=/);
  assert.match(source, /ALIGN_SUM/);
  assert.match(source, /ALIGN_PERCENTILE_50/);
  assert.match(source, /ALIGN_PERCENTILE_95/);
  assert.match(source, /ALIGN_PERCENTILE_99/);
  assert.match(source, /metric\.label\.response_code_class/);
  assert.match(source, /monitoring\.googleapis\.com\/v3/);
  assert.match(source, /auth\/monitoring\.read/);
}
