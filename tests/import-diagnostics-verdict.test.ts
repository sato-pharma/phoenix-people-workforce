import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importDiagnosticsVerdict } from "../src/lib/sales/import-diagnostics-verdict.ts";

/**
 * Sales Diagnostics chose its verdict banner from the unmapped count ALONE:
 *
 *   unknowns > 0 ? "would block import" : "Fully recognized — this file would import cleanly"
 *
 * `analyze.validation.errorCount` was rendered in the Strict checks box a few lines below and had no
 * say. So a file with zero unmapped items and a dozen strict-check errors got a green tick reading
 * "this file would import cleanly" — the one sentence on that screen a person actually acts on.
 */

const WORKSPACE = readFileSync(
  new URL("../src/components/sales/sales-diagnostics-workspace.tsx", import.meta.url),
  "utf8",
);

export function runImportDiagnosticsVerdictTests() {
  // 1. The headline: clean mapping but failing strict checks is NOT a clean file.
  assert.equal(
    importDiagnosticsVerdict({ unmappedCount: 0, strictErrorCount: 12 }),
    "danger",
    "strict-check errors must never sit behind a green 'would import cleanly' banner",
  );

  // 2. Genuinely clean stays green — the fix must not turn the banner into permanent noise.
  assert.equal(
    importDiagnosticsVerdict({ unmappedCount: 0, strictErrorCount: 0 }),
    "success",
    "a file with nothing unmapped and no errors is clean and must still say so",
  );

  // 3. Unmapped items alone stay a warning, as before.
  assert.equal(
    importDiagnosticsVerdict({ unmappedCount: 3, strictErrorCount: 0 }),
    "warning",
    "unmapped items alone remain a warning",
  );

  // 4. Errors outrank unmapped items — the stronger problem is the one to name.
  assert.equal(
    importDiagnosticsVerdict({ unmappedCount: 3, strictErrorCount: 1 }),
    "danger",
    "a strict-check error outranks unmapped items; it decides whether the file is usable at all",
  );

  // 5. The wiring, which is the half that shipped broken. The screen must ask the helper, and the
  //    bare unmapped-only ternary that produced the false green must be gone.
  assert.ok(
    WORKSPACE.includes("importDiagnosticsVerdict({"),
    "the diagnostics screen must resolve its banner through importDiagnosticsVerdict",
  );
  assert.ok(
    !WORKSPACE.includes("{unknowns > 0 ? ("),
    "the banner must not be chosen from the unmapped count alone — that is the defect",
  );
  assert.ok(
    WORKSPACE.includes('verdict === "danger"'),
    "the screen must render the danger verdict, not just compute it",
  );
}
