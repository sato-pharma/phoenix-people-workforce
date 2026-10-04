import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  packVacationReportRows,
  unpackVacationReportRows,
  VACATION_ROWS_CACHE_MAX_BYTES,
} from "../src/lib/vacation/report-rows-pack.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-018 — the vacation report's base rows are cached PACKED.
 *
 * The unscoped read is every vacation request ever filed: 643 rows and 1.58MB of JSON on production
 * when this was written, growing ~275KB a month. Next refuses a data-cache entry over 2MB — in
 * production it silently skips the write, so the cache would have stopped existing around November
 * and ~8 surfaces would have gone back to a database read on every page load. Modelled on
 * tests/sales-vs-target-cache.test.ts, which pins the same pack for Sales vs Target.
 */
export async function runVacationRowsCachePackedTests() {
  // A production-shaped row: the real table's columns, with nulls, numbers, booleans, nested JSON,
  // Arabic text and ISO timestamps — everything the JSON round trip in the cache has to carry.
  const makeRow = (i: number, overrides: Record<string, unknown> = {}) => ({
    id: `0000${String(i).padStart(4, "0")}-1111-2222-3333-444455556666`,
    employee_hr_id: `B-${100 + (i % 180)}`,
    employee_name: i % 3 === 0 ? "ياسمينة الصفوري" : "Ahmed Mohamed",
    department_name: i % 5 === 0 ? null : "Sales",
    line_name: i % 4 === 0 ? null : "CNS",
    vacation_type: i % 7 === 0 ? "sick" : "annual",
    request_type: "full_day",
    status: i % 2 === 0 ? "approved" : "pending_manager",
    start_date: "2026-09-01",
    end_date: "2026-09-03",
    duration_days: 3,
    paid_days: i % 9 === 0 ? 0 : 3,
    unpaid_duration_days: i % 9 === 0 ? 3 : 0,
    is_paid: i % 9 !== 0,
    balance_before: 21 - (i % 21),
    balance_after: 18 - (i % 21),
    notes: i % 6 === 0 ? "" : `Family trip ${i}`,
    weekly_off_policy_snapshot: { days: ["Friday", "Saturday"], mode: "fixed", seat: `seat-${i % 40}` },
    created_at: "2026-09-01T08:15:30.123+00:00",
    updated_at: null,
    ...overrides,
  });

  // 1. The ceiling stays strictly under Next's hard 2MB limit, with margin for the cache envelope.
  assert.ok(
    VACATION_ROWS_CACHE_MAX_BYTES < 2 * 1024 * 1024,
    "the pack ceiling must stay under Next's hard 2MB data-cache limit",
  );

  // 2. Round-trip fidelity on a small, branchy sample.
  const sample = [
    makeRow(0),
    makeRow(1, { department_name: null, line_name: null, notes: null }),
    makeRow(2, { duration_days: 0.5, request_type: "half_day", balance_after: -1.5 }),
    makeRow(3, { weekly_off_policy_snapshot: null, is_paid: false }),
  ];
  const packedSample = await packVacationReportRows(sample);
  assert.ok(packedSample !== null, "a four-row payload must pack, not bypass the cache");
  assert.deepEqual(
    await unpackVacationReportRows(packedSample),
    sample,
    "pack -> unpack must hand back exactly the rows that went in",
  );

  // 3. Production-sized, and far past it: the size that would have broken the raw cache entry.
  const atProduction = Array.from({ length: 643 }, (_, i) => makeRow(i));
  const packedProduction = await packVacationReportRows(atProduction);
  assert.ok(packedProduction !== null, "643 production-shaped rows must pack");
  assert.ok(
    packedProduction.length < VACATION_ROWS_CACHE_MAX_BYTES / 4,
    "today's row count must land well inside the ceiling once packed, not near it",
  );
  assert.deepEqual(
    await unpackVacationReportRows(packedProduction),
    atProduction,
    "643 rows must round-trip unchanged",
  );

  const pastTheLimit = Array.from({ length: 6000 }, (_, i) => makeRow(i));
  assert.ok(
    JSON.stringify(pastTheLimit).length > 2 * 1024 * 1024,
    "the fixture must exceed 2MB raw, or it is not reproducing the entry Next would refuse",
  );
  const packedPast = await packVacationReportRows(pastTheLimit);
  assert.ok(
    packedPast !== null && packedPast.length < VACATION_ROWS_CACHE_MAX_BYTES,
    "rows that are over 2MB raw must fit the data cache once packed",
  );
  assert.deepEqual(await unpackVacationReportRows(packedPast), pastTheLimit, "6,000 rows must round-trip unchanged");

  // 4. THE BYPASS: a payload that will not fit even compressed returns null and never reaches the
  //    cache. Random content is incompressible by construction — the only honest way to force it.
  const incompressible = Array.from({ length: 3000 }, (_, i) => makeRow(i, { notes: randomBytes(525).toString("base64") }));
  assert.equal(
    await packVacationReportRows(incompressible),
    null,
    "a payload over the ceiling must return null and never reach the data cache",
  );

  // 5. Source pins on service.ts: the packed cache keeps the tag and the 60 s backstop, and the
  //    caller falls back to the direct read when the pack is null.
  const service = stripComments(readFileSync(resolve(process.cwd(), "src/lib/vacation/service.ts"), "utf8"));
  assert.match(
    service,
    /const loadAllVacationRequestRowsPacked = unstable_cache\(\s*async \(\) => packVacationReportRows\(await loadAllVacationRequestRowsRaw\(\)\),\s*\["vacation-report-all-rows-packed"\],\s*\{\s*revalidate: VACATION_REPORT_ROWS_REVALIDATE_SECONDS,\s*tags: \[VACATION_REPORT_ROWS_CACHE_TAG\]\s*\},?\s*\);/,
    "the base rows must be cached packed under the NEW key, with the 60 s backstop and the vacation-report-rows tag",
  );
  assert.match(
    service,
    /const VACATION_REPORT_ROWS_REVALIDATE_SECONDS = 60;/,
    "the cache backstop must stay at 60 seconds",
  );
  assert.doesNotMatch(
    service,
    /\["vacation-report-all-rows"\]/,
    "the old unpacked key must not come back — an entry in the old shape would be read as a packed string",
  );
  const callerAt = service.indexOf("async function loadAllVacationRequestRowsCached(");
  assert.notEqual(callerAt, -1, "loadAllVacationRequestRowsCached must still exist — this pin cannot silently stop checking anything");
  const caller = service.slice(callerAt, service.indexOf("\n}\n", callerAt));
  assert.match(
    caller,
    /const packed = await loadAllVacationRequestRowsPacked\(\);\s*if \(packed === null\) return loadAllVacationRequestRowsRaw\(\);\s*return unpackVacationReportRows<VacationRequestDbRow>\(packed\);/,
    "when the pack is null the caller must read the rows directly with loadAllVacationRequestRowsRaw()",
  );
}
