// Shared data-loading for /admin/system-issues: the server-rendered page and the
// client-refresh API routes (app/api/admin/system-issues/**) both call these so the
// "derive current status" logic lives in exactly one place.
//
// Status is deploy-aware and fully derived — never stored, never set by a human. See
// src/lib/error-monitor/derived-status.ts.

import {
  getAccountDirectory,
  getActiveErrorSignatures,
  getErrorEvents,
  getUserAttemptSummary,
  type ErrorEventRow,
  type UserAttemptRow,
} from "@/lib/error-monitor/service";
import { getRecentGcpLogEntries, type GcpLogEntry } from "@/lib/observability/gcp-logs";
import { getServiceHealthSnapshot, type ServiceHealthResult } from "@/lib/observability/gcp-metrics";
import {
  deriveAppErrorStatus,
  deriveFailedLoginStatus,
  deriveGcpStatus,
  getCurrentReleaseTag,
  getCurrentRevision,
  signatureKey,
  type IssueStatus,
} from "@/lib/error-monitor/derived-status";
import { decodeErrorMessage } from "@/lib/error-monitor/message-decode";
import { hasOpenAiApiKey } from "@/lib/ai/openai-client";
import { canonicalHrIdKey } from "@/lib/hr-id";

export type ErrorEventRowWithStatus = ErrorEventRow & { status: IssueStatus; displayMessage: string; employeeName: string | null };
export type GcpLogEntryWithStatus = GcpLogEntry & { status: IssueStatus; displayMessage: string };
export type { ServiceHealthResult } from "@/lib/observability/gcp-metrics";
export type UserAttemptRowWithStatus = UserAttemptRow & { status: IssueStatus; displayMessage: string; employeeName: string | null; employeeRole: string | null };

export async function loadSystemIssuesSnapshot(hoursBack = 24) {
  const currentRelease = getCurrentReleaseTag();
  const currentRevision = getCurrentRevision();
  const [appErrors, gcpLogs, activeSignatures, directory, serviceHealth] = await Promise.all([
    getErrorEvents({ pageSize: 100 }),
    getRecentGcpLogEntries({ hoursBack }),
    getActiveErrorSignatures(currentRelease),
    getAccountDirectory(),
    // Non-fatal: the reader returns { available: false, error } instead of throwing, so a
    // missing GCP config / IAM grant never breaks the rest of the snapshot.
    getServiceHealthSnapshot(),
  ]);

  const appErrorsWithStatus = {
    ...appErrors,
    events: appErrors.events.map((event): ErrorEventRowWithStatus => ({
      ...event,
      displayMessage: decodeErrorMessage(event.message, event.stack).display,
      employeeName: directory.get(canonicalHrIdKey(event.hrId) ?? "")?.name ?? null,
      status: deriveAppErrorStatus(signatureKey(event.moduleKey, event.route), activeSignatures),
    })),
  };

  const gcpLogsWithStatus = gcpLogs.available
    ? {
        ...gcpLogs,
        entries: gcpLogs.entries.map((entry): GcpLogEntryWithStatus => ({
          ...entry,
          displayMessage: decodeErrorMessage(entry.message).display,
          status: deriveGcpStatus(entry.revision, currentRevision),
        })),
      }
    : gcpLogs;

  return {
    aiEnabled: hasOpenAiApiKey(),
    appErrors: appErrorsWithStatus,
    gcpLogs: gcpLogsWithStatus,
    serviceHealth: serviceHealth satisfies ServiceHealthResult,
  };
}

export async function loadUserAttemptsSnapshot(filter: { hrId?: string | null; dateFrom?: string | null; dateTo?: string | null } = {}) {
  const currentRelease = getCurrentReleaseTag();
  const [summary, activeSignatures, directory] = await Promise.all([
    getUserAttemptSummary(filter),
    getActiveErrorSignatures(currentRelease),
    getAccountDirectory(),
  ]);
  const now = Date.now();

  return {
    ...summary,
    rows: summary.rows.map((row): UserAttemptRowWithStatus => {
      const identity = directory.get(canonicalHrIdKey(row.hrId) ?? "");
      return {
        ...row,
        displayMessage: decodeErrorMessage(row.sampleMessage).display,
        employeeName: identity?.name ?? null,
        employeeRole: identity?.role ?? null,
        status:
          row.category === "app_error"
            ? deriveAppErrorStatus(signatureKey(row.moduleKey, row.route), activeSignatures)
            : deriveFailedLoginStatus(row.lastSeen, now),
      };
    }),
  };
}
