import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The three ingestion items Phase 11 deferred. Two are guarded here by source scan (they live deep
// in the distributor parser and validation report, which are not cheaply fixture-driven); the
// office-pivot third is covered by fixtures in tests/office-pivot.test.ts.
//
//  1. DIRECT VALUE SILENTLY ZEROED. Direct is the one channel whose value comes straight from the
//     sheet, so it is the one place an unreadable value cell reaches `value` and is then zeroed by
//     the DB insert (`value: Number.isFinite(row.value) ? row.value : 0`). The row looked imported
//     while its sale value vanished.
//  2. BLANK-CUSTOMER ONLY WARNED ABOVE 20%. Below the threshold, skipped rows (which drop their
//     quantity from the import) produced NO signal at all.

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const read = (p: string) => code(readFileSync(join(process.cwd(), p), "utf8"));

export function runSosIngestionRemainderTests() {
  // ── 1. An unreadable Direct value raises an issue instead of being zeroed ────
  {
    const parser = read("src/lib/sales/monthly-distributor-import.ts");
    assert.match(
      parser,
      /if \(isDirect && !Number\.isFinite\(value\) && normalizeDisplay\(rawSheetValue\)\)/,
      "a non-empty, unreadable Direct value cell must raise a validation issue",
    );
    // Only Direct: every other channel derives value from qty * price, and qty is already checked.
    assert.match(
      parser,
      /"Value must be numeric\."/,
      "the Direct value issue must be worded like the sibling numeric checks",
    );
    // An EMPTY Direct value is still a legitimate zero — the normalizeDisplay guard is what keeps
    // this from rejecting a blank cell.
    assert.ok(
      /!Number\.isFinite\(value\) && normalizeDisplay\(rawSheetValue\)/.test(parser),
      "an empty Direct value cell must NOT be treated as an error",
    );
  }

  // ── 2. Blank-customer count is always surfaced, warning above the threshold ──
  {
    const validation = read("src/lib/sales/upload-validation.ts");
    assert.match(
      validation,
      /if \(s\.totalRows > 0 && s\.blankCustomerSkipped > 0\)/,
      "ANY skipped blank-customer row must be surfaced, not only above 20%",
    );
    assert.match(
      validation,
      /severity: high \? "warning" : "info"/,
      "above the threshold is a warning; below it, an info line so the count is never invisible",
    );
    // The 20% threshold constant must still exist — this quiets the sub-threshold case, it does not
    // remove the loud one.
    assert.match(validation, /HIGH_BLANK_CUSTOMER_RATE = 0\.2/, "the 20% warning threshold must remain");
    assert.match(validation, /const high = rate > HIGH_BLANK_CUSTOMER_RATE/, "the threshold still decides severity");
  }

  // ── 3. Office pivot refuses an unreadable-units product rather than zeroing it ─
  {
    const upload = read("src/lib/sales/office-upload.ts");
    assert.match(
      upload,
      /if \(pivot\.badUnitsRows\.length > 0\)/,
      "an office file with unreadable units must be refused, not partially imported",
    );
    assert.match(upload, /SalesWorkflowError/, "the refusal is a workflow error the operator sees");
    // And the empty-file check must now also consider badUnitsRows, or a file that is ALL bad-units
    // would wrongly report "no product rows" instead of the specific reason.
    assert.match(
      upload,
      /pivot\.rows\.length === 0 && pivot\.badUnitsRows\.length === 0/,
      "the empty-file check must account for bad-units-only files",
    );
  }
}
