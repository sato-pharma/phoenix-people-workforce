// Write-side counterpart to gcp-metrics.ts's read-only Service Health snapshot: records
// every AI/LLM call's outcome as Cloud Monitoring custom metrics (request count, latency,
// token usage), so cost/latency/volume trends are visible as real time-series graphs
// instead of being invisible. Fire-and-forget by design — a Monitoring API hiccup must
// never fail, slow down, or even be awaited by the AI call it's describing.

import { GoogleAuth } from "google-auth-library";

const METRIC_WRITE_SCOPE = "https://www.googleapis.com/auth/monitoring.write";
const MONITORING_ENDPOINT = "https://monitoring.googleapis.com/v3";
const METRIC_PREFIX = "custom.googleapis.com/phoenix_hr/ai";

// One entry per distinct call site family (openai-client.ts covers 5 consumers behind one
// choke point; the sales AI paths are separate because they hit different providers).
export type AiCallComponent = "openai_client" | "sales_ai_provider" | "sales_normalizer_ai_suggest" | "sales_weekly_ai_verify";

export type AiCallStatus = "success" | "error";

export type AiCallRecord = {
  component: AiCallComponent;
  /** Short fixed label, e.g. "payroll_copilot_parse" — never a request ID or other unbounded value (metric label cardinality). */
  purpose: string;
  model: string;
  status: AiCallStatus;
  latencyMs: number;
  errorCode?: string;
  inputTokens?: number;
  outputTokens?: number;
};

let cachedAuth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!cachedAuth) cachedAuth = new GoogleAuth({ scopes: METRIC_WRITE_SCOPE });
  return cachedAuth;
}

type GaugePoint = {
  metric: { type: string; labels: Record<string, string> };
  resource: { type: "global"; labels: { project_id: string } };
  points: [{ interval: { endTime: string }; value: { doubleValue: number } }];
};

function gaugePoint(projectId: string, metricName: string, value: number, labels: Record<string, string>, endTime: string): GaugePoint {
  return {
    metric: { type: `${METRIC_PREFIX}/${metricName}`, labels },
    resource: { type: "global", labels: { project_id: projectId } },
    points: [{ interval: { endTime }, value: { doubleValue: value } }],
  };
}

/**
 * Fire-and-forget: records one AI call's outcome as Cloud Monitoring custom metrics.
 * Never throws and is never awaited by callers — call it after the request settles
 * (success or error) and move on; delivery is best-effort, not a correctness dependency.
 */
export function recordAiCall(record: AiCallRecord): void {
  void writeAiCallMetrics(record).catch(() => {
    // Best-effort telemetry — a Monitoring API failure must never surface to the caller.
  });
}

async function writeAiCallMetrics(record: AiCallRecord): Promise<void> {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) return; // Not configured (e.g. local dev) — skip silently, same as gcp-metrics.ts.

  const labels: Record<string, string> = {
    component: record.component,
    purpose: record.purpose,
    model: record.model,
    status: record.status,
  };
  if (record.errorCode) labels.error_code = record.errorCode;

  const endTime = new Date().toISOString();
  const timeSeries: GaugePoint[] = [
    gaugePoint(projectId, "request_count", 1, labels, endTime),
    gaugePoint(projectId, "latency_ms", record.latencyMs, labels, endTime),
  ];
  if (typeof record.inputTokens === "number") {
    timeSeries.push(gaugePoint(projectId, "tokens", record.inputTokens, { ...labels, direction: "input" }, endTime));
  }
  if (typeof record.outputTokens === "number") {
    timeSeries.push(gaugePoint(projectId, "tokens", record.outputTokens, { ...labels, direction: "output" }, endTime));
  }

  const token = await getAuth().getAccessToken();
  if (!token) return;

  await fetch(`${MONITORING_ENDPOINT}/projects/${projectId}/timeSeries`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ timeSeries }),
  });
}
