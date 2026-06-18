import assert from "node:assert/strict";

import {
  RECOGNITION_ENGINE_VERSION,
  dominantPeriod,
  normalizeUploadedFile as recognizeAlias,
  recognizeDistributorWorkbook,
  summarizePreview,
  type NormalizePreview,
} from "../src/lib/sales/recognize.ts";
import {
  normalizeUploadedFile as serviceRecognize,
  summarizePreview as serviceSummarize,
} from "../src/lib/sales/normalizer/service.ts";
import type { CodedRow, NormalizeResult } from "../src/lib/sales/normalizer/types.ts";

// Prime-directive guard: there must be ONE recognizer implementation. The service module only
// re-exports the canonical recognizer; analyze and upload therefore can never diverge.
function singleRecognizerIdentity() {
  assert.equal(recognizeAlias, recognizeDistributorWorkbook, "normalizeUploadedFile must alias the canonical recognizer");
  assert.equal(serviceRecognize, recognizeDistributorWorkbook, "service.ts must re-export the same recognizer (single source)");
  assert.equal(serviceSummarize, summarizePreview, "service.ts must re-export the same summarizePreview");
}

function engineVersionStamp() {
  assert.equal(typeof RECOGNITION_ENGINE_VERSION, "string");
  assert.ok(RECOGNITION_ENGINE_VERSION.length > 0, "recognition engine version must be a non-empty string");
}

function dominantPeriodPicksMostFrequent() {
  const rows = [
    { invoiceDate: "2026-05" },
    { invoiceDate: "2026-05" },
    { invoiceDate: "2026-04" },
  ] as unknown as CodedRow[];
  assert.equal(dominantPeriod(rows), "2026-05");
  assert.equal(dominantPeriod([] as unknown as CodedRow[]), null);
  assert.equal(dominantPeriod([{ invoiceDate: "" }] as unknown as CodedRow[]), null);
}

function summarizePreviewShape() {
  const result = {
    coded: [
      { invoiceDate: "2026-05" },
      { invoiceDate: "2026-05" },
      { invoiceDate: "2026-04" },
    ],
    exceptions: [],
    ignoredRows: [],
    blankCustomerRows: [],
    summary: {
      brickResolved: 3,
      blankCustomerSkipped: 0,
      fullyCoded: 3,
      ignored: 0,
      productResolved: 3,
      totalRows: 3,
    },
  } as unknown as NormalizeResult;

  const preview: NormalizePreview = summarizePreview("PS", "Overseas", result, []);
  assert.equal(preview.distributorCode, "PS");
  assert.equal(preview.distributorName, "Overseas");
  assert.equal(preview.period, "2026-05", "preview period is the dominant period");
  assert.deepEqual(
    preview.periods,
    [{ period: "2026-04", rows: 1 }, { period: "2026-05", rows: 2 }],
    "periods are aggregated + sorted ascending",
  );
  assert.equal(preview.unknownProducts.length, 0);
  assert.equal(preview.unknownTerritories.length, 0);
  assert.equal(preview.unknownCustomers.length, 0);
  assert.equal(preview.summary.totalRows, 3);
}

export function runSalesRecognizeTests() {
  singleRecognizerIdentity();
  engineVersionStamp();
  dominantPeriodPicksMostFrequent();
  summarizePreviewShape();
}
