import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";

import { stripSqlComments } from "./support/comment-strip.ts";

// A direct order's requester_hr_id must hold the form an HR id is STORED in, not the lower-case
// key it is COMPARED with.
//
// WHAT HAPPENED. AccessContext.hrId carries canonicalHrIdKey — lower case, correct for matching and
// wrong for persisting — and the submit path wrote it straight through until hrIdForStorage() was
// introduced on 2026-09-02. By then 78 of the 152 rows in direct_order_requests (51%) held
// ai-0001, ai-0007, b-1, b-12, b-154, b-23, b-76, b-94 or pd-0010. src/lib/hr-id.ts records the
// same root cause for the wider damage: "~37,000 lowercase actor ids across 52 columns".
//
// WHY IT SURVIVED SO LONG. The direct-order domain canonicalises on read — nameLookup(),
// rep-counters.ts, hrIdsMatch(), hrIdLookupKeys() — so no screen was ever wrong, and there was
// nothing to notice. What broke was everything OUTSIDE those helpers: all nine people also had rows
// under the upper-case spelling, so a group-by on the raw column split one rep into two, and a
// plain `join employees e on e.hr_id = r.requester_hr_id` dropped 51% of direct orders with no
// error at all. That is the failure mode this file exists to stop coming back — it is silent at
// both ends, so only a pin catches it.
//
// It never reached the monthly closing: phx_monthly_closing_direct reads
// source_of_sales_fact_rollup by region/area/product and does not touch direct_order_requests.
//
// Two halves are asserted, because either alone regresses. The CODE half keeps the writer on
// hrIdForStorage(). The MIGRATION half keeps the database trigger that catches everything which is
// not the writer — a script, a hand-run UPDATE, a future call site — since fixing this in
// TypeScript is exactly what was already done once and did not hold for the rows already stored.

const REPO = process.cwd();
const MIGRATIONS = join(REPO, "supabase/migrations");
const SERVICE = join(REPO, "src/lib/direct-orders/service.ts");

/** The nine spellings production actually held, each with the form it had to become. */
const STORED_FORMS: Array<[string, string]> = [
  ["ai-0001", "AI-0001"],
  ["ai-0007", "AI-0007"],
  ["b-1", "B-1"],
  ["b-12", "B-12"],
  ["b-154", "B-154"],
  ["b-23", "B-23"],
  ["b-76", "B-76"],
  ["b-94", "B-94"],
  ["pd-0010", "PD-0010"],
];

/** Strip block and line comments so an assertion can never match this file's own prose. */
function sql(source: string): string {
  return stripSqlComments(source).replace(/(^|[^:])--[^\n]*/g, "$1");
}

export function runDirectOrderRequesterHrIdStorageFormTests() {
  // ── 1. The helper's two forms stay distinct, and storage is the upper-case one ─────────────
  // Behavioural, not a source scan: if hrIdForStorage ever started returning the comparison key
  // again, every assertion below about the writer would still pass while the bug came straight
  // back. Both directions matter — the key must stay lower for matching.
  for (const [lower, stored] of STORED_FORMS) {
    assert.equal(hrIdForStorage(lower), stored, `hrIdForStorage("${lower}") must store "${stored}"`);
    assert.equal(hrIdForStorage(stored), stored, `hrIdForStorage("${stored}") must leave it alone`);
    assert.equal(hrIdForStorage(`  ${lower}  `), stored, `hrIdForStorage must trim "${lower}"`);
    assert.equal(canonicalHrIdKey(stored), lower, `canonicalHrIdKey("${stored}") must stay the lower-case key`);
  }

  // ── 2. The writer half: every write of the column goes through hrIdForStorage ──────────────
  const service = readFileSync(SERVICE, "utf8");
  const writes = service.match(/requester_hr_id:\s*[^,\n]+/g) ?? [];
  assert.ok(
    writes.length >= 2,
    `expected the submit paths to still write requester_hr_id in src/lib/direct-orders/service.ts (found ${writes.length}) — if the column was renamed, re-point this test rather than deleting it`,
  );
  for (const write of writes) {
    assert.ok(
      write.includes("hrIdForStorage("),
      `"${write.trim()}" must write hrIdForStorage(...) — access.hrId is the lower-case comparison key and storing it is what left 78 of 152 rows unjoinable`,
    );
  }

  // ── 3. Reads stay case-tolerant, so the old rows were never invisible to the app ───────────
  // The backfill fixed the data; this keeps the belt on. A `.eq("requester_hr_id", access.hrId)`
  // would return nothing at all rather than something wrong, which is the hard kind to notice.
  assert.ok(
    !/\.eq\(\s*["']requester_hr_id["']/.test(service),
    "requester_hr_id must never be filtered with a case-sensitive .eq — use .in(..., hrIdLookupKeys(...))",
  );

  // ── 4. The database half: the guard trigger is still installed ─────────────────────────────
  const file = readdirSync(MIGRATIONS).find((f) => f.includes("direct_order_requester_hr_id_storage_form"));
  assert.ok(file, "the migration installing the requester_hr_id storage-form guard must still be present");
  const migration = sql(readFileSync(join(MIGRATIONS, file), "utf8"));

  assert.match(
    migration,
    /update\s+public\.direct_order_requests\s+set\s+requester_hr_id\s*=\s*upper\(btrim\(requester_hr_id\)\)/i,
    "the migration must still carry the backfill that put the 78 stored rows in storage form",
  );
  assert.match(
    migration,
    /new\.requester_hr_id\s*:=\s*upper\(btrim\(new\.requester_hr_id\)\)/i,
    "the trigger function must still normalise the incoming value",
  );
  assert.match(
    migration,
    /before\s+insert\s+or\s+update\s+of\s+requester_hr_id\s+on\s+public\.direct_order_requests/i,
    "the guard must fire BEFORE INSERT OR UPDATE OF requester_hr_id on direct_order_requests",
  );

  // ── 5. And it stays on that one column, on purpose ─────────────────────────────────────────
  // Widening it to the direct-order family is the obvious-looking improvement and is wrong: three
  // rows are deliberate SYSTEM sentinels, not people —
  // direct_order_report_share_links.revoked_by_hr_id = 'system:rotation' (7 rows) and
  // direct_order_events.actor_hr_id = 'system.duplicate.cleanup.2026-08-13' /
  // 'system.held.cleanup.2026-08-13'. Upper-casing those mangles them for nothing; requester_hr_id
  // is the one column in the family that only ever holds a real HR id.
  for (const table of ["direct_order_events", "direct_order_report_share_links", "direct_order_approval_steps"]) {
    assert.ok(
      !new RegExp(`create\\s+trigger[\\s\\S]{0,200}on\\s+public\\.${table}\\b`, "i").test(migration),
      `the storage-form guard must not be widened onto ${table} — its actor columns hold system sentinels that must stay verbatim`,
    );
  }
}
