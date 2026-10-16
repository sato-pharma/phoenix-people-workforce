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
  partitionUserAttempts,
  type ErrorEventRow,
  type UserAttemptRow,
} from "@/lib/error-monitor/service";
import {
  deriveAppErrorStatus,
  deriveFailedLoginStatus,
  getCurrentReleaseTag,
  signatureKey,
  type IssueStatus,
} from "@/lib/error-monitor/derived-status";
import { decodeErrorMessage } from "@/lib/error-monitor/message-decode";
import { hasOpenAiApiKey } from "@/lib/ai/openai-client";
import { canonicalHrIdKey } from "@/lib/hr-id";

export type ErrorEventRowWithStatus = ErrorEventRow & { status: IssueStatus; displayMessage: string; employeeName: string | null };
export type UserAttemptRowWithStatus = UserAttemptRow & { status: IssueStatus; displayMessage: string; employeeName: string | null; employeeRole: string | null };
export type { UnknownAttemptsSummary } from "@/lib/error-monitor/service";

export async function loadSystemIssuesSnapshot() {
  const currentRelease = getCurrentReleaseTag();
  const [appErrors, activeSignatures, directory] = await Promise.all([
    getErrorEvents({ pageSize: 100 }),
    getActiveErrorSignatures(currentRelease),
    getAccountDirectory(),
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

  return {
    aiEnabled: hasOpenAiApiKey(),
    appErrors: appErrorsWithStatus,
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

  const rowsWithStatus = summary.rows.map((row): UserAttemptRowWithStatus => {
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
  });

  // Keep only rows that resolve to a real app_auth_users account; fold the rest
  // (test/synthetic/probe/typo login ids) into an aggregate so genuine probing stays
  // visible without polluting the per-user list. The directory is the authoritative
  // "real account" source, so this needs no hardcoded exclusion list to maintain.
  const { realRows, unknownAttempts } = partitionUserAttempts(
    rowsWithStatus,
    (hrId) => directory.get(canonicalHrIdKey(hrId) ?? "") != null,
  );

  return { ...summary, rows: realRows, unknownAttempts };
}
