import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  financeDownloadScope,
  isRealCalendarDate,
  parseBankFileScope,
  parseFinanceSheetScope,
} from "../src/lib/automated-payroll/finance-links.ts";
import { showsAwaitingFinanceMonth } from "../src/lib/direct-orders/types.ts";
import { resolveMarketingInvoiceObligation } from "../src/lib/marketing-requests/invoice-obligation.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Guards for the Finance Manager's landing dashboard (/admin/finance-command-center).
 *
 * Five invariants, each pinned because breaking it is silent:
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
 *  4. A WINDOW HAS TWO ENDS. The two leaver counters shipped bounded at the bottom only, so each
 *     read "this month or any month after it" under a label saying "this month". Forward-dated
 *     exit rows are the normal case, not an edge one, and the page cannot show that a figure
 *     covers a wider window than it names.
 *  5. ONE TREND POINT PER MONTH. The committed-payroll trend is keyed on the period, so the
 *     grouping key must be the period too. Three consumers — the chart's React key, the
 *     month-over-month delta chain, and the "Net payroll" tile's read of the LAST entry — all
 *     assume it, and `limit` counts grouped rows, so a split month would shorten the window too.
 */

/**
 * Every migration that defines phx_finance_command_center, oldest first. The LAST one is the live
 * definition, and it is the one the invariants below are really about — but each is checked,
 * because a `CREATE OR REPLACE` that quietly drops the statement_timeout or re-introduces the
 * banned table is exactly the regression this file exists to catch, and it can be introduced by
 * any of them.
 */
const MIGRATION_PATHS = [
  "supabase/migrations/20260810170000_phx_finance_command_center.sql",
  "supabase/migrations/20260811010000_finance_command_center_direct_orders_marketing_depth.sql",
  "supabase/migrations/20260811020000_finance_command_center_parts_and_channels.sql",
  "supabase/migrations/20260830003000_finance_command_center_invoice_overdue.sql",
  "supabase/migrations/20260922190000_finance_command_center_exit_month_upper_bound.sql",
  "supabase/migrations/20260922200000_finance_command_center_committed_trend_one_row_per_month.sql",
] as const;

/** The definition currently in the database — the last CREATE OR REPLACE wins. */
const MIGRATION_PATH = MIGRATION_PATHS[MIGRATION_PATHS.length - 1]!;
const SERVICE_PATH = "src/lib/finance/command-center.ts";
const PAGE_PATH = "app/(admin)/admin/finance-command-center/page.tsx";

function read(path: string): string {
  return readFileSync(path, "utf8");
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
  return stripComments(source);
}

function testDeductionsComeFromCommittedPayrollOnly() {
  const serviceSource = stripTsComments(read(SERVICE_PATH));
  const bodies: Array<readonly [string, string]> = [
    ...MIGRATION_PATHS.map((path) => [path, executableSql(read(path))] as const),
    ["service", serviceSource] as const,
  ];

  for (const [label, body] of bodies) {
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
  const migrationSql = executableSql(read(MIGRATION_PATH));
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

/**
 * PREDICATE PARITY, second instance — "the marketing invoice is overdue".
 *
 * Same failure this file already guards for the direct-order `unbooked` predicate, on a rule with a
 * wider blast radius: `resolveMarketingInvoiceObligation` is what the Approved Requests tab, the
 * Marketing Requests export and the nightly nudge (#2695) all call, and the dashboard figure added
 * in 20260830003000 is the one place the same question is asked in SQL. If they disagree, finance is
 * paged about a number his own landing page contradicts — which is worse than no number at all.
 */
function testInvoiceOverduePredicateMatchesTypescript() {
  const pending = (deadline: string) => ({ invoiceDeadlineDate: deadline, invoiceStatus: "pending" });

  // Condition 1 — the boundary. Strictly EARLIER than today, never `<=`.
  assert.equal(
    resolveMarketingInvoiceObligation(pending("2026-09-02"), "2026-09-02").isOverdue,
    false,
    "a deadline of the 2nd means 'by the end of the 2nd' — nobody is late on the day they are still on time",
  );
  assert.equal(
    resolveMarketingInvoiceObligation(pending("2026-09-02"), "2026-09-03").isOverdue,
    true,
    "and late the day after — this pair is what makes the boundary assertable rather than assumed",
  );

  // Condition 2 — only a `pending` obligation can go late. `hold` is the one that matters: it is a
  // pause a human chose, and production's single 18-day-old row is in exactly that state.
  for (const status of ["submitted", "cleared", "not_required", "hold"]) {
    assert.equal(
      resolveMarketingInvoiceObligation(
        { invoiceDeadlineDate: "2026-08-11", invoiceStatus: status },
        "2026-08-29",
      ).isOverdue,
      false,
      `an invoice marked '${status}' is never overdue, 18 days past its deadline or not`,
    );
  }

  // The SQL must express BOTH conditions, together, in all three figures it feeds — count, value and
  // oldest. Asserting the count alone would let a later edit fix one and leave the money figure
  // reading a different population from the number printed beside it.
  const migrationSql = stripSqlComments(read(MIGRATION_PATH));
  const overdueClause =
    /lower\(coalesce\(f\.invoice_status, ''\)\) = 'pending'\s+and f\.invoice_deadline_date is not null\s+and f\.invoice_deadline_date < \(now\(\) at time zone 'Africa\/Cairo'\)::date/g;
  const matches = migrationSql.match(overdueClause) ?? [];
  assert.equal(
    matches.length,
    3,
    `all three overdue figures must share one predicate — status = 'pending' AND deadline < today in Cairo — found ${matches.length} of 3`,
  );
  assert.ok(
    !/invoice_deadline_date\s*<=/.test(migrationSql),
    "`<=` would call an invoice late on its own deadline day, contradicting resolveMarketingInvoiceObligation",
  );
  // Cairo, not the container's clock. A UTC comparison flips the figure hours early every evening,
  // and does it silently — the count is simply wrong for part of each day.
  assert.ok(
    !/invoice_deadline_date\s*<\s*current_date/.test(migrationSql),
    "the comparison must be made in Africa/Cairo, never against the server's current_date",
  );
}

function testMigrationKeepsItsTimeoutAndLocksDownExecute() {
  // EVERY definition, not just the live one. A CREATE OR REPLACE that omits the timeout or the
  // revoke silently undoes its predecessor's, which is precisely how three protected RPCs lost
  // their timeout and began returning HTTP 500 at the 8s authenticator default.
  for (const path of MIGRATION_PATHS) {
    const sql = stripSqlComments(read(path));

    // Set INSIDE the CREATE header — a later `ALTER FUNCTION ... SET` does not survive the next
    // CREATE OR REPLACE.
    assert.ok(
      /set statement_timeout to '20s'/i.test(sql),
      `${path} must declare phx_finance_command_center's statement_timeout in the CREATE header`,
    );

    // scripts/check-migrations.mjs rule 4 — anon/authenticated inherit EXECUTE through PUBLIC, so
    // revoking only those two is a no-op; and revoking PUBLIC on a default ACL strips service_role,
    // hence the explicit re-grant.
    assert.ok(
      /revoke\s+execute\s+on\s+function\s+public\.phx_finance_command_center[^;]*from[^;]*public/i.test(sql),
      `${path} creates a SECURITY DEFINER function and must REVOKE EXECUTE FROM PUBLIC`,
    );
    assert.ok(
      /grant\s+execute\s+on\s+function\s+public\.phx_finance_command_center[^;]*to\s+service_role/i.test(sql),
      `${path} must re-grant service_role after the revoke, or the app cannot call its own RPC`,
    );
  }
}

function testLeaverCountersAreBoundedToBothEndsOfTheMonth() {
  // `resignedThisMonth` and `leavingThisMonth` shipped with a lower bound only, so each answered
  // "this month OR ANY MONTH AFTER IT" while its label said "this month". Forward-dating is the
  // NORMAL case here — a notice period is served, so a resignation accepted today routinely carries
  // a last working date weeks out — and the over-count would be silent: the page has no way to show
  // that a figure covers a wider window than the one it names. Latent on production when it was
  // fixed (2026-09-22: 6 and 6 either way, zero rows past the month end), which is exactly why a
  // test has to hold it — nothing on the screen would go visibly wrong when it next regresses.
  const migrationSql = stripSqlComments(read(MIGRATION_PATH));

  for (const [key, column] of [
    ["resignedThisMonth", "resignation_date"],
    ["leavingThisMonth", "last_working_date"],
  ] as const) {
    const clause = new RegExp(
      `'${key}',\\s*count\\(\\*\\) filter \\(where ${column}\\s*>=\\s*v_month_start and ${column}\\s*<\\s*v_month_next\\)`,
    );
    assert.ok(
      clause.test(migrationSql),
      `${key} must be bounded at BOTH ends — \`${column} >= v_month_start and ${column} < v_month_next\` — or a leaver whose date falls in a LATER month is counted in this one`,
    );
  }

  // Half-open, never `<=` a month end: an inclusive upper bound needs a different literal for a
  // 30-day month and a 31-day one, and gets one of them wrong every time it is rewritten.
  assert.ok(
    /v_month_next\s+date\s*:=\s*\(date_trunc\('month', \(now\(\) at time zone 'Africa\/Cairo'\)\) \+ interval '1 month'\)::date/.test(
      migrationSql,
    ),
    "the upper bound must be the FIRST day of the next Cairo month, compared with `<`",
  );
  // Cairo, not the container's clock. Railway sets no TZ, so a UTC month boundary moves both
  // figures for the first three hours of every Cairo day — worst on the 1st, when Finance is
  // closing the month these two numbers are about.
  assert.ok(
    !/v_month_(start|next)\s+date\s*:=\s*[^;]*current_date/.test(migrationSql),
    "the month boundary must be taken in Africa/Cairo, never against the server's current_date",
  );
}

function testCommittedTrendIsOneRowPerMonth() {
  // This was reported to the owner as a LIVE duplicate and it was not one: salary_batches carries
  // a unique index on (year, month), so the old `group by b.year, b.month, b.status` could never
  // split a month. Measured on production 2026-09-22 — eight months, each one batch, each one
  // status, and the payload byte-identical before and after the change.
  //
  // It is pinned anyway because the query was single-row-per-month only by virtue of a constraint
  // declared in a DIFFERENT migration, and three consumers fail quietly if that stops holding:
  // NetMonthOverMonth keys its bars on `period` and compares each entry with the one before it,
  // and the "Net payroll" tile reads the LAST entry. `limit v_months` counts GROUPED rows, so a
  // split month would also shorten the window from six months to five without saying so.
  const migrationSql = stripSqlComments(read(MIGRATION_PATH));

  assert.ok(
    /group by b\.year, b\.month\s*$/m.test(migrationSql),
    "the committed-payroll trend must group on the period alone — `group by b.year, b.month`",
  );
  assert.ok(
    !/group by b\.year, b\.month, b\.status/.test(migrationSql),
    "`status` is a batch attribute, not part of the period — grouping on it lets one month yield two entries carrying the same `period`",
  );
  // Aggregated rather than dropped: the payload shape is part of FinanceCommittedMonth, and the
  // service types `status` as a string.
  assert.ok(
    /string_agg\(distinct b\.status, ' \+ ' order by b\.status\)\s+as status/.test(migrationSql),
    "`status` must survive as an aggregate — and one that reads 'approved + locked' rather than silently picking one of two",
  );

  // The consumers this protects, asserted where they live, so deleting the guard needs deleting
  // the reason too.
  const dashboard = read("src/components/admin/finance-command-center.tsx");
  assert.ok(
    /key=\{month\.period\}/.test(dashboard),
    "the trend chart keys its bars on `period`, which is why a month may appear at most once",
  );
  assert.ok(
    /committed\[data\.payroll\.committed\.length - 1\]/.test(dashboard),
    "the Net payroll tile reads the LAST committed entry, which is the newest month only while months are unique",
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
  // Asserted role by role rather than as one exact array literal, changed 2026-08-30.
  //
  // The literal form pinned `["CEO", "SFE Manager", "Finance Manager"]` character for character,
  // so it failed the moment HR Advisory and HR Operations were EXCLUDED TOO — that is, it went red
  // for a change that strengthened the very property it exists to protect, and the only way to get
  // it green was to edit the assertion. A pin that has to be rewritten every time the rule it
  // guards is applied more widely trains the next session to rewrite it without reading it.
  //
  // The intent is unchanged and the guard is not weakened: every role with a landing page of its
  // own must still be absent from the generic row. Adding a role to that set now extends this list
  // instead of re-pinning it.
  const genericCommandCenterRow = /^.*href: "\/admin", icon: LayoutDashboard, label: "Command Center".*$/m
    .exec(nav)?.[0] ?? "";
  assert.ok(genericCommandCenterRow.length > 0, "the generic /admin Command Center nav row must still be findable");
  for (const role of ["CEO", "SFE Manager", "Finance Manager", "HR Operations"]) {
    assert.ok(
      genericCommandCenterRow.includes(`"${role}"`),
      `the generic Command Center row must exclude every role that has its own — ${role} is missing`,
    );
  }
  // /workspace/marketing-requests is the ONE page that shows the Finance Manager an approved
  // request and its Invoice due column, so it now has BOTH routes — a sidebar row (owner,
  // 2026-08-30: "open the sidebar route") and the dashboard link below.
  //
  // This assertion said the OPPOSITE until 2026-08-30, and its comment cited d5fd863e4 as "an
  // explicit, repeated product decision". That was too strong: the original removal (7aec78485)
  // recorded no reason at all. Left here as a warning about the shape of the mistake rather than
  // just the fact of it — a pinning test inherits whatever confidence its comment claims, and this
  // one made a cleanup commit read like a product ruling for two months.
  assert.ok(
    /href: "\/workspace\/marketing-requests",/.test(nav),
    "the sidebar must carry a route to the approved-requests workspace",
  );
  // The dashboard link stays too, and stays UNCONDITIONAL. His previous only route was a queue row
  // rendered while `missingPaymentProof > 0`, so the screen vanished exactly when the paperwork was
  // tidy; the overdue queue row has the same shape, so neither can be the sole route. Either way:
  // an unreachable page is the same as no page, and a figure you cannot click through from is
  // barely better — the sidebar row does not make this link redundant.
  const dashboard = read("src/components/admin/finance-command-center.tsx");
  assert.ok(
    /href="\/workspace\/marketing-requests"/.test(dashboard),
    "the Finance Command Center must link to the approved-requests workspace",
  );
  assert.ok(
    /Approved requests\s*<\/Link>/.test(dashboard),
    "and that link must sit in the section header, which always renders — not inside a `count > 0` guard",
  );
}


/**
 * 6. EACH DOWNLOAD IN ITS OWN WORDS. The finance sheet reads `part1 | full`; the FAB and CIB routes
 *    read `part1 | part2`, and each route now REFUSES any other word (it used to read it as `part1`,
 *    the default behind the incident below). One shared `scope=full` handed
 *    finance the PART 1 bank files under "Ready to pay" once Part 2 was confirmed (10 Aug – Nov 2026):
 *    every First Part paid a second time, never checked against the Part 2 stamp.
 */
function testReadyToPayBankFilesAskForPartTwo() {
  assert.equal(financeDownloadScope("fab", true), "part2", "HEADLINE: a Part-2-confirmed month's FAB file is the Part 2 file");
  assert.equal(financeDownloadScope("cib", true), "part2", "and so is its CIB file");
  assert.equal(financeDownloadScope("finance", true), "full", "the finance sheet keeps its own word for the whole month");
  for (const kind of ["finance", "fab", "cib"] as const) {
    assert.equal(financeDownloadScope(kind, false), "part1", `before Part 2 is confirmed ${kind} offers Part 1`);
  }
  // The server half (14 Nov 2026): a word the route does not know is REFUSED, never read as Part 1.
  assert.equal(parseBankFileScope("part2"), "part2");
  assert.equal(parseBankFileScope("part1"), "part1");
  for (const word of ["full", "Part2", "", null, "part2 "]) {
    assert.equal(parseBankFileScope(word), null, `HEADLINE: a bank route refuses scope=${String(word)} instead of handing out the Part 1 file`);
  }
  assert.equal(parseFinanceSheetScope("full"), "full");
  assert.equal(parseFinanceSheetScope("part1"), "part1");
  assert.equal(parseFinanceSheetScope("part2"), null, "the finance sheet has no part2 — it is refused, not read as the whole month");
  assert.equal(isRealCalendarDate("2026-11-25"), true);
  assert.equal(isRealCalendarDate("2028-02-29"), true, "a leap day is a real day");
  for (const bad of ["2026-13-45", "2026-02-30", "2026-11-5", "25/11/2026"]) {
    assert.equal(isRealCalendarDate(bad), false, `a FAB value date of ${bad} is refused`);
  }
  for (const route of ["fab-download", "cib-download"]) {
    const source = stripComments(readFileSync(`app/api/automated-payroll/finance/${route}/route.ts`, "utf8"));
    assert.match(source, /const scope = parseBankFileScope\(url\.searchParams\.get\("scope"\)\);\s*if \(!scope\) \{/, `HEADLINE: ${route} refuses a scope it does not know`);
    assert.doesNotMatch(source, /: "part1";/, `${route} never falls back to Part 1`);
  }
  const sheetRoute = stripComments(readFileSync("app/api/automated-payroll/finance/download/route.ts", "utf8"));
  assert.match(sheetRoute, /const scope = parseFinanceSheetScope\(url\.searchParams\.get\("scope"\)\);\s*if \(!scope\) \{/, "the finance sheet refuses a scope it does not know");
  const fabRoute = stripComments(readFileSync("app/api/automated-payroll/finance/fab-download/route.ts", "utf8"));
  assert.match(fabRoute, /!isRealCalendarDate\(valueDateParam\)/, "the FAB route refuses an impossible value date");
  const dashboard = stripComments(readFileSync("src/components/admin/finance-command-center.tsx", "utf8"));
  assert.match(dashboard, /financeDownloadScope\(sheet\.key, part2Confirmed\)/, "every command-center link asks the shared rule for its scope");
  assert.doesNotMatch(dashboard, /&scope=\$\{scope\}/, "and no single scope is shared across the three downloads again");

  // A cancelled run pays nobody, so no finance file is ever built from one (audit 2026-11-07).
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const lookup = runService.slice(runService.indexOf("async function findFinanceRun("), runService.indexOf("/** Finance locked sheet"));
  assert.match(lookup, /findPublishedRun\(period\.month, period\.year\)/, "a published month is preferred over a newer cancelled one");
  assert.match(lookup, /run\.phase === "cancelled"/, "and a cancelled run is refused");
  for (const builder of ["buildFinanceSheet(", "buildFabSheet(", "buildCibSheet("]) {
    const at = runService.indexOf(`export async function ${builder}`);
    assert.match(runService.slice(at, at + 600), /await findFinanceRun\(period\)/, `${builder} finds its run through findFinanceRun`);
  }
}

export function runFinanceCommandCenterTests() {
  testDeductionsComeFromCommittedPayrollOnly();
  testSingleRoundTripBudget();
  testUnbookedPredicateMatchesTypescript();
  testInvoiceOverduePredicateMatchesTypescript();
  testMigrationKeepsItsTimeoutAndLocksDownExecute();
  testLeaverCountersAreBoundedToBothEndsOfTheMonth();
  testCommittedTrendIsOneRowPerMonth();
  testPageIsRoleGatedNotPermissionGated();
  testLandingAndNavAgree();
  testReadyToPayBankFilesAskForPartTwo();
}
