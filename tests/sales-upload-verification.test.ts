import assert from "node:assert/strict";

import { resolveVerificationStep } from "../src/lib/sales/upload-verification-step.ts";

// Regression coverage for the Sales Upload Step-1 dead-end: the wizard once only offered a Confirm
// button when auto-detection succeeded, so files it couldn't recognize (or an ambiguous tie) left the
// operator silently stuck with Validate locked. resolveVerificationStep is the single source of truth
// for the panel + whether a Confirm path is shown; these tests pin the "never stuck" invariant.

function idleBeforeVerification() {
  const v = resolveVerificationStep({ ran: false, detectedCode: null, selectedCode: "PS" });
  assert.equal(v.panel, "idle");
  assert.equal(v.canConfirm, false); // nothing has run yet → no panel, no confirm
}

function matchUnlocks() {
  const v = resolveVerificationStep({ ran: true, detectedCode: "PS", selectedCode: "PS" });
  assert.equal(v.panel, "match");
  assert.equal(v.canConfirm, true);
}

function matchIsCaseAndSpaceInsensitive() {
  const v = resolveVerificationStep({ ran: true, detectedCode: " ps ", selectedCode: "PS" });
  assert.equal(v.panel, "match"); // trivial casing/space diff must NOT read as a mismatch
  assert.equal(v.canConfirm, true);
}

function mismatchWarnsButStillUnlocks() {
  const v = resolveVerificationStep({ ran: true, detectedCode: "EGD", selectedCode: "PS" });
  assert.equal(v.panel, "mismatch");
  assert.equal(v.canConfirm, true); // override path so a false detection can't trap the operator
}

function unrecognizedStillUnlocks() {
  // detectedCode null after a finished run = no profile matched OR an ambiguous tie (best=null)
  const v = resolveVerificationStep({ ran: true, detectedCode: null, selectedCode: "PS" });
  assert.equal(v.panel, "unrecognized");
  assert.equal(v.canConfirm, true); // the exact bug that locked Validate — must always be confirmable
}

function autoDetectBeforeExplicitRunStillShows() {
  // Detection runs automatically on file pick (ran may still be false at that instant); a found
  // distributor must already render its panel + confirm rather than waiting for the button.
  const v = resolveVerificationStep({ ran: false, detectedCode: "PS", selectedCode: "PS" });
  assert.equal(v.panel, "match");
  assert.equal(v.canConfirm, true);
}

// THE INVARIANT: once a detection attempt has finished, the operator can ALWAYS confirm and proceed —
// for every possible detection outcome. This is the guard that keeps the dead-end from coming back.
function finishedVerificationIsAlwaysConfirmable() {
  const detectedCodes = [null, "PS", "ps", "EGD", "   ", "UNKNOWN-DIST"];
  for (const detectedCode of detectedCodes) {
    const v = resolveVerificationStep({ ran: true, detectedCode, selectedCode: "PS" });
    assert.equal(v.canConfirm, true, `finished verification must be confirmable for detectedCode=${JSON.stringify(detectedCode)}`);
    assert.notEqual(v.panel, "idle", `finished verification must show a panel for detectedCode=${JSON.stringify(detectedCode)}`);
  }
}

export function runSalesUploadVerificationTests() {
  idleBeforeVerification();
  matchUnlocks();
  matchIsCaseAndSpaceInsensitive();
  mismatchWarnsButStillUnlocks();
  unrecognizedStillUnlocks();
  autoDetectBeforeExplicitRunStillShows();
  finishedVerificationIsAlwaysConfirmable();
}
