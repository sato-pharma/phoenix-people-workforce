// Release identity and the write gate for app_error_events.
//
// This file used to also hold the deploy-derived "Active / Resolved" status of the retired System
// Issues dashboard: an error read Resolved the moment a deploy shipped, whether or not anything was
// fixed. The System Audit (/admin/system-audit) replaced that with a ledger whose FIXED — VERIFIED
// status only a verifier can set, so the derived status went with the dashboard on 23 Oct 2026.

import { getDeployRevisionTag } from "@/lib/observability/deploy-identity";

/**
 * The identifier stamped onto every app_error_events row at capture time
 * (app/api/errors/client/route.ts). Both the capture path and this query path resolve it
 * through the shared deploy-identity module so their precedence cannot drift apart — see the
 * note there for why that is load-bearing, and why Railway had to be added to the chain after
 * the 2026-08-01 cutover left every row stamped "unknown".
 */
export function getCurrentReleaseTag(): string {
  return getDeployRevisionTag();
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
 * behind the app-error findings on /admin/system-audit.
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
