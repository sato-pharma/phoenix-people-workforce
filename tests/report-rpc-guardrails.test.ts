import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/**
 * Guards born from two near-misses this session:
 *  (a) heavy report RPCs MUST carry a per-function statement_timeout — the 8s authenticator
 *      default cancelled the 16.7s ROI attribution query and returned HTTP 500; and
 *  (b) ROI region MUST stay brick-authoritative (source_of_sales_customer_map) and never be
 *      derived from the requester — a locked rule that was nearly removed.
 * Pinned against the migration files so a revert is caught in CI.
 */
export function runReportRpcGuardrailTests() {
  // ── (a) statement_timeout regression guards ──────────────────────────────────────────────
  // The ROI attribution RPCs get their 45s via a dedicated ALTER migration.
  const roiTimeout = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260622100000_marketing_roi_rpc_statement_timeout.sql");
  for (const rpc of [
    "phx_marketing_request_roi_actuals_v2",
    "phx_marketing_request_roi_actuals",
    "phx_marketing_request_view_sales",
  ]) {
    assert.match(
      roiTimeout,
      new RegExp(`alter function public\\.${rpc}\\b[\\s\\S]*?set statement_timeout`, "i"),
      `${rpc} must keep its statement_timeout (the 8s default 500'd the ROI report)`,
    );
  }

  // The remaining live report RPCs (vacation report + monthly closing + the ROI "as-of" badge).
  const followups = source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260622130000_report_rpc_statement_timeout_followups.sql");
  for (const rpc of [
    "phx_vacation_report_rows",
    "phx_monthly_closing_matrix",
    "phx_monthly_closing_direct",
    "phx_marketing_roi_latest_validated_period",
  ]) {
    assert.match(
      followups,
      new RegExp(`alter function public\\.${rpc}\\b[\\s\\S]*?set statement_timeout`, "i"),
      `${rpc} (a live report RPC) must carry a statement_timeout`,
    );
  }

  // The executive-report timeout/perf migration must not silently lose its timeout config.
  assert.match(
    source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260608010000_exec_report_rpc_timeout_and_perf.sql"),
    /set statement_timeout/i,
    "the executive-report timeout/perf migration must keep its statement_timeout",
  );

  // ── (b) ROI region is brick-authoritative, never the requester ──────────────────────────
  assert.match(
    source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260620140000_marketing_roi_customer_code_only.sql"),
    /source_of_sales_customer_map/,
    "ROI dashboard region must come from the customer map (brick), not be inferred",
  );
  assert.match(
    source("supabase/_migrations_archive/pre-baseline-2026-07-11/20260621230000_marketing_roi_dashboard_line_from_requester.sql"),
    /region must never come from the requester|brick is the authoritative geography/i,
    "the locked brick-authoritative region rule must stay documented (it was nearly removed)",
  );
}
