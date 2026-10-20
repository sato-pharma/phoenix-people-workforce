import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  filterVacationRowsInMemory,
  vacationIlikePatternToRegExp,
  type VacationFilterableRow,
} from "../src/lib/vacation/report-filter.ts";

// Guards the in-memory mirror of the phx_vacation_report_rows Postgres function. The report used to
// call that RPC ~779×/hour (the single heaviest query by share of production DB time); service.ts now
// reads the ~300-row table once per revalidation window and applies scope + these filters in memory.
// The mirror was proven multiset-identical to the LIVE production RPC across a 36-combo filter × scope
// matrix on the real 312-row prod dataset (md5(sorted ids) + count identical for every combo). This
// unit test is the permanent regression guard on that algorithm, plus the cache-invalidation wiring.

function src(path: string): string {
  return readFileSync(path, "utf8");
}

// Five rows exercising every branch: mixed-case HR ids (ILIKE), NULL department/line (concat_ws
// skip + equality-vs-NULL), a lowercase "finance" vs "Finance" (case-sensitive equality), a full date
// span, and distinctive uuids (id-in-search + requestId).
const R1 = "11111111-1111-1111-1111-111111111111";
const R2 = "22222222-2222-2222-2222-222222222222";
const R3 = "33333333-3333-3333-3333-333333333333";
const R4 = "44444444-4444-4444-4444-444444444444";
const R5 = "55555555-5555-5555-5555-555555555555";

const NAMES: Record<string, string> = { [R1]: "r1", [R2]: "r2", [R3]: "r3", [R4]: "r4", [R5]: "r5" };

const ROWS: VacationFilterableRow[] = [
  { id: R1, employee_hr_id: "A-1", employee_name: "Alice", manager_hr_id: "M-1", manager_name: "Mgr One", department_name: "Finance", line_name: "CNS", vacation_type: "annual", status: "approved", payment_status: "paid", start_date: "2026-06-10" },
  { id: R2, employee_hr_id: "a-2", employee_name: "Bob", manager_hr_id: "M-1", manager_name: "Mgr One", department_name: "Sales", line_name: "Pedia", vacation_type: "emergency", status: "rejected", payment_status: "unpaid", start_date: "2026-01-05" },
  { id: R3, employee_hr_id: "B-10", employee_name: "Carol", manager_hr_id: "M-2", manager_name: "Mgr Two", department_name: null, line_name: null, vacation_type: "other", status: "pending_manager", payment_status: "paid", start_date: "2026-08-01" },
  { id: R4, employee_hr_id: "A-11", employee_name: "Dan", manager_hr_id: "M-2", manager_name: "Mgr Two", department_name: "Finance", line_name: "CNS", vacation_type: "annual", status: "approved", payment_status: "paid", start_date: "2026-06-30" },
  { id: R5, employee_hr_id: "C-1", employee_name: "Eve", manager_hr_id: "M-3", manager_name: "Mgr Three", department_name: "finance", line_name: "Head Office", vacation_type: "annual", status: "pending_hr", payment_status: "unpaid", start_date: "2026-03-15" },
];

// filterVacationRowsInMemory takes the typed VacationReportFilters. A couple of assertions below
// deliberately probe runtime-only values (e.g. an empty string reaching an enum field via JSONB) that
// the compile-time type narrows out; this alias lets those cast past the narrowing without weakening
// the rest of the suite.
type RawFilters = Parameters<typeof filterVacationRowsInMemory>[1];

function match(filters: RawFilters): string[] {
  return filterVacationRowsInMemory(ROWS, filters).map((r) => NAMES[r.id]).sort();
}

export function runVacationReportFilterEquivalenceTests() {
  // ---- inactive filters: null / "" / "all" mean "no predicate" (mirrors nullif(...,'') is null) ----
  assert.deepEqual(match({}), ["r1", "r2", "r3", "r4", "r5"], "no filters returns all rows");
  assert.deepEqual(match({ status: "all" }), ["r1", "r2", "r3", "r4", "r5"], "status 'all' is inactive");
  assert.deepEqual(match({ status: "" as unknown as RawFilters["status"] }), ["r1", "r2", "r3", "r4", "r5"], "empty status string is inactive (runtime-only via JSONB; the typed API narrows it out)");
  assert.deepEqual(match({ employee: "" }), ["r1", "r2", "r3", "r4", "r5"], "empty employee string is inactive");

  // ---- enum equality (case-sensitive, exact) ----
  assert.deepEqual(match({ status: "approved" }), ["r1", "r4"], "status equality");
  assert.deepEqual(match({ paymentStatus: "unpaid" }), ["r2", "r5"], "payment status equality");
  assert.deepEqual(match({ vacationType: "other" }), ["r3"], "vacation type equality");

  // ---- department/line: case-SENSITIVE equality, and a NULL column never matches ----
  assert.deepEqual(match({ department: "Finance" }), ["r1", "r4"], "department equality is case-sensitive (excludes 'finance' and NULL)");
  assert.deepEqual(match({ department: "finance" }), ["r5"], "lowercase 'finance' matches only the lowercase row");
  assert.deepEqual(match({ line: "CNS" }), ["r1", "r4"], "line equality");
  assert.deepEqual(match({ line: "Head Office" }), ["r5"], "line equality with a space");

  // ---- employee / manager: ILIKE (case-insensitive, anchored full-match, %/_ wildcards) ----
  assert.deepEqual(match({ employee: "a-1" }), ["r1"], "ILIKE is case-insensitive AND anchored: 'a-1' hits 'A-1', not 'A-11'");
  assert.deepEqual(match({ employee: "A-1%" }), ["r1", "r4"], "trailing % is a wildcard: 'A-1%' hits 'A-1' and 'A-11'");
  assert.deepEqual(match({ employee: "%1%" }), ["r1", "r3", "r4", "r5"], "%..% matches anywhere: every id containing '1'");
  assert.deepEqual(match({ employee: "A_1" }), ["r1"], "_ matches exactly one char: 'A_1' hits 'A-1' (3 chars), not 'A-11'");
  assert.deepEqual(match({ manager: "m-2" }), ["r3", "r4"], "manager ILIKE is case-insensitive");

  // ---- date range on start_date (inclusive both ends; NULL start never matches — none here) ----
  assert.deepEqual(match({ dateFrom: "2026-06-01", dateTo: "2026-06-30" }), ["r1", "r4"], "date range inclusive of the 06-30 endpoint");
  assert.deepEqual(match({ dateFrom: "2026-08-01" }), ["r3"], "dateFrom inclusive lower bound");
  assert.deepEqual(match({ dateTo: "2026-01-31" }), ["r2"], "dateTo inclusive upper bound");

  // ---- requestId: exact id::text match ----
  assert.deepEqual(match({ requestId: R3 }), ["r3"], "requestId hits exactly one row");
  assert.deepEqual(match({ requestId: "00000000-0000-0000-0000-000000000000" }), [], "unknown requestId hits nothing");

  // ---- free-text search: concat_ws(' ', …) ILIKE '%search%' over 10 columns incl id ----
  assert.deepEqual(match({ search: "cns" }), ["r1", "r4"], "search is case-insensitive, matches the line column");
  assert.deepEqual(match({ search: "alice" }), ["r1"], "search matches the employee_name column");
  assert.deepEqual(match({ search: "mgr one" }), ["r1", "r2"], "search matches manager_name across rows");
  assert.deepEqual(match({ search: "5555" }), ["r5"], "search matches the id column (id is in the haystack)");
  assert.deepEqual(match({ search: "finance" }), ["r1", "r4", "r5"], "search is ILIKE so it is case-INSENSITIVE, unlike the department equality filter above");
  assert.deepEqual(match({ search: "%" }), ["r1", "r2", "r3", "r4", "r5"], "a literal '%' search wraps to '%%%' and matches everything");

  // ---- combined predicates AND together ----
  assert.deepEqual(match({ status: "approved", line: "CNS", dateFrom: "2026-06-15" }), ["r4"], "status + line + dateFrom compose");
  assert.deepEqual(match({ vacationType: "annual", paymentStatus: "paid" }), ["r1", "r4"], "vacationType + paymentStatus compose");

  // ---- the ILIKE→RegExp compiler in isolation ----
  const anchored = vacationIlikePatternToRegExp("cns");
  assert.equal(anchored.test("CNS"), true, "no-wildcard ILIKE is case-insensitive");
  assert.equal(anchored.test("xCNSy"), false, "no-wildcard ILIKE is anchored (full match only)");
  assert.equal(vacationIlikePatternToRegExp("a.b").test("a.b"), true, "a literal dot matches a dot");
  assert.equal(vacationIlikePatternToRegExp("a.b").test("axb"), false, "a literal dot is escaped, not a regex wildcard");
  assert.equal(vacationIlikePatternToRegExp("50%").test("500"), true, "% is a trailing wildcard");
  assert.equal(vacationIlikePatternToRegExp("A_1").test("A11"), true, "_ matches any single char");
  assert.equal(vacationIlikePatternToRegExp("A_1").test("A-12"), false, "_ matches exactly one char, so a 4-char subject fails");
  // Backslash escapes the next char: "a\%b" means a literal percent, not a wildcard.
  assert.equal(vacationIlikePatternToRegExp("a\\%b").test("a%b"), true, "escaped % is a literal percent");
  assert.equal(vacationIlikePatternToRegExp("a\\%b").test("axb"), false, "escaped % does not act as a wildcard");

  // ---- cache-invalidation + wiring guards (source-text, this repo's idiom for DB-touching paths) ----
  const invalidation = src("src/lib/dashboard/invalidation.ts");
  assert.match(
    invalidation,
    /export const VACATION_REPORT_ROWS_CACHE_TAG = "vacation-report-rows";/,
    "the base-rows cache tag must be declared as a bare string in invalidation.ts",
  );
  // It must be busted INSIDE the leave block — the single place every vacation write already funnels
  // through — so all 10 write sites inherit complete coverage from one line.
  assert.match(
    invalidation,
    /includes\("leave"\)\)\s*\{[\s\S]*?revalidateTag\(COMPANY_VACATION_REPORT_CACHE_TAG, \{ expire: 0 \}\);[\s\S]*?revalidateTag\(VACATION_REPORT_ROWS_CACHE_TAG, \{ expire: 0 \}\);[\s\S]*?\}/,
    "the leave block must bust VACATION_REPORT_ROWS_CACHE_TAG alongside the company-report tag",
  );

  const service = src("src/lib/vacation/service.ts");
  assert.match(
    service,
    /unstable_cache\(\s*async \(\) => packVacationReportRows\(await loadAllVacationRequestRowsRaw\(\)\),\s*\["vacation-report-all-rows-packed"\],\s*\{[^}]*revalidate:\s*VACATION_REPORT_ROWS_REVALIDATE_SECONDS[^}]*tags:\s*\[VACATION_REPORT_ROWS_CACHE_TAG\][^}]*\}/,
    "service.ts must cache the unscoped base read (packed, PERF-018) under VACATION_REPORT_ROWS_CACHE_TAG with the 60 s backstop",
  );
  assert.match(
    service,
    /import \{ filterVacationRowsInMemory \} from "@\/lib\/vacation\/report-filter";/,
    "service.ts must use the pure, testable filter module rather than an inline copy",
  );
  // The per-request scope must mirror the RPC's `employee_hr_id = any(p_visible_employee_hr_ids)`:
  // unscoped only for all-visibility viewers, otherwise membership in the exact visible set.
  assert.match(
    service,
    /const shouldScopeEmployees = !isAllVacationVisibility\(input\.access\);[\s\S]*?input\.visibleEmployeeHrIds\.has\(row\.employee_hr_id\)/,
    "fetchVacationReportRowsFromDatabase must scope by the visible HR-id set before filtering",
  );

  console.log("vacation-report-filter-equivalence: all predicate, ILIKE-compiler, and wiring assertions passed.");
}
