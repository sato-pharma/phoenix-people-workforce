import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isPostgresUniqueViolation } from "../src/lib/sales/contracts.ts";

// Guards the ROI double-count fix: a single validated Source-of-Sales batch per (distributor, period).
// The DB partial unique index is the hard backstop; the app maps its 23505 to a friendly "already
// imported" message. These tests pin both the error-detection helper and the migration's predicate so
// the guarantee can't be silently weakened.
export function runSalesRoiBatchDedupTests() {
  // ── isPostgresUniqueViolation: detects SQLSTATE 23505 in supabase-js error shapes ──────────────
  assert.equal(isPostgresUniqueViolation({ code: "23505", message: "duplicate key value" }), true,
    "top-level code 23505 is a unique violation");
  assert.equal(isPostgresUniqueViolation({ cause: { code: "23505" } }), true,
    "nested cause.code 23505 is a unique violation");

  // Anything else must NOT be treated as a duplicate (so real failures still surface as 500s).
  assert.equal(isPostgresUniqueViolation({ code: "23503" }), false, "FK violation is not a duplicate");
  assert.equal(isPostgresUniqueViolation({ code: "57014" }), false, "statement timeout is not a duplicate");
  assert.equal(isPostgresUniqueViolation(new Error("boom")), false, "plain Error is not a duplicate");
  assert.equal(isPostgresUniqueViolation("23505"), false, "a bare string is not a duplicate");
  assert.equal(isPostgresUniqueViolation(null), false, "null is not a duplicate");
  assert.equal(isPostgresUniqueViolation(undefined), false, "undefined is not a duplicate");

  // ── Migration keystone: the partial unique index must exist with the exact dedup predicate ─────
  const migrationPath = fileURLToPath(
    new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260620120000_sales_one_validated_batch_per_period.sql", import.meta.url),
  );
  const sql = readFileSync(migrationPath, "utf8").toLowerCase();
  assert.ok(
    sql.includes("create unique index if not exists source_of_sales_one_validated_batch_per_period"),
    "migration creates the named partial unique index",
  );
  assert.ok(
    sql.includes("on public.source_of_sales_import_batches (distributor_code, period)"),
    "index is keyed on (distributor_code, period)",
  );
  assert.ok(
    sql.includes("where status = 'validated' and period is not null"),
    "index is partial: only validated, non-null-period batches are constrained",
  );
}
