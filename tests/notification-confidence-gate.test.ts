import { strict as assert } from "node:assert";

import {
  checkContentIntegrity,
  checkIdentityResolved,
  checkRecipientValidity,
  computeDecision,
} from "../src/lib/notifications/confidence-gate.ts";

function baseInput(overrides: Partial<Parameters<typeof checkContentIntegrity>[0]> = {}) {
  return {
    html: "<p>Hello</p>",
    idempotencyKey: "test-key",
    subject: "Hello",
    text: "Hello",
    to: ["employee@satopharma.com"],
    ...overrides,
  };
}

export function runNotificationConfidenceGateTests() {
  // content_integrity: passes on fully-rendered content, fails on an unresolved {{token}} or
  // an empty field — the exact 2026-07-14 blank-token incident class.
  assert.equal(checkContentIntegrity(baseInput()).passed, true, "fully rendered content must pass");
  assert.equal(
    checkContentIntegrity(baseInput({ html: "<p>Hi {{employeeName}}</p>" })).passed,
    false,
    "an unresolved {{token}} in the body must fail content_integrity",
  );
  assert.equal(checkContentIntegrity(baseInput({ subject: "" })).passed, false, "an empty subject must fail content_integrity");
  assert.equal(checkContentIntegrity(baseInput({ html: "   " })).passed, false, "whitespace-only html must fail content_integrity");

  // recipient_validity: at least one syntactically valid address required.
  assert.equal(checkRecipientValidity(baseInput()).passed, true, "a valid recipient must pass");
  assert.equal(checkRecipientValidity(baseInput({ to: [] })).passed, false, "no recipient must fail recipient_validity");
  assert.equal(checkRecipientValidity(baseInput({ to: ["not-an-email"] })).passed, false, "a malformed address must fail recipient_validity");

  // identity_resolved: not-applicable (null) when the caller supplied no identity status —
  // this must NEVER count against a send, since most direct sendPhoenixEmail callers don't
  // carry one.
  assert.equal(checkIdentityResolved(baseInput()).passed, null, "no identity status supplied must be not-applicable, not a fail");
  assert.equal(checkIdentityResolved(baseInput({ origin: { identityStatus: "verified" } })).passed, true, "verified identity must pass");
  assert.equal(checkIdentityResolved(baseInput({ origin: { identityStatus: "unresolved" } })).passed, false, "a non-verified identity status must fail");

  // computeDecision: the actual gate. One failing check holds the whole send outright — three
  // passing checks must never outvote one failing one (that dilution is exactly what would
  // have let the 2026-07-23 incident's fan-out failure slip through on points).
  const allPass = computeDecision([
    { detail: "", name: "content_integrity", passed: true },
    { detail: "", name: "recipient_validity", passed: true },
    { detail: "", name: "fanout_anomaly", passed: true },
  ]);
  assert.equal(allPass.decision, "auto_send", "all checks passing must auto-send");
  assert.equal(allPass.confidencePercent, 100, "all checks passing must be 100% confidence");

  const oneFails = computeDecision([
    { detail: "", name: "content_integrity", passed: true },
    { detail: "", name: "recipient_validity", passed: true },
    { detail: "", name: "fanout_anomaly", passed: false },
  ]);
  assert.equal(oneFails.decision, "hold", "one failing check (fanout_anomaly) must hold, even with two checks passing");
  assert.equal(oneFails.confidencePercent, 67, "confidence must reflect 2 of 3 applicable checks passing");

  const notApplicableIgnored = computeDecision([
    { detail: "", name: "content_integrity", passed: true },
    { detail: "", name: "identity_resolved", passed: null },
    { detail: "", name: "fanout_anomaly", passed: null },
  ]);
  assert.equal(notApplicableIgnored.decision, "auto_send", "not-applicable checks must never force a hold");
  assert.equal(notApplicableIgnored.confidencePercent, 100, "not-applicable checks must be excluded from the confidence percent");

  const allNotApplicable = computeDecision([
    { detail: "", name: "identity_resolved", passed: null },
    { detail: "", name: "fanout_anomaly", passed: null },
  ]);
  assert.equal(allNotApplicable.decision, "auto_send", "no applicable checks at all must default to auto_send");
  assert.equal(allNotApplicable.confidencePercent, 100, "no applicable checks at all must default to 100%");
}
