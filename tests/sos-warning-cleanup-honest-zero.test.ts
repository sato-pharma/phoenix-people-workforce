import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  describeStoredValidationStates,
  explainNoStoredWarnings,
  type SourceOfSalesLeftOutTotals,
} from "../src/lib/sales/source-of-sales-warning-cleanup.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The warning-cleanup script's `verify` must not print a zero it could never fail to print.
//
// The importers that write source_of_sales_import_rows store only the rows they keep, each marked
// valid, and leave a problem row out of the table. `verify` counted the stored states and printed
// "warning: 0" with nothing beside it — a clean bill of health it gave by construction — and `export`
// wrote a workbook with no sheets and said "Exported 0 warning rows". Source of Sales audit, finding
// `scripts/source-of-sales-warning-cleanup.ts:147`, still open on the 2026-09-06 re-measure.
//
// Production on 2026-09-18 (read-only): 362,338 stored rows, every one valid, none carrying an issue,
// across 138 batches that recorded 7,667 rows ignored and 13 skipped for a blank customer.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT = "scripts/source-of-sales-warning-cleanup.ts";

const PRODUCTION: SourceOfSalesLeftOutTotals = { batches: 138, blankCustomer: 13, failed: 0, ignored: 7667, warnings: 0 };

const NOT_CLEAN = /^NOT a clean bill of health/;

export function runSosWarningCleanupHonestZeroTests() {
  const lines = describeStoredValidationStates({ valid: 362338 }, PRODUCTION);

  // ── The headline: an all-valid table says why it is all valid ────────────────
  assert.ok(
    lines.some((line) => NOT_CLEAN.test(line)),
    "every stored row is valid and none is a warning — verify must say that zero is not a clean bill of health, not print it bare",
  );

  // ── The three counts keep their old lines, then what was left out ────────────
  assert.deepEqual(lines.slice(0, 3), ["valid: 362338", "warning: 0", "failed: 0"]);
  assert.equal(
    lines.at(-1),
    "Left out at import, as 138 batches recorded it: 7,667 ignored (a product we don't sell, or free goods) · 13 blank customer · 0 warnings · 0 failed.",
    "what the importers left out is read from the batches, the one place it is counted",
  );
  assert.equal(
    describeStoredValidationStates({}, { ...PRODUCTION, batches: 1 }).at(-1)?.startsWith("Left out at import, as 1 batch recorded it:"),
    true,
  );

  // ── A row really stored as a warning is reported as it is ─────────────────────
  const real = describeStoredValidationStates({ valid: 10, warning: 2 }, PRODUCTION);
  assert.deepEqual(real.slice(0, 3), ["valid: 10", "warning: 2", "failed: 0"]);
  assert.equal(real.some((line) => NOT_CLEAN.test(line)), false, "a real warning needs no disclaimer");
  assert.equal(real.length, 4, "the counts, then the left-out line");
  assert.equal(
    describeStoredValidationStates({ failed: 1 }, PRODUCTION).some((line) => NOT_CLEAN.test(line)),
    false,
    "a stored failed row is real too",
  );

  // ── `export` says the same thing ──────────────────────────────────────────────
  const explained = explainNoStoredWarnings(PRODUCTION);
  assert.equal(explained.length, 2);
  assert.match(explained[0], NOT_CLEAN);
  assert.equal(explained[1], lines.at(-1));

  // ── The script prints through them, reads the batches, and writes no empty workbook ─
  const script = stripComments(readFileSync(SCRIPT, "utf8"));
  assert.match(script, /describeStoredValidationStates\(stateCounts, await loadLeftOutTotals\(supabase\)\)/, "verify must print through describeStoredValidationStates");
  assert.doesNotMatch(script, /console\.log\(`warning: \$\{/, "verify must not print the bare warning count");
  assert.match(
    script,
    /\.from\("source_of_sales_import_batches"\)\s*\.select\("id,rows_ignored,rows_blank,warning_rows,failed_rows"\)/,
    "the left-out figures come from the batches",
  );
  const exportBody = script.slice(script.indexOf("async function exportWarnings"), script.indexOf("function cellText"));
  const emptyCheck = exportBody.indexOf("if (rows.length === 0)");
  assert.ok(emptyCheck !== -1 && emptyCheck < exportBody.indexOf("writeFile"), "export must stop before writing a workbook with no sheets");
  assert.match(exportBody, /explainNoStoredWarnings\(await loadLeftOutTotals\(supabase\)\)/, "and say why there was nothing to export");
}
