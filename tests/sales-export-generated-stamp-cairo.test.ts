import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The owner reads every timestamp in Cairo local, never raw UTC (house rule). The XLSX "Generated"
// cover/metadata stamp on these four sales deliverables used to read "YYYY-MM-DD HH:MM UTC"; it now
// reads Cairo wall-clock via cairoDateTimeSortable, matching the CRM master exports pinned in
// crm-portal-scope.test.ts. These routes/modules build the workbook behind a DB read and can't be
// unit-tested without infra, so — as the CRM guards do — we pin the stamp's shape in the source.

const SALES_EXPORT_STAMP_FILES = [
  "app/api/sales/weekly/export/route.ts",
  "app/api/sales/weekly/summary-export/route.ts",
  "app/api/sales/sos-dashboard/export/route.ts",
  "src/lib/sales/sos-report-delivery.ts",
];

export function runSalesExportGeneratedStampCairoTests() {
  for (const path of SALES_EXPORT_STAMP_FILES) {
    const source = readFileSync(path, "utf8");
    assert.ok(
      source.includes('const generatedAt = cairoDateTimeSortable(new Date().toISOString()) + " Cairo";'),
      `${path}: the export "Generated" stamp must be Cairo wall-clock via cairoDateTimeSortable`,
    );
    // The specific raw-UTC stamp expression must be gone. Kept precise (the whole suffix, not a bare
    // "UTC") so a legitimate comment mentioning UTC elsewhere in the file can never trip the guard.
    assert.ok(
      !source.includes('.slice(0, 16) + " UTC"'),
      `${path}: the export "Generated" stamp must not be raw UTC`,
    );
  }
}
