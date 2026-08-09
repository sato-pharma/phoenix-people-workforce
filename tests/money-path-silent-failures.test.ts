import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { isPayrollSchemaMissing } from "@/lib/payroll/service";

const portalSource = readFileSync(
  new URL("../src/lib/employee-portal/service.ts", import.meta.url),
  "utf8",
);
const runServiceSource = readFileSync(
  new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url),
  "utf8",
);

/**
 * Three money-path failures that all present as a plausible number instead of an error.
 *
 * The shared shape: something goes wrong, the code treats it as "nothing to show", and the
 * user is handed a confident zero. Nobody investigates a number.
 */
export function runMoneyPathSilentFailureTests() {
  // ── 1. A permissions error must NOT read as "payroll schema missing" ───────
  // This used to substring-match table names, so ANY error mentioning a payroll table was
  // classified as "not deployed yet" and degraded to empty — which the payroll dashboard
  // renders as EGP 0.
  assert.equal(
    isPayrollSchemaMissing({ code: "42501", message: 'permission denied for table salary_records' }),
    false,
    "a permission error (42501) must surface, never degrade the payroll dashboard to EGP 0",
  );
  assert.equal(
    isPayrollSchemaMissing({ code: "57014", message: "canceling statement due to statement timeout" }),
    false,
    "a statement timeout must surface, not read as a missing schema",
  );
  assert.equal(
    isPayrollSchemaMissing({ code: "08006", message: "connection failure to salary_batches host" }),
    false,
    "a connection failure must surface even though the message names a payroll table",
  );

  // Genuine absence still degrades gracefully — that behaviour is deliberate.
  assert.equal(
    isPayrollSchemaMissing({ code: "42P01", message: 'relation "salary_records" does not exist' }),
    true,
    "a genuinely undefined table (42P01) is still treated as schema-missing",
  );
  assert.equal(
    isPayrollSchemaMissing({ code: "PGRST205", message: "Could not find the table in the schema cache" }),
    true,
    "PostgREST's table-not-in-cache code is still schema-missing",
  );
  assert.equal(
    isPayrollSchemaMissing({ code: "PGRST202", message: "Could not find the function" }),
    true,
    "PostgREST's function-not-found code is still schema-missing",
  );

  // No code available: fall back to message shapes that ASSERT absence, never a bare name.
  assert.equal(
    isPayrollSchemaMissing(new Error('relation "salary_flags" does not exist')),
    true,
    "an uncoded 'does not exist' error is still schema-missing",
  );
  assert.equal(
    isPayrollSchemaMissing(new Error("permission denied for table salary_records")),
    false,
    "an uncoded permission error must NOT be schema-missing just because it names a table",
  );

  // ── 2. Portal query failures must be logged, not discarded ────────────────
  assert.match(
    portalSource,
    /function logPortalFailure\([\s\S]{0,260}logError\(/,
    "the portal must route failed queries through a real logger, not a no-op",
  );
  for (const site of [
    "payroll query exception",
    "salary history query error",
    "sales query exception",
  ]) {
    assert.ok(
      portalSource.includes(`logPortalFailure("${site}"`),
      `"${site}" is a FAILURE and must not go through the discard-everything debug logger`,
    );
  }
  // The no-op must survive for genuine informational traces, so this stays a real distinction.
  assert.match(
    portalSource,
    /function logPortalDebug\(message: string, payload\?: unknown\) \{\s*\n\s*void message;/,
    "the informational no-op should remain for traces that would be production noise",
  );

  // ── 3. Carry-forward debt must only be settled for rows actually deducted ──
  assert.match(
    runServiceSource,
    /const recoveredCompacts = rows\s*\n?\s*\.filter\(\(entry\) => entry\.carriedForwardApplied > 0 && !entry\.onHold\)/,
    "recovered carry-forward must be derived from the assembled rows that actually carried the deduction",
  );
  assert.doesNotMatch(
    runServiceSource,
    /const recoveredCompacts = Array\.from\(carryForwardByCompact\.keys\(\)\)/,
    "carry-forward must never be settled straight from the ledger map — that writes off debt for employees the run excluded, held, or never paid",
  );
  // Held rows assemble but are dropped by publishToPayslips, so they must be excluded too.
  assert.match(
    runServiceSource,
    /!entry\.onHold/,
    "a held row is never published to payslips, so its debt must not be marked recovered",
  );
}
