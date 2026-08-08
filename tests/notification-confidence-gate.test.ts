import { strict as assert } from "node:assert";

import {
  checkContentIntegrity,
  checkIdentityResolved,
  checkRecipientValidity,
  computeDecision,
  computeRecipientVolumeCeiling,
  FIRST_RUN_CEILING_OVERRIDES,
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

  // The three statuses resolvedEmailIdentity (system.ts) actually emits:
  // "verified" | "not_required" | "failed". Only "failed" is a real problem — it is set solely on
  // conflicting subject HR IDs, or a missing subject HR ID on a workflow email that requires one.
  assert.equal(checkIdentityResolved(baseInput({ origin: { identityStatus: "verified" } })).passed, true, "verified identity must pass");
  assert.equal(checkIdentityResolved(baseInput({ origin: { identityStatus: "failed" } })).passed, false, "a genuinely failed identity must fail");

  // REGRESSION (production, 2026-07-24): "not_required" simply means this notification has no
  // subject employee and needs none — recruitment notices, digests, etc. Scoring it as a failure
  // held every such send (both production held rows were exactly this: 3/4 checks, fan-out
  // PASSING, blocked only here). It must be not-applicable, never a hold.
  const notRequired = checkIdentityResolved(baseInput({ origin: { identityStatus: "not_required" } }));
  assert.equal(notRequired.passed, null, "not_required identity must be not-applicable, never a fail");
  assert.equal(
    computeDecision([
      { detail: "", name: "content_integrity", passed: true },
      { detail: "", name: "recipient_validity", passed: true },
      notRequired,
      { detail: "", name: "fanout_anomaly", passed: true },
    ]).decision,
    "auto_send",
    "a healthy send whose only non-pass is not_required identity must auto-send, not hold",
  );

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

  // computeRecipientVolumeCeiling: the check that catches what fanout_anomaly cannot — a SINGLE
  // send with an unusually large to+cc+bcc recipient count. fanoutToBcc collapses many recipients
  // into one email specifically so a burst reads as "one send" to fanout_anomaly; this is the
  // check that still catches that one send if its recipient list itself is abnormally large.

  // First-run (fewer than 5 prior sends on record): flat ceiling, capped at both an absolute
  // number and a fraction of headcount — identical shape to fanout_anomaly's own first-run
  // ceiling, so a newly-configured broad policy cannot silently reach most of the company on its
  // very first send.
  const firstRunSmallCompany = computeRecipientVolumeCeiling([], 20);
  assert.equal(firstRunSmallCompany.basis, "first_run");
  assert.equal(firstRunSmallCompany.ceiling, 5, "20 headcount * 25% = 5, below the absolute cap of 10");

  const firstRunBigCompany = computeRecipientVolumeCeiling([2, 3], 500);
  assert.equal(firstRunBigCompany.basis, "first_run", "fewer than 5 prior sends must still be first_run");
  assert.equal(firstRunBigCompany.ceiling, 10, "500 headcount * 25% = 125, clamped down to the absolute cap of 10");

  // THE actual worst-case shape this check exists for: a brand-new (module,eventType) pair whose
  // very first send already has hundreds of BCC'd recipients (a mis-scoped "all Medical Reps, all
  // lines" policy) must fail outright against the first-run ceiling.
  const massBccFirstSend = computeRecipientVolumeCeiling([], 115);
  assert.ok(300 > massBccFirstSend.ceiling, "a 300-recipient first send must exceed the first-run ceiling");

  // Established (5+ prior sends): judged against that pair's own historical per-send recipient
  // count, not a flat number — so a routinely-large distribution list (e.g. a company-wide
  // holiday announcement, ~100 recipients every time) never trips this once it has a track record.
  const establishedLargeList = computeRecipientVolumeCeiling([98, 102, 100, 101, 99], 115);
  assert.equal(establishedLargeList.basis, "established");
  assert.ok(
    establishedLargeList.ceiling >= 100,
    "an established ~100-recipient baseline must not itself get flagged as anomalous",
  );

  // But a genuine outlier against an established SMALL baseline must still be caught — this is
  // the exact incident shape: a notification that's always gone to 1-3 people suddenly reaching
  // hundreds.
  const establishedSmallList = computeRecipientVolumeCeiling([1, 2, 1, 3, 2], 115);
  assert.ok(
    establishedSmallList.ceiling < 50,
    "an established 1-3-recipient baseline must not tolerate a jump into the hundreds",
  );

  // sales/closing_published's known real recipient count (12, confirmed live 2026-08-08 on Anti
  // Infective's first publish notification: 5 District Managers + 6 fixed Cc + 1 Bcc) must clear
  // its own first-run override rather than the generic 10-recipient cap every other brand-new
  // (module,eventType) pair gets — that override is what checkRecipientVolume applies on top of
  // computeRecipientVolumeCeiling's own (unmodified) first-run result.
  assert.ok(
    FIRST_RUN_CEILING_OVERRIDES["sales/closing_published"] >= 12,
    "sales/closing_published's first-run override must cover its known real recipient count",
  );
  assert.ok(
    FIRST_RUN_CEILING_OVERRIDES["sales/closing_published"] > firstRunBigCompany.ceiling,
    "the override must actually raise the ceiling above the generic first-run cap it replaces",
  );
}
