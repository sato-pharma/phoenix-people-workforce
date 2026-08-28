import assert from "node:assert/strict";

import {
  bulkAcceptableProposal,
  isEmptyContactProposal,
  isSingleEmailAddress,
  proposeContactDetails,
} from "../src/lib/recruitment/contact-review.ts";

const high = (value: string | null) => ({ confidence: "high" as const, value });
const low = (value: string | null) => ({ confidence: "low" as const, value });

// A candidate as the 18 Aug 2026 bulk WhatsApp forward left them: intake took identity from the
// FORWARDER, so the applicant's own columns are blank while their CV holds the real details.
function forwardedCandidate(overrides: Record<string, unknown> = {}) {
  return { email: null, phone: null, ...overrides };
}

export function runRecruitmentContactReviewTests() {
  // --- isSingleEmailAddress ----------------------------------------------------------------------
  assert.equal(isSingleEmailAddress("ahmed.hassan@gmail.com"), true);
  assert.equal(isSingleEmailAddress("  ahmed@yahoo.co.uk  "), true, "surrounding space is trimmed");
  assert.equal(isSingleEmailAddress("a@b.com"), true);
  assert.equal(isSingleEmailAddress(null), false);
  assert.equal(isSingleEmailAddress(""), false);
  assert.equal(isSingleEmailAddress("not-an-email"), false, "no @ at all");
  assert.equal(isSingleEmailAddress("ahmed@localhost"), false, "a domain with no TLD");
  assert.equal(isSingleEmailAddress("@gmail.com"), false, "no local part");
  assert.equal(isSingleEmailAddress("ahmed@"), false, "no domain");
  assert.equal(isSingleEmailAddress("a@b@c.com"), false, "two @ signs");
  // The whole reason this gate exists: a CV contact line listing two addresses is transcribed
  // faithfully, at HIGH confidence, and would go into the email_norm UNIQUE index as one junk key.
  assert.equal(
    isSingleEmailAddress("ahmed@gmail.com / ahmed.work@yahoo.com"),
    false,
    "two addresses run together must never reach the dedupe index",
  );
  assert.equal(isSingleEmailAddress("ahmed@gmail.com, b@c.com"), false, "comma-separated pair");
  assert.equal(isSingleEmailAddress("Ahmed Hassan <ahmed@gmail.com>"), false, "a display name glued on");
  assert.equal(isSingleEmailAddress("ahmed@gmail.com;b@c.com"), false, "semicolon-separated pair");
  // These four are the separator guard's OWN work. Every case above is also caught by the @-count
  // or the domain shape, so without them that guard can be deleted and this file still passes —
  // confirmed by breaking it on 2026-08-21. A whitespace-split local part is the realistic one: a
  // CV that prints "ahmed hassan@gmail.com" has exactly one @ and a perfectly good domain.
  assert.equal(isSingleEmailAddress("ahmed hassan@gmail.com"), false, "a space inside the local part");
  assert.equal(isSingleEmailAddress("ahmed@gmail.com (personal)"), false, "a parenthesised label glued on");
  assert.equal(isSingleEmailAddress("ahmed\t@gmail.com"), false, "a tab inside the address");
  assert.equal(isSingleEmailAddress("ahmed@gmail.com\nmobile"), false, "the next CV line glued on");

  // --- proposeContactDetails: the happy path -----------------------------------------------------
  const both = proposeContactDetails({
    candidate: forwardedCandidate(),
    fields: { email: high("mazen@example.com"), phone: high("01234567890") },
    isCv: true,
  });
  assert.deepEqual(both.email, { confidence: "high", value: "mazen@example.com" });
  assert.deepEqual(both.phone, { confidence: "high", value: "01234567890" });
  assert.equal(isEmptyContactProposal(both), false);

  // --- gate 1: an explicit not-a-CV proposes nothing ---------------------------------------------
  // A vendor's price quote, a clinic letterhead and a training certificate all carry a name and a
  // phone number. None of them is an applicant's.
  const notACv = proposeContactDetails({
    candidate: forwardedCandidate(),
    fields: { email: high("sales@daftra.com"), phone: high("01234567890") },
    isCv: false,
  });
  assert.equal(isEmptyContactProposal(notACv), true, "is_cv === false proposes nothing at all");

  // NULL is NOT a verdict — every row written before 2026-08-21 has one, as does every ongoing
  // rules-only or OCR read. Failing closed on those would discard real applicants.
  const unjudged = proposeContactDetails({
    candidate: forwardedCandidate(),
    fields: { email: high("mazen@example.com"), phone: high("01234567890") },
    isCv: null,
  });
  assert.equal(unjudged.email?.value, "mazen@example.com", "an unjudged read is still proposed");
  assert.equal(unjudged.phone?.value, "01234567890");

  // --- gate 2: only ever fills a BLANK column ----------------------------------------------------
  const alreadyHasEmail = proposeContactDetails({
    candidate: forwardedCandidate({ email: "typed.by.a.human@satopharma.com" }),
    fields: { email: high("cv@example.com"), phone: high("01234567890") },
    isCv: true,
  });
  assert.equal(alreadyHasEmail.email, null, "a stored email is never overwritten by a proposal");
  assert.equal(alreadyHasEmail.phone?.value, "01234567890", "the blank column is still offered");

  const whitespaceCountsAsBlank = proposeContactDetails({
    candidate: forwardedCandidate({ phone: "   " }),
    fields: { phone: high("01234567890") },
    isCv: true,
  });
  assert.equal(whitespaceCountsAsBlank.phone?.value, "01234567890", "whitespace is not a real value");

  // --- gate 3: the value must be ONE address / ONE diallable number ------------------------------
  const runTogether = proposeContactDetails({
    candidate: forwardedCandidate(),
    fields: {
      email: high("ahmed@gmail.com / ahmed2@yahoo.com"),
      phone: high("01234567890 & 01098765432"),
    },
    isCv: true,
  });
  assert.equal(isEmptyContactProposal(runTogether), true, "neither junk value is proposed");

  // --- empty / missing / wrongly-typed fields ----------------------------------------------------
  assert.equal(
    isEmptyContactProposal(proposeContactDetails({ candidate: forwardedCandidate(), fields: {}, isCv: true })),
    true,
    "an extraction with no contact fields proposes nothing",
  );
  assert.equal(
    isEmptyContactProposal(
      proposeContactDetails({ candidate: forwardedCandidate(), fields: null, isCv: true }),
    ),
    true,
    "no extraction at all proposes nothing",
  );
  assert.equal(
    isEmptyContactProposal(
      proposeContactDetails({
        candidate: forwardedCandidate(),
        fields: { email: high(null), phone: high("") },
        isCv: true,
      }),
    ),
    true,
    "null and empty-string readings are not values",
  );

  // --- confidence is carried, not gated on -------------------------------------------------------
  // A human is the gate on this path, so a low-confidence read is still worth showing to someone
  // who can open the CV. It is bulk acceptance that restricts itself, below.
  const lowRead = proposeContactDetails({
    candidate: forwardedCandidate(),
    fields: { email: low("maybe@example.com"), phone: low("01234567890") },
    isCv: true,
  });
  assert.deepEqual(lowRead.email, { confidence: "low", value: "maybe@example.com" });
  assert.deepEqual(lowRead.phone, { confidence: "low", value: "01234567890" });

  // --- bulkAcceptableProposal --------------------------------------------------------------------
  assert.equal(
    isEmptyContactProposal(bulkAcceptableProposal(lowRead)),
    true,
    "accept-all never writes a low-confidence reading",
  );
  const mixed = proposeContactDetails({
    candidate: forwardedCandidate(),
    fields: { email: low("maybe@example.com"), phone: high("01234567890") },
    isCv: true,
  });
  const bulk = bulkAcceptableProposal(mixed);
  assert.equal(bulk.email, null, "the low half is left for a human");
  assert.deepEqual(bulk.phone, { confidence: "high", value: "01234567890" }, "the high half still goes");
  assert.deepEqual(bulkAcceptableProposal(both), both, "an all-high proposal passes through whole");
}
