// Deploy-aware, fully-derived status for the System Issues dashboard.
//
// There is deliberately NO manual "mark as resolved" action. Status is computed purely
// from observed data every time the dashboard loads, so it can never claim an issue is
// fixed when it isn't:
//
//   Active   — the error still occurs on the currently-deployed build.
//   Resolved — it does not occur on the current build (a real fix ships in a deploy;
//              "not happening on the code that's live right now" is the truthful signal).
//
// If a "Resolved" error happens again on the current build, it is Active again on the
// next load — no separate reopen concept, no human ever asserts a fix.

export type IssueStatus = "active" | "resolved";

/**
 * The identifier stamped onto every app_error_events row at capture time
 * (app/api/errors/client/route.ts): COMMIT_SHA if the build set it, otherwise the
 * Cloud Run revision name (K_REVISION), otherwise "unknown". Computed here with the
 * IDENTICAL precedence so a live error's stored `release` matches this exactly.
 */
export function getCurrentReleaseTag(): string {
  return process.env.COMMIT_SHA || process.env.K_REVISION || "unknown";
}

/**
 * Whether crash reports from THIS process should be persisted to `app_error_events`
 * (see logAppError in ./service.ts, the single writer).
 *
 * False under `next dev` only. This exists because `.env.local` on the maintainer machines
 * points at the PRODUCTION Supabase project, so a local dev server's normal
 * iterate-and-reload cycle was inserting rows straight into the production error table:
 * in the 7 days to 2026-07-30 that table held 103 `environment='development'` rows against
 * 46 real production ones. The dev rows are indistinguishable at a glance from an outage
 * (they cluster on whatever page is being built and read as `X is not defined` bursts), so
 * they actively mislead anyone triaging production health — this table is the data source
 * behind /admin/error-monitor and /admin/system-issues.
 *
 * NODE_ENV is the right signal rather than the `environment` label: a real deployed build is
 * always NODE_ENV=production (both Cloud Run services), and staging deliberately KEEPS its
 * error events — they land in the staging Supabase project, where they belong. Only `next dev`
 * reports NODE_ENV=development.
 *
 * Escape hatch: set PHOENIX_PERSIST_DEV_ERROR_EVENTS=true to opt a local session back in
 * (e.g. when deliberately reproducing an ingestion bug against a non-production project).
 */
export function shouldPersistErrorEvents(): boolean {
  if (process.env.PHOENIX_PERSIST_DEV_ERROR_EVENTS === "true") return true;
  return process.env.NODE_ENV === "production";
}

/**
 * GCP Cloud Logging entries carry the Cloud Run revision name (never a commit SHA), so
 * they are compared against K_REVISION directly. Null off Cloud Run (local dev), which
 * makes every GCP entry resolve to "resolved" locally — acceptable, since local has no
 * meaningful "current revision" to be active on.
 */
export function getCurrentRevision(): string | null {
  return process.env.K_REVISION || null;
}

/** Stable per-error grouping key: two errors are "the same issue" if module + route match. */
export function signatureKey(moduleKey: string, route: string | null): string {
  return `${moduleKey}|${route ?? ""}`;
}

/**
 * App errors (Tab 1 and Tab 2 app_error rows): Active iff this error's signature has at
 * least one occurrence on the current release. `activeSignatures` is precomputed once
 * per load from a single indexed query, so status is consistent across every row of the
 * same signature (old occurrences of a still-happening error correctly read Active too).
 */
export function deriveAppErrorStatus(key: string, activeSignatures: Set<string>): IssueStatus {
  return activeSignatures.has(key) ? "active" : "resolved";
}

/** GCP infra entries: Active iff the entry is on the current Cloud Run revision. */
export function deriveGcpStatus(entryRevision: string | null, currentRevision: string | null): IssueStatus {
  if (!entryRevision || !currentRevision) return "resolved";
  return entryRevision === currentRevision ? "active" : "resolved";
}

// Failed logins have no deploy/release concept — a login problem is "over" once the user
// stops failing (they got in or gave up), so recency is the only truthful signal here.
export const FAILED_LOGIN_ACTIVE_WINDOW_HOURS = 24;

/** Failed-login rows (Tab 2): Active iff the user has failed a login within the window. */
export function deriveFailedLoginStatus(
  lastSeenIso: string,
  nowMs: number,
  windowHours: number = FAILED_LOGIN_ACTIVE_WINDOW_HOURS,
): IssueStatus {
  const lastSeenMs = new Date(lastSeenIso).getTime();
  if (!Number.isFinite(lastSeenMs)) return "resolved";
  return nowMs - lastSeenMs <= windowHours * 60 * 60 * 1000 ? "active" : "resolved";
}
