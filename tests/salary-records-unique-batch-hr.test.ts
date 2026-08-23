import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  duplicateEmployeeInBatchMessage,
  isDuplicateEmployeeInBatchError,
} from "@/lib/payroll/service";

/**
 * One salary record per employee per batch, enforced by `salary_records_batch_hr_unique`.
 *
 * WHY THIS EXISTS. `phx_import_approved_expenses_to_payroll` joins salary records to approved
 * outstation totals on `lower(sr.hr_id)`. Two rows in one batch sharing an hr_id both satisfy that
 * join, so both are incremented by the FULL approved expense — the employee is paid their claim
 * twice and the batch stops agreeing with the claims behind it. The 2026-08-24 additive rewrite
 * made that import safe to re-run; it did nothing about a duplicated employee, and could not.
 *
 * Production had zero duplicates when this landed (796 records, 0 collisions on
 * (batch_id, lower(hr_id)), 0 hr_ids differing only by case) — but `salary_records` carried eight
 * indexes and not one was unique beyond the primary key. The property held by luck.
 *
 * THE CASE-FOLDING IS THE WHOLE POINT. A unique index on the raw (batch_id, hr_id) would pass a
 * naive reading of "one row per employee per batch" and still let 'PH-014' and 'ph-014' collide
 * inside the function. Mixed-case hr_id is real in this database — `activity_events.hr_id` holds
 * both. So this test asserts on `lower(`, not merely on uniqueness.
 *
 * Reads the newest migration that creates the index rather than pinning a byte range, so a later
 * migration that legitimately rebuilds it is still checked and whitespace never false-fails.
 */
export function runSalaryRecordsUniqueBatchHrTests() {
  const migrationsDir = "supabase/migrations";
  const INDEX = "salary_records_batch_hr_unique";

  const defining = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) =>
      new RegExp(String.raw`create\s+unique\s+index[^;]*${INDEX}`, "i").test(
        readFileSync(join(migrationsDir, file), "utf8"),
      ),
    );

  assert.ok(defining.length > 0, `no migration creates ${INDEX} — has it been renamed or dropped?`);

  const newest = defining[defining.length - 1];
  const sql = readFileSync(join(migrationsDir, newest), "utf8");

  // Strip line comments before asserting on structure: the prose above the statement explains the
  // case-folding at length and would satisfy every check below on its own.
  const code = sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");

  const start = code.search(/create\s+unique\s+index/i);
  assert.ok(start >= 0, `${newest} defines ${INDEX} only inside a comment`);
  const statement = code.slice(start, code.indexOf(";", start));

  assert.match(
    statement,
    /create\s+unique\s+index/i,
    `${INDEX} must be UNIQUE — a plain index documents the intent without enforcing it`,
  );
  assert.match(
    statement,
    /on\s+public\.salary_records/i,
    `${INDEX} must sit on public.salary_records`,
  );
  assert.match(
    statement,
    /lower\s*\(\s*hr_id\s*\)/i,
    `${INDEX} must key on lower(hr_id): the import joins case-insensitively, so a raw hr_id index ` +
      `still lets 'PH-014' and 'ph-014' be credited the same expense twice`,
  );
  assert.match(
    statement,
    /batch_id/i,
    `${INDEX} must be scoped to batch_id — an employee legitimately has one record per month`,
  );
  assert.match(
    statement,
    /where[\s\S]*hr_id\s+is\s+not\s+null/i,
    `${INDEX} must be partial on a present hr_id, so a future blank fails an upload for the right ` +
      `reason rather than colliding with every other blank`,
  );

  // --- the error mapping -------------------------------------------------------------------

  const violation = {
    code: "23505",
    message: 'duplicate key value violates unique constraint "salary_records_batch_hr_unique"',
  };
  assert.equal(
    isDuplicateEmployeeInBatchError(violation),
    true,
    "a 23505 naming this index must be recognised, or the upload returns a raw 500",
  );

  // The batch-period index is also a 23505 on this table's family and must NOT be swallowed by the
  // duplicate-employee message — it means something completely different to the uploader.
  assert.equal(
    isDuplicateEmployeeInBatchError({
      code: "23505",
      message: 'duplicate key value violates unique constraint "salary_batches_year_month_unique_idx"',
    }),
    false,
    "a duplicate PERIOD must not be reported as a duplicate EMPLOYEE",
  );

  assert.equal(
    isDuplicateEmployeeInBatchError({ code: "42703", message: "salary_records_batch_hr_unique" }),
    false,
    "only SQLSTATE 23505 is a uniqueness violation",
  );

  const message = duplicateEmployeeInBatchMessage([
    { hrId: "PH-014", fullName: "Mariem Hany", row: 7 },
    { hrId: "ph-014 ", fullName: "Mariem Hany", row: 31 },
    { hrId: "PH-020", fullName: "Essam Mohamed", row: 12 },
  ]);

  assert.ok(
    message.includes("Mariem Hany"),
    "the message must name the employee — the owner's standing rule is human-readable names, and " +
      "an hr_id alone does not tell the uploader whose row to look at",
  );
  assert.ok(
    message.includes("7") && message.includes("31"),
    "the message must give both sheet rows, which is the only way to find the duplicate in a file",
  );
  assert.ok(
    !message.includes("Essam Mohamed"),
    "an employee appearing once is not a duplicate and must not be named",
  );
  assert.ok(
    !message.includes("…") && !message.includes("..."),
    "no ellipsis — the owner's standing rule, and a truncated list hides a row that must be fixed",
  );

  const noneVisible = duplicateEmployeeInBatchMessage([
    { hrId: "PH-014", fullName: "Mariem Hany", row: 7 },
  ]);
  assert.ok(
    noneVisible.length > 0 && !noneVisible.includes("undefined"),
    "when the index fires but the sheet looks clean (a concurrent upload), say so rather than " +
      "interpolating a name that was never found",
  );
}
