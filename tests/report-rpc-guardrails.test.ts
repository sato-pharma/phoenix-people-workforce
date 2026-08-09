import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Guards born from two near-misses:
 *  (a) heavy report RPCs MUST carry a per-function statement_timeout — the 8s authenticator
 *      default cancelled the 16.7s ROI attribution query and returned HTTP 500; and
 *  (b) ROI region MUST stay brick-authoritative (source_of_sales_customer_map) and never be
 *      derived from the requester — a locked rule that was nearly removed.
 *
 * REWRITTEN 2026-07-28. The previous version read a handful of HARDCODED migration files under
 * supabase/_migrations_archive/pre-baseline-2026-07-11/ and asserted each contained an
 * `alter function ... set statement_timeout` statement. Those files are frozen history: the
 * assertions were permanently true and could never fail, so the guard could not detect the very
 * regression it existed to prevent.
 *
 * It didn't: `CREATE OR REPLACE FUNCTION` silently DROPS any setting previously applied via
 * `ALTER FUNCTION ... SET`, so a later migration that recreated a function without re-declaring
 * the timeout quietly removed it. Verified against production 2026-07-28 — three of the four RPCs
 * the old test "protected" had already lost their timeout while it stayed green:
 * phx_marketing_roi_latest_validated_period (lost at 20260623170000_roi_latest_period_rewrite.sql),
 * phx_monthly_closing_matrix and phx_monthly_closing_direct.
 *
 * This version instead REPLAYS every migration chronologically and models what Postgres actually
 * ends up with, so a recreate-without-timeout fails CI at the commit that introduces it.
 */

// Archive first, then live: the archive holds everything up to the 2026-07-11 baseline cut (its
// newest filename is 2026-07-08) and supabase/migrations/ starts at that baseline, so
// concatenating each directory's own lexically-sorted (= chronological) listing is equivalent to
// one global chronological scan.
const MIGRATION_DIRS = [
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/", import.meta.url),
  new URL("../supabase/migrations/", import.meta.url),
];

function allMigrationSql(): { name: string; sql: string }[] {
  return MIGRATION_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") })),
  );
}

const MIGRATIONS = allMigrationSql();

/**
 * Replays every migration and returns the statement_timeout Postgres would hold for `funcName`
 * today, or null if none. Models the two things that change it:
 *   - CREATE [OR REPLACE] FUNCTION — sets the timeout if the header declares one, CLEARS it
 *     otherwise (this is the trap: a recreate silently discards an earlier ALTER ... SET).
 *   - ALTER FUNCTION ... SET statement_timeout — (re-)applies it.
 * Only the function header (signature up to the `AS $tag$` body opener) is inspected for the
 * CREATE case, so a `set statement_timeout` appearing inside a body string can't produce a false
 * positive.
 */
function resolvedStatementTimeout(funcName: string): string | null {
  const createRe = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${funcName}\\s*\\(`, "gi");
  const alterRe = new RegExp(
    `alter\\s+function\\s+public\\.${funcName}\\b[^;]*?set\\s+statement_timeout\\s*(?:=|to)\\s*'?([\\w]+)'?`,
    "gi",
  );
  let current: string | null = null;

  for (const { sql } of MIGRATIONS) {
    // Collect every timeout-affecting event in this file, in file order.
    const events: { at: number; timeout: string | null }[] = [];

    createRe.lastIndex = 0;
    for (let m = createRe.exec(sql); m; m = createRe.exec(sql)) {
      const rest = sql.slice(m.index);
      const bodyStart = /\bas\s+\$[a-zA-Z_]*\$/i.exec(rest);
      const header = bodyStart ? rest.slice(0, bodyStart.index) : rest.slice(0, 2000);
      const declared = /set\s+statement_timeout\s*(?:=|to)\s*'?([\w]+)'?/i.exec(header);
      events.push({ at: m.index, timeout: declared ? declared[1]! : null });
    }

    alterRe.lastIndex = 0;
    for (let m = alterRe.exec(sql); m; m = alterRe.exec(sql)) {
      events.push({ at: m.index, timeout: m[1]! });
    }

    for (const e of events.sort((a, b) => a.at - b.at)) current = e.timeout;
  }
  return current;
}

/**
 * Every RPC that runs a heavy report query on a user request path. Losing the timeout here means
 * falling back to the 8s authenticator default mid-query — an HTTP 500 for the user.
 */
const RPCS_REQUIRING_TIMEOUT = [
  // ROI attribution — the original 500.
  "phx_marketing_request_roi_actuals",
  "phx_marketing_request_roi_actuals_v2",
  "phx_marketing_request_view_sales",
  // The shared sales-lines function both ROI engines above now project from
  // (20260809020000_marketing_sales_lines_shared_function.sql). It does the actual heavy join
  // against source_of_sales_import_rows, so it needs its OWN timeout — a caller's timeout does not
  // extend to it, and listing it here is what stops this guard passing by inheritance.
  "phx_marketing_request_sales_lines",
  "phx_marketing_roi_customer_dashboard",
  "phx_marketing_roi_latest_validated_period",
  // Bulk sales-detail export: joins source_of_sales_import_rows (the largest table in the
  // database) across an arbitrary array of request ids, called live from the coverage export.
  "phx_marketing_coverage_export_sales_detail",
  // Fact-table reader behind NEXT_PUBLIC_SMI_USE_FACT_TABLES; SECURITY DEFINER.
  "phx_marketing_roi_fast",
  // Other live report RPCs.
  "phx_vacation_report_rows",
  "phx_monthly_closing_matrix",
  "phx_monthly_closing_direct",
] as const;

function testEveryHeavyReportRpcKeepsItsTimeout() {
  const missing: string[] = [];
  for (const rpc of RPCS_REQUIRING_TIMEOUT) {
    if (resolvedStatementTimeout(rpc) === null) missing.push(rpc);
  }
  assert.deepEqual(
    missing,
    [],
    `These report RPCs resolve to NO statement_timeout after replaying every migration, so they ` +
      `run under the 8s authenticator default and will 500 on a slow query. Note CREATE OR REPLACE ` +
      `DROPS a timeout applied earlier via ALTER FUNCTION — if you recreated one of these, ` +
      `re-declare "SET statement_timeout" in the CREATE itself. Offenders: ${missing.join(", ")}`,
  );
}

/**
 * Self-check: the replay must actually be capable of returning null, and must read the LIVE
 * migrations directory rather than only the frozen archive. Without this, a future refactor could
 * quietly reduce the guard above to a tautology again — which is exactly how it failed before.
 */
function testReplayIsMeaningful() {
  assert.equal(
    resolvedStatementTimeout("phx_no_such_function_should_never_exist"),
    null,
    "replay must return null for a function no migration defines (otherwise the guard is vacuous)",
  );

  const liveDir = readdirSync(MIGRATION_DIRS[1]!).filter((f) => f.endsWith(".sql"));
  assert.ok(liveDir.length > 0, "the LIVE supabase/migrations directory must be scanned, not just the archive");
  assert.ok(
    MIGRATIONS.length > liveDir.length,
    "both the archive and the live migrations directory must be included in the replay",
  );

  // The baseline is a pg_dump using bare `CREATE FUNCTION` (no OR REPLACE) — if the CREATE regex
  // stopped matching that form, every timeout would appear to come only from ALTERs and the
  // recreate-clears-timeout trap would go undetected again.
  assert.match(
    resolvedStatementTimeout("phx_marketing_request_roi_actuals_v2") ?? "",
    /^\d+s$/,
    "a known-good RPC must resolve to a concrete timeout value (proves CREATE headers are parsed)",
  );
}

function testRoiRegionStaysBrickAuthoritative() {
  const all = MIGRATIONS.map((m) => m.sql).join("\n");
  assert.match(
    all,
    /source_of_sales_customer_map/,
    "ROI dashboard region must come from the customer map (brick), not be inferred",
  );
  assert.match(
    all,
    /region must never come from the requester|brick is the authoritative geography/i,
    "the locked brick-authoritative region rule must stay documented (it was nearly removed)",
  );
}

export function runReportRpcGuardrailTests() {
  testReplayIsMeaningful();
  testEveryHeavyReportRpcKeepsItsTimeout();
  testRoiRegionStaysBrickAuthoritative();
}
