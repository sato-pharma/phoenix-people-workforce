import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { showsAwaitingFinanceMonth } from "../src/lib/direct-orders/types.ts";

/**
 * Guards for the Finance Manager's landing dashboard (/admin/finance-command-center).
 *
 * Three invariants, each pinned because breaking it is silent:
 *
 *  1. DEDUCTION SOURCE. Every deduction figure must come from committed payroll, never from
 *     `deductions_candidates`. Measured on production 2026-08-10, July's candidate estimates
 *     totalled 1,833,169.35 EGP against 25,577.65 EGP actually committed — the dashboard would
 *     have been wrong by ~72x, and the CRM line alone by 1,257,693 EGP against a real 0.00.
 *     src/lib/deductions/calculations.ts already carries a comment about the same class of error
 *     ("HR ended up reading a number ~3x larger than what publish would actually commit"), so
 *     this is a repeat offence waiting to happen, not a hypothetical.
 *  2. ROUND-TRIP BUDGET. The service is one RPC call and nothing else. The repo has no other
 *     per-page query budget test; the failure it prevents is the CEO Command Center's, whose
 *     Phase A fans out transitively into the low hundreds of round trips.
 *  3. PREDICATE PARITY. "Unbooked direct order" is defined in TypeScript AND in SQL. Two
 *     definitions of the same money question drift; this asserts they agree.
 */

const MIGRATION_PATH = "supabase/migrations/20260810170000_phx_finance_command_center.sql";
const SERVICE_PATH = "src/lib/finance/command-center.ts";
const PAGE_PATH = "app/(admin)/admin/finance-command-center/page.tsx";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Drop `--` line comments. Prose explaining WHY a table is banned must not trip the guard that
 * enforces the ban. Keeps string literals, so predicate assertions can still match them.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * Reduce a migration to the SQL that actually EXECUTES — comments AND single-quoted literals
 * gone. Used only for the banned-table check, because `COMMENT ON FUNCTION ... IS '...'`
 * documents the ban by naming the table, and documentation is not a read. The plpgsql body is
 * `$$`-delimited rather than quote-delimited, so it survives intact — which is the part under test.
 */
function executableSql(sql: string): string {
  return stripSqlComments(sql).replace(/'(?:[^']|'')*'/g, "''");
}

/** Strip `//` and block comments from TS for the same reason. */
function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function testDeductionsComeFromCommittedPayrollOnly() {
  const migrationSql = executableSql(read(MIGRATION_PATH));
  const serviceSource = stripTsComments(read(SERVICE_PATH));

  for (const [label, body] of [["migration", migrationSql], ["service", serviceSource]] as const) {
    assert.ok(
      !/deductions_candidates/i.test(body),
      `${label} must never read deductions_candidates — that table holds what the detection engines SUGGEST, not what payroll committed (July 2026: 1,833,169.35 estimated vs 25,577.65 actually charged)`,
    );
    assert.ok(
      !/estimated_amount/i.test(body),
      `${label} must never read estimated_amount — the committed figure lives in salary_records / automated_payroll_draft_rows`,
    );
  }

  // The positive half: it is not enough to avoid the wrong table, it has to read the right ones.
  assert.ok(
    /salary_records/i.test(migrationSql),
    "closed-month deductions must be summed from salary_records, the table payroll actually wrote",
  );
  assert.ok(
    /automated_payroll_draft_rows/i.test(migrationSql),
    "the in-flight run's deductions must come from automated_payroll_draft_rows (the p1od_* owner decisions)",
  );
  // `excluded` rows are not in the run; counting them would inflate every total on the page.
  assert.ok(
    /excluded/i.test(migrationSql),
    "draft-row aggregates must honour `excluded`, or a row removed from the run still moves the money figures",
  );
}

function testSingleRoundTripBudget() {
  const serviceSource = stripTsComments(read(SERVICE_PATH));

  const rpcCalls = serviceSource.match(/\.rpc\(/g) ?? [];
  assert.equal(
    rpcCalls.length,
    1,
    `the finance dashboard service must make exactly ONE rpc call, found ${rpcCalls.length} — the whole point of aggregating in Postgres is that the page costs one round trip`,
  );

  const tableReads = serviceSource.match(/\.from\(/g) ?? [];
  assert.equal(
    tableReads.length,
    0,
    `the finance dashboard service must not query tables directly, found ${tableReads.length} .from( call(s) — every aggregate belongs in phx_finance_command_center`,
  );

  assert.ok(
    /unstable_cache\(/.test(serviceSource),
    "the RPC result must be wrapped in unstable_cache so repeat loads cost nothing",
  );
  assert.ok(
    /revalidate:\s*300/.test(serviceSource),
    "cache TTL must stay at the 300s the other dashboard caches use",
  );
  // A cached failure serves wrong money figures for the full TTL, so the failure path must sit
  // OUTSIDE the cached function — allSettled in the caller, never a try/catch returning a
  // zeroed payload from inside unstable_cache.
  assert.ok(
    /Promise\.allSettled/.test(serviceSource),
    "sources must resolve independently so one failing degrades a section instead of the page",
  );
  assert.ok(
    /unavailable/.test(serviceSource),
    "a failed source must be reported as unavailable, never rendered as a confident zero",
  );
}

function testUnbookedPredicateMatchesTypescript() {
  // The TS definition, which the direct-order report and its "Book month" link both use.
  assert.equal(showsAwaitingFinanceMonth("approved", null), true, "approved with no sales month is unbooked");
  assert.equal(showsAwaitingFinanceMonth("approved", "2026-07"), false, "a booked order is not awaiting Finance");
  assert.equal(showsAwaitingFinanceMonth("pending_approval", null), false, "only APPROVED orders await a month");
  assert.equal(showsAwaitingFinanceMonth("rejected", null), false, "a rejected order is never awaiting a month");
  assert.equal(showsAwaitingFinanceMonth("held", null), false, "a held order is parked, not awaiting Finance");

  // The SQL definition must express the same two conditions together.
  const migrationSql = stripSqlComments(read(MIGRATION_PATH));
  const awaitingClause = /lower\(coalesce\(status, ''\)\) = 'approved' and sales_month is null/i;
  assert.ok(
    awaitingClause.test(migrationSql),
    "the RPC's unbooked predicate must be `status = 'approved' AND sales_month IS NULL`, matching showsAwaitingFinanceMonth — two definitions of the same money question drift apart",
  );
}

function testMigrationKeepsItsTimeoutAndLocksDownExecute() {
  const raw = read(MIGRATION_PATH);
  const sql = stripSqlComments(raw);

  // Set INSIDE the CREATE header: a later `ALTER FUNCTION ... SET` is silently dropped by the
  // next CREATE OR REPLACE, which is how three protected RPCs lost their timeout and started
  // returning HTTP 500 at the 8s authenticator default.
  assert.ok(
    /set statement_timeout to '20s'/i.test(sql),
    "phx_finance_command_center must declare its statement_timeout in the CREATE header",
  );

  // scripts/check-migrations.mjs rule 4 — anon/authenticated inherit EXECUTE through PUBLIC, so
  // revoking only those two is a no-op; and revoking PUBLIC on a default ACL strips service_role,
  // hence the explicit re-grant.
  assert.ok(
    /revoke\s+execute\s+on\s+function\s+public\.phx_finance_command_center[^;]*from[^;]*public/i.test(sql),
    "a public SECURITY DEFINER function must REVOKE EXECUTE FROM PUBLIC",
  );
  assert.ok(
    /grant\s+execute\s+on\s+function\s+public\.phx_finance_command_center[^;]*to\s+service_role/i.test(sql),
    "service_role must be re-granted explicitly after the revoke, or the app cannot call its own RPC",
  );
}

function testPageIsRoleGatedNotPermissionGated() {
  const pageSource = read(PAGE_PATH);

  // The Finance Manager holds no `overview` grant at all (see the matrix in permissions.ts), so a
  // permission-based gate would lock him out of his own landing page. Same reasoning as the CEO
  // and SFE command centers, which both gate on the role.
  assert.ok(
    /access\.role === "Finance Manager"/.test(pageSource),
    "the page must gate on the Finance Manager role — he has no `overview` permission to gate on",
  );
  assert.ok(
    /canAccessSystemAdministratorWorkspace\(access\)/.test(pageSource),
    "Super Admin must keep access so the page can be supported without borrowing his account",
  );
  assert.ok(
    /redirect\("\/employee-portals"\)/.test(pageSource),
    "a portal-mode viewer must be bounced before any data work starts",
  );
}

function testLandingAndNavAgree() {
  const landing = read("src/lib/auth/landing.ts");
  const adminPage = read("app/(admin)/admin/page.tsx");
  const nav = read("src/config/system-navigation.ts");

  assert.ok(
    /finance manager"\s*\)\s*return "\/admin\/finance-command-center"/.test(landing.replace(/\s+/g, " ")) ||
      /"\/admin\/finance-command-center"/.test(landing),
    "login must land the Finance Manager on his own command center",
  );
  // Without this he sees TWO command-center rows and /admin sends him to the generic dashboard.
  assert.ok(
    /DEDICATED_COMMAND_CENTER_ROLES[^;]*"Finance Manager"/.test(adminPage),
    "a role with its own command center must be redirected off the generic /admin surface",
  );
  assert.ok(
    /href: "\/admin\/finance-command-center"/.test(nav),
    "the sidebar must carry a route to the page — an unreachable page is the same as no page",
  );
  assert.ok(
    /excludedRoles: \["CEO", "SFE Manager", "Finance Manager"\]/.test(nav),
    "the generic Command Center row must exclude every role that has its own",
  );
}

export function runFinanceCommandCenterTests() {
  testDeductionsComeFromCommittedPayrollOnly();
  testSingleRoundTripBudget();
  testUnbookedPredicateMatchesTypescript();
  testMigrationKeepsItsTimeoutAndLocksDownExecute();
  testPageIsRoleGatedNotPermissionGated();
  testLandingAndNavAgree();
}
