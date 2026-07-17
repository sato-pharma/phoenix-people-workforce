// Live GCP Cloud Monitoring reader for the System Issues "Service Health" panel.
//
// Complements gcp-logs.ts (which reads Cloud Logging): this reads Cloud Monitoring
// time-series so the dashboard can show real availability / latency / instance-count
// SLIs straight from the platform, alongside the two SLOs already defined under
// service id `phoenix-hr-prod` (availability-99-5, latency-95-2s). Uses Application
// Default Credentials — the Cloud Run runtime service account (phoenix-hr-run, which
// has roles/monitoring.viewer) in production, or `gcloud auth application-default
// login` locally. Never throws: missing project config or an unauthorized principal
// (IAM not yet granted) surfaces as `{ available: false, error }` so the dashboard can
// show an explicit "not connected" state instead of a misleading blank panel. Mirrors
// gcp-logs.ts's style and its `{ available, error }` contract precisely.

import { GoogleAuth } from "google-auth-library";

const MONITORING_SCOPE = "https://www.googleapis.com/auth/monitoring.read";
const MONITORING_ENDPOINT = "https://monitoring.googleapis.com/v3";

// Cloud Run built-in metrics we read (see cloud.google.com/monitoring/api/metrics_gcp).
const REQUEST_COUNT_METRIC = "run.googleapis.com/request_count";
const REQUEST_LATENCIES_METRIC = "run.googleapis.com/request_latencies";
const INSTANCE_COUNT_METRIC = "run.googleapis.com/container/instance_count";

// Static SLO context, mirrored from the two Cloud Monitoring SLOs already defined under
// service id `phoenix-hr-prod`, so the panel can render "target vs actual" without a
// second API round-trip to the SLO service.
export const AVAILABILITY_SLO_GOAL = 0.995; // availability-99-5  → 99.5% of requests non-5xx
export const LATENCY_SLO_GOAL = 0.95; // latency-95-2s → 95% of requests…
export const LATENCY_SLO_THRESHOLD_MS = 2000; // …served in under 2s

export type ServiceHealthSnapshot = {
  /** (total − 5xx) / total × 100 over the availability window. Null when no requests. */
  availabilityPct24h: number | null;
  requestCount24h: number | null;
  error5xxCount24h: number | null;
  latencyMsP50: number | null;
  latencyMsP95: number | null;
  latencyMsP99: number | null;
  /** Latest container instance count, summed across live revisions. */
  currentInstanceCount: number | null;
  availabilityWindowHours: number;
  latencyWindowHours: number;
  // Static SLO targets so the UI can show target-vs-actual.
  availabilitySloGoal: number;
  latencySloGoal: number;
  latencySloThresholdMs: number;
};

export type ServiceHealthResult =
  | { available: true; health: ServiceHealthSnapshot }
  | { available: false; error: string };

// ── Minimal shapes of the Cloud Monitoring v3 timeSeries.list REST response ─────────
type TimeSeriesValue = { int64Value?: string | number | null; doubleValue?: number | null };
type TimeSeriesPoint = { value?: TimeSeriesValue };
export type MonitoringTimeSeries = {
  metric?: { labels?: Record<string, string> };
  points?: TimeSeriesPoint[];
};

/**
 * Reads a numeric value from a monitoring point. INT64 values come back JSON-encoded as
 * strings; DOUBLE values as numbers. Returns null for anything unparseable/absent.
 */
export function pointToNumber(value: TimeSeriesValue | undefined): number | null {
  if (!value) return null;
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if (value.int64Value !== undefined && value.int64Value !== null) {
    const n = Number(value.int64Value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Sum of every point in one series (DELTA counts aligned into a single window). */
function sumSeries(series: MonitoringTimeSeries): number {
  let total = 0;
  for (const point of series.points ?? []) {
    const n = pointToNumber(point.value);
    if (n !== null) total += n;
  }
  return total;
}

/** Latest (most recent) non-null point of a series. The API returns points newest-first. */
function latestPoint(series: MonitoringTimeSeries): number | null {
  for (const point of series.points ?? []) {
    const n = pointToNumber(point.value);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Availability from request_count grouped by response_code_class:
 * (total − 5xx) / total. Availability is null when there were no requests at all (no
 * traffic ≠ 100% healthy — the truthful signal is "unknown").
 */
export function computeAvailability(series: MonitoringTimeSeries[]): {
  requestCount: number;
  error5xxCount: number;
  availabilityPct: number | null;
} {
  let requestCount = 0;
  let error5xxCount = 0;
  for (const s of series) {
    const count = sumSeries(s);
    requestCount += count;
    if ((s.metric?.labels?.response_code_class ?? "") === "5xx") error5xxCount += count;
  }
  const availabilityPct = requestCount > 0 ? ((requestCount - error5xxCount) / requestCount) * 100 : null;
  return { requestCount, error5xxCount, availabilityPct };
}

/** Sum of each series' latest value (instance_count summed across revisions). Null if none. */
export function sumLatestAcrossSeries(series: MonitoringTimeSeries[]): number | null {
  let sum = 0;
  let sawAny = false;
  for (const s of series) {
    const v = latestPoint(s);
    if (v !== null) {
      sum += v;
      sawAny = true;
    }
  }
  return sawAny ? sum : null;
}

/** Mean of each series' latest value (a percentile combined across revisions). Null if none. */
export function meanLatestAcrossSeries(series: MonitoringTimeSeries[]): number | null {
  const values: number[] = [];
  for (const s of series) {
    const v = latestPoint(s);
    if (v !== null) values.push(v);
  }
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ── GCP access + query plumbing ─────────────────────────────────────────────────────
let cachedAuth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!cachedAuth) cachedAuth = new GoogleAuth({ scopes: MONITORING_SCOPE });
  return cachedAuth;
}

async function getAccessToken(): Promise<string> {
  const token = await getAuth().getAccessToken();
  if (!token) {
    throw new Error("Could not obtain a Google Cloud access token from Application Default Credentials.");
  }
  return token;
}

function buildFilter(metricType: string, service: string): string {
  return [
    `metric.type="${metricType}"`,
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${service}"`,
  ].join(" AND ");
}

function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

type TimeSeriesQuery = {
  filter: string;
  startTime: string;
  endTime: string;
  alignmentPeriodSec: number;
  perSeriesAligner: string;
  crossSeriesReducer?: string;
  groupByFields?: string[];
};

async function queryTimeSeries(
  projectId: string,
  token: string,
  query: TimeSeriesQuery,
): Promise<MonitoringTimeSeries[]> {
  const params = new URLSearchParams();
  params.set("filter", query.filter);
  params.set("interval.startTime", query.startTime);
  params.set("interval.endTime", query.endTime);
  params.set("aggregation.alignmentPeriod", `${query.alignmentPeriodSec}s`);
  params.set("aggregation.perSeriesAligner", query.perSeriesAligner);
  if (query.crossSeriesReducer) params.set("aggregation.crossSeriesReducer", query.crossSeriesReducer);
  for (const field of query.groupByFields ?? []) params.append("aggregation.groupByFields", field);

  const url = `${MONITORING_ENDPOINT}/projects/${projectId}/timeSeries?${params.toString()}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Cloud Monitoring timeSeries query failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const json = (await response.json()) as { timeSeries?: MonitoringTimeSeries[] };
  return json.timeSeries ?? [];
}

function latencyPercentileQuery(
  filter: string,
  startTime: string,
  endTime: string,
  windowHours: number,
  aligner: "ALIGN_PERCENTILE_50" | "ALIGN_PERCENTILE_95" | "ALIGN_PERCENTILE_99",
): TimeSeriesQuery {
  return {
    filter,
    startTime,
    endTime,
    // One alignment bucket spanning the whole window → one representative percentile
    // point per revision, meaned across revisions below.
    alignmentPeriodSec: windowHours * 3600,
    perSeriesAligner: aligner,
    crossSeriesReducer: "REDUCE_MEAN",
  };
}

/**
 * Fetches the current Cloud Run Service Health snapshot from Cloud Monitoring. Never
 * throws — every failure path (missing GCP_PROJECT_ID, no ADC, IAM denied, API error)
 * returns `{ available: false, error }`. An authorized call with simply no traffic
 * returns `{ available: true }` with null metrics (empty data is graceful, not an error).
 */
export async function getServiceHealthSnapshot(): Promise<ServiceHealthResult> {
  const projectId = process.env.GCP_PROJECT_ID;
  const service = process.env.GCP_CLOUD_RUN_SERVICE || "phoenix-hr";

  if (!projectId) {
    return { available: false, error: "GCP_PROJECT_ID is not configured." };
  }

  const availabilityWindowHours = 24;
  const latencyWindowHours = 3;

  try {
    const token = await getAccessToken();
    const now = Date.now();
    const endTime = rfc3339(now);
    const availabilityStart = rfc3339(now - availabilityWindowHours * 60 * 60 * 1000);
    const latencyStart = rfc3339(now - latencyWindowHours * 60 * 60 * 1000);
    const instanceStart = rfc3339(now - 10 * 60 * 1000);

    const requestFilter = buildFilter(REQUEST_COUNT_METRIC, service);
    const latencyFilter = buildFilter(REQUEST_LATENCIES_METRIC, service);
    const instanceFilter = buildFilter(INSTANCE_COUNT_METRIC, service);

    const [availabilitySeries, p50Series, p95Series, p99Series, instanceSeries] = await Promise.all([
      queryTimeSeries(projectId, token, {
        filter: requestFilter,
        startTime: availabilityStart,
        endTime,
        alignmentPeriodSec: availabilityWindowHours * 3600,
        perSeriesAligner: "ALIGN_SUM",
        crossSeriesReducer: "REDUCE_SUM",
        groupByFields: ["metric.label.response_code_class"],
      }),
      queryTimeSeries(projectId, token, latencyPercentileQuery(latencyFilter, latencyStart, endTime, latencyWindowHours, "ALIGN_PERCENTILE_50")),
      queryTimeSeries(projectId, token, latencyPercentileQuery(latencyFilter, latencyStart, endTime, latencyWindowHours, "ALIGN_PERCENTILE_95")),
      queryTimeSeries(projectId, token, latencyPercentileQuery(latencyFilter, latencyStart, endTime, latencyWindowHours, "ALIGN_PERCENTILE_99")),
      queryTimeSeries(projectId, token, {
        filter: instanceFilter,
        startTime: instanceStart,
        endTime,
        alignmentPeriodSec: 60,
        perSeriesAligner: "ALIGN_MEAN",
        crossSeriesReducer: "REDUCE_SUM",
      }),
    ]);

    const availability = computeAvailability(availabilitySeries);

    const health: ServiceHealthSnapshot = {
      availabilityPct24h: availability.availabilityPct,
      requestCount24h: availability.requestCount,
      error5xxCount24h: availability.error5xxCount,
      latencyMsP50: meanLatestAcrossSeries(p50Series),
      latencyMsP95: meanLatestAcrossSeries(p95Series),
      latencyMsP99: meanLatestAcrossSeries(p99Series),
      currentInstanceCount: sumLatestAcrossSeries(instanceSeries),
      availabilityWindowHours,
      latencyWindowHours,
      availabilitySloGoal: AVAILABILITY_SLO_GOAL,
      latencySloGoal: LATENCY_SLO_GOAL,
      latencySloThresholdMs: LATENCY_SLO_THRESHOLD_MS,
    };

    return { available: true, health };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Cloud Monitoring error";
    return { available: false, error: message };
  }
}
