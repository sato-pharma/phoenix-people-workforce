// Live GCP Cloud Logging reader for the System Issues admin dashboard.
//
// Complements app_error_events (self-hosted, app-level only): this reads directly from
// Cloud Logging so infra-level failures that never reach application code — container
// crashes, OOM kills, cold-start failures — are still visible. Uses Application Default
// Credentials: the Cloud Run runtime service account in production, `gcloud auth
// application-default login` locally. Requires roles/logging.viewer on that principal;
// see docs/observability.md.

import { Logging } from "@google-cloud/logging";

export type GcpLogSeverity = "DEFAULT" | "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL" | "ALERT" | "EMERGENCY";

export type GcpLogEntry = {
  id: string;
  timestamp: string;
  severity: GcpLogSeverity;
  message: string;
  revision: string | null;
  labels: Record<string, string>;
};

export type GcpLogFetchResult =
  | { available: true; entries: GcpLogEntry[] }
  | { available: false; entries: []; error: string };

let cachedClient: Logging | null = null;

function getClient(projectId: string): Logging {
  if (!cachedClient) cachedClient = new Logging({ projectId });
  return cachedClient;
}

type LogEntryMetadata = {
  jsonPayload?: unknown;
  textPayload?: unknown;
  httpRequest?: {
    requestMethod?: string | null;
    requestUrl?: string | null;
    status?: number | null;
  } | null;
};

/**
 * Most WARNING+ entries for a Cloud Run service are the platform's own per-request
 * access log (`run.googleapis.com/requests`) — GCP auto-derives severity from the HTTP
 * status code (4xx/5xx), and these entries carry no jsonPayload/textPayload at all, only
 * `httpRequest` metadata. Before this, they fell through to "(empty log entry)", which
 * was the majority (67/100) of what the dashboard showed — technically not a parsing
 * bug (there genuinely was no text/json payload), but a missed opportunity: the
 * httpRequest metadata is exactly the information an admin wants ("GET /x -> 403").
 */
function extractMessage(entry: { data?: unknown; metadata?: LogEntryMetadata }): string {
  const payload = entry.data ?? entry.metadata?.jsonPayload ?? entry.metadata?.textPayload;
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    try {
      return JSON.stringify(record);
    } catch {
      return "(unparseable log payload)";
    }
  }
  const httpRequest = entry.metadata?.httpRequest;
  if (httpRequest?.requestMethod && httpRequest.requestUrl) {
    const path = (() => {
      try {
        return new URL(httpRequest.requestUrl).pathname;
      } catch {
        return httpRequest.requestUrl;
      }
    })();
    return `${httpRequest.requestMethod} ${path} → ${httpRequest.status ?? "?"}`;
  }
  return "(empty log entry)";
}

export type GetRecentGcpLogEntriesOptions = {
  /** Minimum severity to include (defaults to WARNING — errors + worse). */
  minSeverity?: Extract<GcpLogSeverity, "WARNING" | "ERROR" | "CRITICAL">;
  /** How far back to look, in hours (defaults to 24, capped at 168 = 7 days). */
  hoursBack?: number;
  /** Max entries to return (defaults to 100, capped at 300). */
  limit?: number;
};

/**
 * Fetches recent Cloud Run log entries at WARNING severity or above. Never throws —
 * missing project config or an unauthorized service account (IAM not yet granted
 * roles/logging.viewer) surfaces as `{ available: false, error }` so the dashboard can
 * show an explicit "not connected" state instead of a misleading empty list.
 */
export async function getRecentGcpLogEntries(options: GetRecentGcpLogEntriesOptions = {}): Promise<GcpLogFetchResult> {
  const projectId = process.env.GCP_PROJECT_ID;
  const service = process.env.GCP_CLOUD_RUN_SERVICE || "phoenix-hr";

  if (!projectId) {
    return { available: false, entries: [], error: "GCP_PROJECT_ID is not configured." };
  }

  const hoursBack = Math.min(168, Math.max(1, options.hoursBack ?? 24));
  const limit = Math.min(300, Math.max(1, options.limit ?? 100));
  const minSeverity = options.minSeverity ?? "WARNING";
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  try {
    const logging = getClient(projectId);
    const filter = [
      `resource.type="cloud_run_revision"`,
      `resource.labels.service_name="${service}"`,
      `severity>=${minSeverity}`,
      `timestamp>="${since}"`,
    ].join(" AND ");

    const [rawEntries] = await logging.getEntries({
      filter,
      orderBy: "timestamp desc",
      pageSize: limit,
    });

    const entries: GcpLogEntry[] = rawEntries.slice(0, limit).map((entry) => {
      const metadata = entry.metadata;
      const ts = metadata.timestamp;
      const timestamp = typeof ts === "string" ? ts : ts instanceof Date ? ts.toISOString() : new Date().toISOString();
      return {
        id: String(metadata.insertId ?? `${timestamp}-${Math.random().toString(36).slice(2)}`),
        labels: (metadata.labels as Record<string, string>) ?? {},
        message: extractMessage(entry),
        revision: (metadata.labels as Record<string, string> | undefined)?.["revision_name"] ?? null,
        severity: (metadata.severity as GcpLogSeverity) ?? "DEFAULT",
        timestamp,
      };
    });

    return { available: true, entries };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GCP Cloud Logging error";
    return { available: false, entries: [], error: message };
  }
}
