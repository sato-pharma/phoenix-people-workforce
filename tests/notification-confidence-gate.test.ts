import { strict as assert } from "node:assert";

import {
  audienceSizeFromReviewRow,
  checkContentIntegrity,
  checkIdentityResolved,
  checkRecipientValidity,
  computeDecision,
  computeRealAudienceSize,
  computeRecipientVolumeCeiling,
  CEILING_OVERRIDES,
  resolveCeilingOverride,
  HOLD_EXPIRY_EFFECTIVE_FROM,
  HOLD_EXPIRY_HOURS,
  isExemptFromVolumeChecks,
} from "../src/lib/notifications/confidence-gate.ts";

// The standing admin address (ADMIN_STANDING_EMAIL in admin-telegram-mirror.ts) — send-phoenix-email.ts
// BCC'd it onto every automated email until the owner stopped that on 2026-11-06, and a caller can
// still copy it explicitly, so the gate keeps never counting it. Pinned here on purpose: if it ever changes
// without computeRealAudienceSize learning about it, every single-recipient email starts counting
// as two and the transactional-mail exemption below silently stops applying.
const STANDING_ADMIN_BCC = "omar.anwar@satopharma.com";

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
      { detail: "", name: "recipient_volume", passed: true },
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
    { detail: "", name: "recipient_volume", passed: true },
  ]);
  assert.equal(allPass.decision, "auto_send", "all checks passing must auto-send");
  assert.equal(allPass.confidencePercent, 100, "all checks passing must be 100% confidence");

  const oneFails = computeDecision([
    { detail: "", name: "content_integrity", passed: true },
    { detail: "", name: "recipient_validity", passed: true },
    { detail: "", name: "recipient_volume", passed: false },
  ]);
  assert.equal(oneFails.decision, "hold", "one failing check (recipient_volume) must hold, even with two checks passing");
  assert.equal(oneFails.confidencePercent, 67, "confidence must reflect 2 of 3 applicable checks passing");

  const notApplicableIgnored = computeDecision([
    { detail: "", name: "content_integrity", passed: true },
    { detail: "", name: "identity_resolved", passed: null },
    { detail: "", name: "recipient_volume", passed: null },
  ]);
  assert.equal(notApplicableIgnored.decision, "auto_send", "not-applicable checks must never force a hold");
  assert.equal(notApplicableIgnored.confidencePercent, 100, "not-applicable checks must be excluded from the confidence percent");

  const allNotApplicable = computeDecision([
    { detail: "", name: "identity_resolved", passed: null },
    { detail: "", name: "recipient_volume", passed: null },
  ]);
  assert.equal(allNotApplicable.decision, "auto_send", "no applicable checks at all must default to auto_send");
  assert.equal(allNotApplicable.confidencePercent, 100, "no applicable checks at all must default to 100%");

  // computeRecipientVolumeCeiling: since the 2026-08-28 recalibration this is THE mass-send check,
  // judging a SINGLE send by how many real people it reaches. fanoutToBcc collapses many recipients
  // into one email, which is why the retired per-15-minute fan-out counter could never see a real
  // incident — this is the check that does.

  // First-run (fewer than 5 prior sends on record): flat ceiling, capped at both an absolute
  // number and a fraction of headcount, so a newly-configured broad policy cannot silently reach
  // most of the company on its very first send.
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
    CEILING_OVERRIDES["sales/closing_published"].ceiling >= 12,
    "sales/closing_published's first-run override must cover its known real recipient count",
  );
  assert.ok(
    CEILING_OVERRIDES["sales/closing_published"].ceiling > firstRunBigCompany.ceiling,
    "the override must actually raise the ceiling above the generic first-run cap it replaces",
  );

  // ── appliesTo: which overrides survive a pair becoming established ─────────────────────────
  // sales/closing_published is `always` since 2026-10-10: its audience DESIGN changed — from a line's
  // District Managers (about 12 recipients) to everyone seated on the line (about 34 people plus the Cc
  // roster) — so the baseline of the old shape describes behaviour that was just changed on purpose,
  // not an incident. Held for the first publish otherwise, which is the failure `always` exists for.
  assert.equal(
    resolveCeilingOverride("sales", "closing_published", "first_run"),
    60,
    "the whole-line audience must clear the first-run cap",
  );
  assert.equal(
    resolveCeilingOverride("sales", "closing_published", "established"),
    60,
    "an `always` override must survive the pair being established — its 12-recipient baseline is the shape that was replaced",
  );
  assert.ok(
    CEILING_OVERRIDES["sales/closing_published"].ceiling >= 34 + 12,
    "the ceiling must cover a whole line (34 seated people today) plus the Cc roster",
  );

  // market_awareness/market_awareness_decision_pending is the opposite case, and the reason
  // `appliesTo` exists. That notice went to exactly ONE person for its whole life; the owner's
  // 2026-09-28 rule made it copy the requester, his manager and every approver. Its established
  // baseline — measured live that day at ~1.1 (±0.3) over 7 prior sends, ceiling 3 — describes the
  // single-recipient bug that was just fixed, so it held 3 of the first 4 corrected notices at 67%
  // and the owner cleared them by hand within the minute. A baseline is evidence of what the code
  // USED TO DO; it is not evidence of an incident when the code deliberately changed.
  assert.equal(
    resolveCeilingOverride("market_awareness", "market_awareness_decision_pending", "established"),
    12,
    "an `always` override must survive the pair being established — that is the entire point of it",
  );
  assert.ok(
    resolveCeilingOverride("market_awareness", "market_awareness_decision_pending", "established")! >
      computeRecipientVolumeCeiling([1, 1, 1, 1, 1, 1, 2], 200).ceiling,
    "the override must clear the real production baseline (~1.1 over 7 sends) that held the refire",
  );

  // Nothing unlisted gains a floor. The gate's posture is no manual carve-outs; these are the
  // exceptions, and an override that leaked to every pair would silently disarm the volume check.
  assert.equal(
    resolveCeilingOverride("recruitment", "candidate_assigned", "first_run"),
    undefined,
    "a pair with no entry must get no override in either basis",
  );
  assert.equal(
    resolveCeilingOverride("recruitment", "candidate_assigned", "established"),
    undefined,
    "a pair with no entry must get no override in either basis",
  );

  // ── computeRealAudienceSize ────────────────────────────────────────────────────────────────
  // The honest count of REAL people a send reaches. It runs on the arrays the gate receives,
  // which are already rewritten twice: fanoutToBcc moves every recipient into BCC behind a
  // neutral reply-to placeholder, and (until 2026-11-06) the always-BCC block appended the standing admin. Counting
  // raw array lengths after that cannot tell a one-person email from a two-hundred-person one,
  // which is how 6 employees ended up behind undelivered password-reset links for 27 days.
  assert.equal(
    computeRealAudienceSize({ bcc: [STANDING_ADMIN_BCC], to: ["employee@satopharma.com"] }),
    1,
    "the standing admin, wherever it is copied, must never count as an audience member",
  );
  assert.equal(
    computeRealAudienceSize({ to: ["a@satopharma.com", "b@satopharma.com", "c@satopharma.com"] }),
    3,
    "three real recipients must count as three",
  );
  assert.equal(
    computeRealAudienceSize({ cc: ["A@Satopharma.com"], to: ["a@satopharma.com"] }),
    1,
    "the same person in To and Cc, differing only in case, is one person",
  );
  assert.equal(
    computeRealAudienceSize({ bcc: [null as unknown as string, "  "], to: ["a@satopharma.com"] }),
    1,
    "blank and null address slots must not inflate the audience",
  );

  // The reply-to placeholder fanoutToBcc leaves alone in To is not a recipient either. Set
  // explicitly rather than relying on the default, so the assertion holds whatever the
  // environment carries.
  const previousReplyTo = process.env.NOTIFICATION_REPLY_TO;
  process.env.NOTIFICATION_REPLY_TO = "care.phx@satopharma.com";
  try {
    assert.equal(
      computeRealAudienceSize({
        bcc: ["a@satopharma.com", "b@satopharma.com", STANDING_ADMIN_BCC],
        to: ["care.phx@satopharma.com"],
      }),
      2,
      "a fanned-out send must count its BCC'd recipients, not the reply-to placeholder or the standing admin",
    );
  } finally {
    if (previousReplyTo === undefined) delete process.env.NOTIFICATION_REPLY_TO;
    else process.env.NOTIFICATION_REPLY_TO = previousReplyTo;
  }

  // ── audienceSizeFromReviewRow ──────────────────────────────────────────────────────────────
  // REGRESSION (caught by CI typecheck, 2026-08-28): the stored row is snake_case while
  // computeRealAudienceSize takes to/cc/bcc. The first cut of this change passed the row straight
  // in — a TS2559 the local test run could not see, and which at runtime would have scored EVERY
  // historical row as 0 recipients, collapsing the baseline to zero and pinning the ceiling at its
  // floor of 3, so the gate would have held MORE mail, not less. The compiler now rejects the
  // un-mapped form; these pin that the mapping reads the RIGHT columns, since a wrong-but-
  // well-typed mapping would still compile.
  assert.equal(
    audienceSizeFromReviewRow({
      bcc_addresses: ["b@satopharma.com", STANDING_ADMIN_BCC],
      cc_addresses: ["c@satopharma.com"],
      to_addresses: ["a@satopharma.com"],
    }),
    3,
    "a stored review row must yield its real audience — all three address columns read, standing admin stripped",
  );
  assert.equal(
    audienceSizeFromReviewRow({ bcc_addresses: null, cc_addresses: null, to_addresses: ["a@satopharma.com"] }),
    1,
    "null address columns must not throw or inflate",
  );
  assert.notEqual(
    audienceSizeFromReviewRow({
      bcc_addresses: ["b@satopharma.com"],
      cc_addresses: null,
      to_addresses: ["a@satopharma.com"],
    }),
    0,
    "a populated row must never score 0 — a zero baseline silently makes the gate hold more, not less",
  );

  // ── isExemptFromVolumeChecks ───────────────────────────────────────────────────────────────
  // REGRESSION (production, measured 2026-08-28): 679 held rows, ZERO ever discarded as wrong,
  // while 4 password resets and 2 account-setup links sat undelivered for 27 days. One person
  // cannot be a mass-send incident, so a single-recipient send must never be held on volume.
  assert.equal(
    isExemptFromVolumeChecks({ bcc: [STANDING_ADMIN_BCC], to: ["locked.out@satopharma.com"] }),
    true,
    "a password-reset shaped send (one recipient + the standing admin BCC) must be exempt from volume checks",
  );
  assert.equal(
    isExemptFromVolumeChecks({ to: ["a@satopharma.com", "b@satopharma.com"] }),
    false,
    "two real recipients must still be judged on volume",
  );
  assert.equal(
    isExemptFromVolumeChecks({ audienceSize: 200, to: ["phoenix@satopharma.com"] }),
    false,
    "a caller-supplied audience size must win over the derived one — a 200-person fan-out is never exempt",
  );

  // The exemption must not swallow the checks that CAN judge one recipient. A single-recipient
  // email with a broken template is still broken.
  assert.equal(
    checkContentIntegrity(baseInput({ html: "<p>Hi {{employeeName}}</p>" })).passed,
    false,
    "content_integrity must still fail a single-recipient send with an unresolved token",
  );
  assert.equal(
    checkRecipientValidity(baseInput({ to: ["not-an-email"] })).passed,
    false,
    "recipient_validity must still fail a single-recipient send with a malformed address",
  );

  // ── the hold deadline ──────────────────────────────────────────────────────────────────────
  // A hold is only a safety mechanism if it reaches a decision. The daily reminder fired for 27
  // consecutive days while the oldest hold reached 35 days, so the deadline must be far shorter
  // than that and must actually be a positive number of hours.
  assert.ok(Number.isFinite(HOLD_EXPIRY_HOURS) && HOLD_EXPIRY_HOURS > 0, "the hold deadline must be a positive number of hours");
  assert.ok(HOLD_EXPIRY_HOURS <= 72, "a hold deadline beyond 3 days recreates the silent-non-delivery failure it exists to end");
  assert.ok(
    Number.isFinite(Date.parse(HOLD_EXPIRY_EFFECTIVE_FROM)),
    "the backlog cutoff must be a parseable instant — an unparseable one makes the expiry sweep's lower bound meaningless",
  );
}
