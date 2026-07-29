import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Capture gates for the 1 August Phoenix cutover.
//
// These guard a decision, not an implementation detail. A defect in what gets WRITTEN at
// submission is permanent: by the time a broken ROI shows up months later, the measurement window
// has closed and the evidence cannot be reconstructed. So the rules live at the write path and are
// pinned here — in BOTH directions, because over-tightening the gate would block legitimate
// submissions on day one, which is its own kind of failure.

const SERVICE = "src/lib/marketing-requests/service.ts";

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * A pharmacy code the reference database cannot find can never attribute a sale — attribution
 * matches on the exact code. Production measured a `not_found` code as having no sales 27.9% of
 * the time versus 1.3% for a matched one. It must be refused at write time.
 */
function testNotFoundPharmacyCodeIsBlockedAtWriteTime() {
  const service = code(SERVICE);

  assert.match(
    service,
    /reference_status\s*===\s*"not_found"/,
    "submission must refuse a pharmacy code the reference database cannot find",
  );
  assert.match(
    service,
    /pharmacy_code_not_in_reference/,
    "the refusal must carry a stable error code so the UI can explain it",
  );
}

/**
 * The counterpart guard. `ambiguous` (a code registered against several distributors) and
 * `pending` (a new code the matcher has not processed yet) both still attribute, and both are
 * recoverable. Blocking them would stop a legitimate submission the day a new pharmacy is added —
 * so the gate must stay scoped to `not_found` alone.
 */
function testRecoverableStatusesAreNotBlocked() {
  const service = code(SERVICE);

  assert.doesNotMatch(
    service,
    /reference_status\s*===\s*"ambiguous"[^\n]*throw/,
    "an ambiguous pharmacy code must not block submission — it still attributes and is recoverable",
  );
  assert.doesNotMatch(
    service,
    /reference_status\s*!==\s*"matched"[^\n]*throw/,
    "the gate must not demand `matched` — that would block every newly-added pharmacy code",
  );
}

export function runMarketingSubmissionCaptureGateTests() {
  testNotFoundPharmacyCodeIsBlockedAtWriteTime();
  testRecoverableStatusesAreNotBlocked();
}
