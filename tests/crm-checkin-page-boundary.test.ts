import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withIdColumn } from "../src/lib/crm/reads.ts";

// Regression for #1520. `queryCheckins`'s full-coverage scan is keyset-paginated on `check_date`,
// and its docstring used to assert that duplicate timestamps were "never observed in production".
// They are: production has 1,797 `check_date` values shared by 2+ check-ins, up to 20 rows on a
// single one. A `.gt(check_date, cursor)` cursor whose page boundary landed INSIDE such a group
// skipped every remaining row of that group, and downstream that reads as "this visit has no
// check-in" — a silent under-count with no error anywhere.
//
// The loop is DB-backed and the failure only reproduces against a >pageSize table under a live
// PostgREST, which no unit test can stand up, so the loop itself gets a source-shape guard — the
// same convention this suite already uses for exactly this bug class in
// tests/sos-crosswalk-pagination.test.ts and tests/sales-master-data-pagination.test.ts. The
// projection helper the fix depends on IS pure, so it is exercised for real below.

/** The text of a top-level function, from its declaration to the first column-0 closing brace. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must still exist and be exported`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

export function runCrmCheckinPageBoundaryTests() {
  // ── The projection MUST carry `id`, or the de-dupe eats the whole result ────────
  // The overlap the `.gte` cursor deliberately creates is removed by de-duplicating on `id`. If a
  // caller passes explicit columns and `id` is not forced in, every row's `id` is `undefined`,
  // they all collide in the seen-set, and the scan returns exactly ONE row — a worse failure than
  // the bug being fixed. This is the pure part of the fix, so it is tested for real.
  assert.equal(withIdColumn("*"), "*", "select(*) already includes id and must be left alone");
  assert.equal(
    withIdColumn("agent_crm_id, check_date"),
    "id, agent_crm_id, check_date",
    "an explicit projection must have id prepended, or de-duping on id collapses every row into one",
  );
  assert.equal(
    withIdColumn("id, agent_crm_id"),
    "id, agent_crm_id",
    "id must not be duplicated when the caller already asked for it",
  );
  assert.equal(
    withIdColumn("  agent_crm_id ,  check_date  "),
    "id, agent_crm_id, check_date",
    "whitespace around column names must not defeat the id check",
  );

  // ── The scan loop itself: source-shape guard ────────────────────────────────────
  const scan = functionBody(readFileSync("src/lib/crm/reads.ts", "utf8"), "queryCheckins");

  assert.ok(
    /\.gte\("check_date", cursor\)/.test(scan),
    "the cursor must be .gte — .gt skips the rest of any group of check-ins sharing one timestamp",
  );
  assert.ok(
    !/\.gt\("check_date", cursor\)/.test(scan),
    "the cursor must NOT be .gt(check_date) — that is the exact bug #1520 fixed",
  );
  assert.ok(
    /withIdColumn\(/.test(scan),
    "the scan must force `id` into the projection — the de-dupe below is keyed on it",
  );
  assert.ok(
    /seenIds\.has\(row\.id\)/.test(scan) && /seenIds\.add\(row\.id\)/.test(scan),
    "the deliberate .gte overlap must be removed by de-duplicating on the unique id, so callers still get each row exactly once",
  );
  assert.ok(
    /\.order\("check_date", \{ ascending: true \}\)\.order\("id", \{ ascending: true \}\)/.test(scan),
    "rows sharing a timestamp need a secondary sort on the unique id, or their order across pages is undefined",
  );
  assert.ok(
    /added === 0/.test(scan),
    "a full page of already-seen rows means the .gte cursor cannot advance — the loop must stop rather than spin forever",
  );
  assert.ok(
    /if \(page\.length < pageSize\) break;/.test(scan),
    "a short page must still end the scan",
  );

  console.log("crm check-in page boundary: .gte cursor + id de-dupe guard passed");
}
