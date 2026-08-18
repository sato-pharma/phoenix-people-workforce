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
const PORTAL = "src/components/employee-portal/marketing-request-drafts.tsx";
const TYPES = "src/lib/marketing-requests/types.ts";

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
 * The override exists because a blanket block was unshippable: 87 of 154 production customers
 * carry at least one `not_found` code. But it must never become a formality — the code may be
 * used only with a written reason, and that reason has to be stored on the request.
 */
function testOverrideRequiresAWrittenReasonAndRecordsIt() {
  const service = code(SERVICE);

  assert.match(
    service,
    /UNVERIFIED_CODE_REASON_MIN_LENGTH/,
    "an override reason must clear a minimum length — a one-word entry is not a reason",
  );
  assert.match(
    service,
    /unverifiedCodeReason/,
    "the override reason must be carried per pharmacy, not per request",
  );
  assert.match(
    service,
    /Unverified pharmacy code[^\n]*accepted/,
    "an accepted override must be written onto the request so the decision is auditable",
  );
  // Losing the requester's own note would be a silent data loss, and would also make the override
  // note look like something they typed.
  assert.match(
    service,
    /\[pharmacy\.notes,\s*overrideNote\]/,
    "the override note must be combined with the requester's note, never replace it",
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

/**
 * The other half of the same decision, and the half that was missing for six days.
 *
 * The server told the rep to "record why it must be used as-is", and no screen in the repository
 * ever sent `unverifiedCodeReason` — the portal posted `{ distributorCodeId }` alone. So the
 * override existed only in the API: a rep standing in front of a real pharmacy whose POS code we
 * had not imported was refused at submit and offered a remedy the form did not implement. A gate
 * whose documented escape hatch is unreachable is a hard block wearing a soft block's error
 * message, so the form must actually offer it.
 */
function testThePortalOffersTheOverrideItIsToldToUse() {
  const portal = code(PORTAL);

  // The payload, which is what was actually broken. Matched on the PROPERTY (`unverifiedCodeReason:`)
  // and not the bare word: the map body also names the `unverifiedCodeReasons` state it reads from,
  // so a looser pattern still passes with the property deleted — verified by deleting it.
  assert.match(
    portal,
    /pharmacies:\s*selectedPharmacyIds\.map\([\s\S]{0,400}\bunverifiedCodeReason:/,
    "the portal must send the reason with the pharmacy it belongs to, not omit it",
  );
  // A place to type it.
  assert.match(
    portal,
    /<textarea[\s\S]{0,600}setUnverifiedCodeReasons/,
    "the portal must render an input the rep can write the justification into",
  );
  // Shown only where it is needed, and only while the pharmacy is actually selected — unticking
  // the pharmacy is the other valid answer and must not demand a reason for a code being dropped.
  assert.match(
    portal,
    /unverified\s*&&\s*checked/,
    "the reason box must appear only for a selected `not_found` pharmacy",
  );
  // The rep must find out before pressing Save, not by being thrown back by the API.
  assert.match(
    portal,
    /unverifiedSelectionsMissingReason\.length === 0/,
    "Save must stay disabled while a selected unverified code has no acceptable reason",
  );
}

/**
 * One constant, imported by both sides.
 *
 * A second copy of `10` in the form would let the two drift, and the drift is invisible until a
 * rep types nine characters, sees an enabled Save button, and is refused by the API anyway. So the
 * minimum lives in the import-free types module and both sides read it from there.
 */
function testTheMinimumLengthHasExactlyOneDefinition() {
  const types = code(TYPES);
  const service = code(SERVICE);
  const portal = code(PORTAL);

  assert.match(
    types,
    /export const UNVERIFIED_CODE_REASON_MIN_LENGTH = \d+/,
    "the minimum must be defined in the types module, which the client can import safely",
  );
  for (const [label, source] of [["server", service], ["portal", portal]] as const) {
    assert.doesNotMatch(
      source,
      /const UNVERIFIED_CODE_REASON_MIN_LENGTH\s*=/,
      `the ${label} must import the minimum, never redeclare it`,
    );
    assert.match(
      source,
      /UNVERIFIED_CODE_REASON_MIN_LENGTH/,
      `the ${label} must actually enforce the shared minimum`,
    );
  }
}

export function runMarketingSubmissionCaptureGateTests() {
  testNotFoundPharmacyCodeIsBlockedAtWriteTime();
  testOverrideRequiresAWrittenReasonAndRecordsIt();
  testRecoverableStatusesAreNotBlocked();
  testThePortalOffersTheOverrideItIsToldToUse();
  testTheMinimumLengthHasExactlyOneDefinition();
}
