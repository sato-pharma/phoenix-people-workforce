import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The manager-reassignment cascade must never write to a table the Rule #1 freeze made read-only.
 *
 * Source-text assertions rather than a call-level fake: reassignManagerOwnership issues raw
 * PostgREST PATCHes through a module-private helper, so the REST path itself is the invariant —
 * and it is the path, not the response handling, that regressed.
 */
export function runManagerCascadeFrozenTablesTests() {
  const source = readFileSync("src/lib/employees/employee-directory.ts", "utf8");

  // HEADLINE INVARIANT. `sales_records` lost service_role's INSERT/UPDATE in the Rule #1 freeze, so
  // a PATCH against it returns `permission denied` (42501). shouldIgnoreOptionalCascadeError only
  // swallows missing-relation / schema-cache messages, so that error rethrows — and it rethrows
  // BEFORE the sales_targets calls run, half-applying the cascade and failing the manager change.
  // The table is also the only record of what H1 was actually paid on: rewriting manager_hr_id
  // across it would restate settled payouts to match today's org chart.
  assert.equal(
    /`sales_records\?/.test(source),
    false,
    "the manager cascade must not PATCH sales_records — it is frozen (service_role holds no UPDATE) and it is the only record of what H1 was paid on",
  );

  // The writable half must survive the removal. service_role still holds UPDATE on sales_targets,
  // so deleting the frozen-table calls must not take this one with it.
  assert.match(
    source,
    /`sales_targets\?manager_hr_id=eq\./,
    "sales_targets is still writable and must still follow a manager change",
  );

  // Widening the catch is the tempting wrong fix. Swallowing a permission error would turn a loud
  // failure into a silent half-applied cascade — worse, because nobody would ever see it.
  assert.equal(
    /permission denied/.test(source.slice(source.indexOf("function isEmployeeDirectorySchemaMissing"), source.indexOf("function isEmployeeDirectoryTimeout"))),
    false,
    "permission-denied must not be swallowed by the optional-cascade catch — a silent half-applied cascade beats no error only in appearance",
  );
}
