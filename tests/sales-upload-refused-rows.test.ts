import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { importDiagnosticsVerdict } from "../src/lib/sales/import-diagnostics-verdict.ts";
import { distinctUnknowns } from "../src/lib/sales/normalizer/mapping.ts";
import { describeRefusedRow, type RefusedRow } from "../src/lib/sales/normalizer/row-messages.ts";
import type { NormalizeException } from "../src/lib/sales/normalizer/types.ts";
import { blocksImport, withRefusedRowsFinding } from "../src/lib/sales/sales-upload.ts";
import type { ValidationReport } from "../src/lib/sales/upload-validation.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Analyze (Sales Upload's Validate step, and the Diagnostics page) must refuse every file commit refuses.
//
// Commit refuses the whole file when any row is an exception other than an unknown product. A row
// whose quantity, value or discount cannot be read, or a blank customer where the profile makes that
// an error (EGD Branch), sat in no unmapped list and tripped no strict check. So Diagnostics showed the
// green "Fully recognized — this file would import cleanly", Sales Upload said "Validation passed",
// and the upload imported nothing. Source of Sales audit, finding
// `src/components/sales/sales-diagnostics-workspace.tsx:136`, still open on the 2026-09-06 re-measure.
//
// Production on 2026-09-18 (read-only): EGD Branch, the one profile that makes a blank customer an
// error, has uploaded every month from January to August. A refused upload stores nothing, so how
// often this struck cannot be counted.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = stripComments(readFileSync("src/lib/sales/sales-upload.ts", "utf8"));
const COMMIT_ROUTE = stripComments(readFileSync("app/api/sales/sales-upload/commit/route.ts", "utf8"));

const clean: ValidationReport = { ok: true, errorCount: 0, warningCount: 1, infoCount: 1, findings: [
  { code: "recognition_coverage_summary", severity: "info", title: "Recognition coverage", detail: "d", count: 1, sampleRows: [] },
] };

// The cell each refused reason carries, as the engine records it.
const CELL: Partial<Record<NormalizeException["reason"], string>> = { unparseable_qty: "1,2OO", unparseable_value: "12,5OO", discount_out_of_range: "150" };

// Every reason in the union: adding one fails the typecheck here until this test says how it is shown.
const REASONS: Record<NormalizeException["reason"], true> = {
  product: true,
  brick: true,
  both: true,
  blank_customer: true,
  unparseable_qty: true,
  unparseable_value: true,
  discount_out_of_range: true,
};

function exception(reason: NormalizeException["reason"], row: number): NormalizeException {
  return {
    rawProduct: "1022",
    rawProductName: "TEBOFORTIN FORTE 30TAB",
    rawTerritory: reason === "blank_customer" ? "" : "Nasr City",
    rawCustomerCode: reason === "blank_customer" ? "" : "C-88",
    rawCustomerName: "",
    rawCustomerAddress: "",
    rawRowNumber: row,
    reason,
    ...(CELL[reason] ? { rawCell: CELL[reason] } : {}),
  };
}

function refusedRow(reason: RefusedRow["reason"], rawCell?: string): RefusedRow {
  return { ...exception(reason, 7), reason, rawCell };
}

export function runSalesUploadRefusedRowsTests() {
  // ── The headline: 40 unreadable quantities in an otherwise clean sheet ────────
  const unreadable = Array.from({ length: 40 }, (_, i) => exception("unparseable_qty", 100 + i));
  const report = withRefusedRowsFinding(clean, unreadable);
  assert.equal(
    report.ok,
    false,
    "commit refuses a file with a single unreadable quantity — analyze must not report it ok, or Diagnostics says it would import cleanly",
  );

  // ── Diagnostics' banner follows: danger, never the green verdict ──────────────
  const unmapped = distinctUnknowns(unreadable, []);
  assert.equal(unmapped.products.length + unmapped.territories.length + unmapped.customers.length, 0, "an unreadable cell is no unmapped item");
  assert.equal(
    importDiagnosticsVerdict({ unmappedCount: 0, strictErrorCount: report.errorCount }),
    "danger",
    "with nothing unmapped, only the strict-check error keeps Diagnostics off \"would import cleanly\"",
  );

  // ── The finding says what is wrong, where, and that it is the whole file ──────
  const finding = report.findings[0];
  assert.equal(finding.code, "rows_refused");
  assert.equal(finding.severity, "error");
  assert.equal(finding.count, 40);
  assert.equal(report.errorCount, 1);
  assert.equal(report.findings.length, 2, "validation's own findings are kept");
  assert.deepEqual(finding.sampleRows, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111], "the first twelve row numbers");
  assert.equal(finding.sampleProducts, undefined, "raw product text is never shown: the confidential-product exclusion cannot recognise it");
  // ...and names each row with the cell as written: eight of them, then how many more.
  const eight = Array.from({ length: 8 }, (_, i) => `Row ${100 + i}: quantity "1,2OO" has letters in it`).join("; ");
  assert.equal(
    finding.detail,
    `40 with a quantity that cannot be read. ${eight}; and 32 more. `
      + "One such row is enough for the import to refuse the whole file, not just these rows, and no mapping can fix them.",
  );
  assert.ok(!finding.detail.includes("…"), "never an ellipsis: the owner's no-truncation rule");

  // ── Each kind of problem is said in words the person will find in their sheet ──
  assert.equal(describeRefusedRow(refusedRow("unparseable_value", "12,5OO")), 'Row 7: value "12,5OO" has letters in it');
  assert.equal(describeRefusedRow(refusedRow("unparseable_qty", "1 23")), 'Row 7: quantity "1 23" is not a number');
  assert.equal(describeRefusedRow(refusedRow("unparseable_qty", "(120)")), 'Row 7: quantity "(120)" is in brackets');
  assert.equal(describeRefusedRow(refusedRow("unparseable_qty", "١٢ علبة")), 'Row 7: quantity "١٢ علبة" has letters in it', "an Arabic word is a letter too");
  assert.equal(describeRefusedRow(refusedRow("discount_out_of_range", "-5")), 'Row 7: discount "-5" is negative');
  assert.equal(describeRefusedRow(refusedRow("discount_out_of_range", "150")), 'Row 7: discount "150" is 100% or more');
  assert.equal(describeRefusedRow(refusedRow("discount_out_of_range", "100%")), 'Row 7: discount "100%" is 100% or more');
  assert.equal(describeRefusedRow(refusedRow("discount_out_of_range", "5 pct")), 'Row 7: discount "5 pct" has letters in it');
  assert.equal(
    describeRefusedRow(refusedRow("discount_out_of_range", "1")),
    'Row 7: discount "1" could mean 1% or 100%, so it is not guessed; write 1% or 100%',
  );
  assert.equal(describeRefusedRow(refusedRow("blank_customer")), "Row 7: no customer code, territory or brick");
  assert.equal(describeRefusedRow(refusedRow("unparseable_qty")), "Row 7: the quantity cannot be read", "a row with no cell recorded");
  const mixed = withRefusedRowsFinding(clean, [
    exception("blank_customer", 5),
    exception("unparseable_value", 6),
    exception("discount_out_of_range", 7),
    exception("blank_customer", 8),
    exception("product", 9),
  ]);
  assert.match(
    mixed.findings[0].detail,
    /^2 with no customer code, territory or brick · 1 with a value that cannot be read · 1 with a discount that is unreadable, negative, or 100% or more\. /,
  );
  assert.equal(mixed.findings[0].count, 4, "the unknown product is not a refused row");

  // ── Every reason commit blocks on is shown somewhere; the one it tolerates is not ─
  for (const reason of Object.keys(REASONS) as NormalizeException["reason"][]) {
    const row = exception(reason, 2);
    const folded = withRefusedRowsFinding(clean, [row]);
    const places = distinctUnknowns([row], []);
    if (blocksImport(row)) {
      assert.ok(
        !folded.ok || places.territories.length + places.customers.length > 0,
        `commit refuses a "${reason}" row, so analyze must refuse it or list it as an unmapped place`,
      );
    } else {
      assert.deepEqual(folded, clean, `commit imports the rest of a file with a "${reason}" row, so analyze must not refuse it`);
    }
  }
  assert.equal(blocksImport(exception("product", 2)), false, "an unknown product is the one exception commit tolerates");
  assert.deepEqual(
    withRefusedRowsFinding(clean, [exception("brick", 2), exception("both", 3)]),
    clean,
    "an unmapped place is already listed as an unmapped item, with the mapping fix beside it",
  );

  // ── The wiring: analyze folds it in, and commit blocks on the same rule ───────
  assert.match(
    SRC,
    /withRefusedRowsFinding\(\s*await runStrictValidation\([^;]*\),\s*rec\.result\.exceptions,\s*\)/,
    "analyzeMonthlyUpload must fold the refused rows into the report it returns",
  );
  assert.match(SRC, /const blockingExceptions = result\.exceptions\.filter\(blocksImport\);/, "commit must block on blocksImport");
  assert.match(
    SRC,
    /status: "blocked",[^}]*refused: refusedRowsFinding\(blockingExceptions\)/,
    "a blocked commit must carry the same finding, so its refusal names the rows too",
  );
  assert.match(
    COMMIT_ROUTE,
    /code: refused \? "blocked_refused_rows" : "blocked_unmapped"/,
    "the commit route must stop sending a bad cell to Mapping Database",
  );
}
