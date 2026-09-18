import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveUploadPeriod, withPeriodGateFinding } from "../src/lib/sales/sales-upload.ts";
import { periodToAutoFill } from "../src/lib/sales/upload-period-autofill.ts";
import type { ValidationReport } from "../src/lib/sales/upload-validation.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A sheet filed under a picked month must say which of its rows that re-dates.
//
// Filing a sheet under one month is allowed ("Pick a period above to import them all under one
// month"), and it rewrites every row the sheet dated in another month to the picked one. Nothing said
// so: the strict checks run on the rows after they are re-dated, bulk import picks the month before
// Validate, and on a single upload the page filled in the sheet's majority month for the operator
// under a green "Auto-detected" chip. Confirm then imported the other months' rows as that month's
// sales. Source of Sales audit, finding `src/components/sales/sales-upload-workspace.tsx:759`, still
// open on the 2026-09-06 re-measure and unchanged on main 2026-09-18.
//
// Production on 2026-09-18 (read-only): EG-HOS's August sheet carried one invoice dated 2026-07-25,
// and it is filed under August. That is the only validated row whose invoice date falls in another
// month than its batch. MC and SF rows also disagree, but only because their day-level date was
// misread. Before 2026-07 fewer than one row in ten kept its invoice date, so those months can be
// checked only in part.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = stripComments(readFileSync("src/lib/sales/sales-upload.ts", "utf8"));
const WORKSPACE = stripComments(readFileSync("src/components/sales/sales-upload-workspace.tsx", "utf8"));

const clean: ValidationReport = { ok: true, errorCount: 0, warningCount: 0, infoCount: 1, findings: [
  { code: "recognition_coverage_summary", severity: "info", title: "Recognition coverage", detail: "d", count: 1, sampleRows: [] },
] };

type Row = { invoiceDate: string; rawRowNumber: number };

// `count` rows dated `month`, numbered from `first`.
function rows(month: string, count: number, first: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ invoiceDate: month, rawRowNumber: first + i }));
}

export function runSalesUploadRedatedRowsTests() {
  // ── The headline: EG-HOS's August sheet with one July invoice, filed under August ──
  const egHos = [...rows("2026-08", 15, 2), { invoiceDate: "2026-07", rawRowNumber: 17 }, ...rows("2026-08", 25, 18)];
  const august = resolveUploadPeriod(egHos.map((r) => r.invoiceDate), "2026-08");
  const report = withPeriodGateFinding(clean, august, egHos);
  assert.equal(report.findings[0]?.code, "rows_redated", "a picked month that re-dates a July row must say so before Confirm");
  assert.deepEqual(report.findings[0], {
    code: "rows_redated",
    severity: "warning",
    title: "Rows dated in another month will be filed under 2026-08",
    detail: "Rows dated 2026-07 (1 row) will be imported as 2026-08 sales, because 2026-08 is the month picked for this file. 2026-07 will not include them.",
    count: 1,
    sampleRows: [17],
    fixHint: "If they belong to their own month, upload one month per file. If they are meant to count in this month, there is nothing to do.",
  });
  assert.equal(report.ok, true, "a warning, not a block: filing the sheet under one month stays the operator's choice");
  assert.equal(report.warningCount, 1);
  assert.equal(report.findings.length, 2, "validation's own findings are kept");

  // ── Several other months, named in month order, with the rows they hold ──────────
  const spread = [...rows("2026-05", 12, 2), ...rows("2026-06", 400, 14), ...rows("2026-07", 8000, 414), { invoiceDate: "2026-04", rawRowNumber: 8414 }];
  const july = withPeriodGateFinding(clean, resolveUploadPeriod(spread.map((r) => r.invoiceDate), "2026-07"), spread);
  assert.equal(
    july.findings[0].detail,
    "Rows dated 2026-04 (1 row), 2026-05 (12 rows) and 2026-06 (400 rows) will be imported as 2026-07 sales, because 2026-07 is the month picked for this file. Those months will not include them.",
  );
  assert.equal(july.findings[0].count, 413);
  assert.deepEqual(july.findings[0].sampleRows, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], "the first twelve moved rows");
  assert.ok(!july.findings[0].detail.includes("…"), "never an ellipsis: the owner's no-truncation rule");

  // ── A one-month sheet picked into a different month moves every row ─────────────
  const june = rows("2026-06", 30, 2);
  const shifted = withPeriodGateFinding(clean, resolveUploadPeriod(june.map((r) => r.invoiceDate), "2026-07"), june);
  assert.equal(
    shifted.findings[0].detail,
    "Rows dated 2026-06 (30 rows) will be imported as 2026-07 sales, because 2026-07 is the month picked for this file. 2026-06 will not include them.",
  );

  // ── Nothing moves, nothing is said ────────────────────────────────────────────
  assert.deepEqual(withPeriodGateFinding(clean, resolveUploadPeriod(june.map((r) => r.invoiceDate), "2026-06"), june), clean, "its own month re-dates nothing");
  assert.deepEqual(withPeriodGateFinding(clean, resolveUploadPeriod(june.map((r) => r.invoiceDate), ""), june), clean, "one month, none picked: nothing is re-dated");
  const dateless = rows("", 30, 2);
  assert.deepEqual(withPeriodGateFinding(clean, resolveUploadPeriod(dateless.map((r) => r.invoiceDate), "2026-07"), dateless), clean, "a sheet with no dates takes the picked month; no row had another");
  const refused = withPeriodGateFinding(clean, resolveUploadPeriod(spread.map((r) => r.invoiceDate), ""), spread);
  assert.deepEqual(refused.findings.map((f) => f.code), ["period_multi", "recognition_coverage_summary"], "with no month picked, the multi-month refusal alone speaks");

  // ── The page fills in only a sheet's own single month ─────────────────────────
  const preview = (periods: { period: string; rows: number }[]) => ({ period: periods.length ? [...periods].sort((a, b) => b.rows - a.rows)[0].period : null, periods });
  assert.equal(
    periodToAutoFill(preview([{ period: "2026-06", rows: 400 }, { period: "2026-07", rows: 8000 }]), ""),
    null,
    "a multi-month sheet is left blank: the majority month is not the operator's choice",
  );
  assert.equal(periodToAutoFill(preview([{ period: "2026-07", rows: 8000 }]), ""), "2026-07", "a one-month sheet is still filled in");
  assert.equal(periodToAutoFill(preview([{ period: "2026-07", rows: 8000 }]), "2026-08"), null, "a month already picked is never overwritten");
  assert.equal(periodToAutoFill(preview([]), ""), null, "a sheet with no dates has nothing to fill in");

  // ── The wiring ────────────────────────────────────────────────────────────────
  assert.match(
    SRC,
    /const validation = withPeriodGateFinding\([\s\S]*?decision,\s*rec\.result\.coded,\s*\);/,
    "analyzeMonthlyUpload must pass the rows as the sheet dated them, before consolidation",
  );
  assert.match(WORKSPACE, /periodToAutoFill\(payload\.data, period\)/, "Sales Upload must fill in the month through periodToAutoFill");
  assert.ok(!WORKSPACE.includes("applyAutoDetectedPeriod(payload.data.period)"), "never the bare majority month");
}
