import assert from "node:assert/strict";

import {
  OFFER_REFERENCE_FALLBACK_CODE,
  OFFER_REFERENCE_PREFIX,
  buildOfferReference,
  nextOfferReference,
  offerTitleCode,
  parseOfferReference,
} from "@/lib/offers/reference";

export function runOfferReferenceTests() {
  // ── The headline: a generated reference must never repeat one already on file ──
  //
  // The reference is how a signed letter is found again months later. Two offers sharing a number
  // makes that impossible, and nothing on either letter shows anything is wrong.
  const onFile = [
    "SP-HR-DSM-2026-001",
    "SP-HR-DSM-2026-002",
    "SP-HR-DSM-2026-019",
    "SP-HR-NSM-2026-004",
    "SP-HR-DSM-2025-041",
  ];
  const allocated = nextOfferReference("District Sales Manager", 2026, onFile);
  assert.equal(
    allocated,
    "SP-HR-DSM-2026-020",
    "the next reference must continue past the HIGHEST number already used for that title and year",
  );
  assert.ok(
    !onFile.includes(allocated),
    `${allocated} is already on file — a generated reference must never collide with an existing one`,
  );

  // ── It counts past the highest, not into the first gap ──
  //
  // A gap is evidence: an offer was withdrawn, or a draft deleted. Filling it silently gives two
  // different letters the same number in anyone's records.
  assert.equal(
    nextOfferReference("District Sales Manager", 2026, ["SP-HR-DSM-2026-001", "SP-HR-DSM-2026-009"]),
    "SP-HR-DSM-2026-010",
    "a gap in the run is evidence of a withdrawn offer and must not be reused",
  );

  // ── Each title and each year counts on its own ──
  assert.equal(
    nextOfferReference("National Sales Manager", 2026, onFile),
    "SP-HR-NSM-2026-005",
    "NSM must continue its own run, not inherit DSM's numbering",
  );
  assert.equal(
    nextOfferReference("District Sales Manager", 2027, onFile),
    "SP-HR-DSM-2027-001",
    "a new year restarts the run at one",
  );
  assert.equal(
    nextOfferReference("Medical Representative", 2026, onFile),
    "SP-HR-MR-2026-001",
    "a title with nothing on file starts at one",
  );

  // ── Anything that is not one of our references must be ignored, not counted ──
  //
  // One hand-typed entry in another shape would otherwise move the whole run.
  assert.equal(
    nextOfferReference("District Sales Manager", 2026, [
      "SP-HR-DSM-2026-003",
      "",
      "handwritten note",
      "DSM/2026/99",
      "SP-HR-DSM-26-500",
      "SPHR-DSM-2026-777",
    ]),
    "SP-HR-DSM-2026-004",
    "only references in our own shape may influence the next number",
  );

  // ── The abbreviation in the middle has to mean something ──
  assert.equal(offerTitleCode("District Sales Manager"), "DSM");
  assert.equal(offerTitleCode("National Sales Manager"), "NSM");
  assert.equal(offerTitleCode("Medical Representative"), "MR");
  assert.equal(offerTitleCode("Head of Talent Acquisition"), "HTA", "'of' carries no identity in a title");
  assert.equal(offerTitleCode("Accountant"), "ACC", "one word has no initials, so the first three letters");
  assert.equal(offerTitleCode("  medical   representative  "), "MR", "spacing and case are not meaning");
  assert.equal(offerTitleCode("Medical Rep 2"), "MR2", "a digit distinguishes a title and must survive");
  assert.equal(
    offerTitleCode("Senior Medical Sales Representative Trainee"),
    "SMSR",
    "an abbreviation stops being one past four letters",
  );
  assert.equal(offerTitleCode(""), OFFER_REFERENCE_FALLBACK_CODE, "a reference must never carry a hole");
  assert.equal(offerTitleCode("   "), OFFER_REFERENCE_FALLBACK_CODE);
  assert.equal(offerTitleCode("of the and"), OFFER_REFERENCE_FALLBACK_CODE, "a title of only filler words");

  // ── Assembling and reading back ──
  assert.equal(buildOfferReference({ code: "DSM", sequence: 19, year: 2026 }), "SP-HR-DSM-2026-019");
  assert.equal(
    buildOfferReference({ code: "DSM", sequence: 7, year: 2026 }),
    "SP-HR-DSM-2026-007",
    "a sequence is padded to three digits so references sort as text",
  );
  assert.equal(
    buildOfferReference({ code: "DSM", sequence: 1234, year: 2026 }),
    "SP-HR-DSM-2026-1234",
    "past 999 the sequence grows rather than wrapping",
  );

  assert.deepEqual(parseOfferReference("SP-HR-DSM-2026-019"), { code: "DSM", sequence: 19, year: 2026 });
  assert.deepEqual(
    parseOfferReference("  sp-hr-dsm-2026-019  "),
    { code: "DSM", sequence: 19, year: 2026 },
    "a reference typed in lower case is still the same reference",
  );
  for (const bad of ["", "SP-HR-DSM-2026", "SP-HR-2026-019", "XX-HR-DSM-2026-019", "SP-HR-DSM-26-019"]) {
    assert.equal(parseOfferReference(bad), null, `"${bad}" is not one of our references`);
  }

  // Every reference we build must be readable by our own parser — otherwise the next allocation
  // would ignore the one just written and hand out the same number again.
  for (const title of ["District Sales Manager", "Accountant", "", "Medical Rep 2"]) {
    const reference = nextOfferReference(title, 2026, []);
    assert.ok(
      parseOfferReference(reference),
      `${reference} was generated but cannot be parsed back — the next allocation would not see it`,
    );
    assert.ok(reference.startsWith(`${OFFER_REFERENCE_PREFIX}-`), "every reference carries the company prefix");
  }
}
