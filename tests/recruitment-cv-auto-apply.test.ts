import assert from "node:assert/strict";

import {
  isBlankCandidateValue,
  isSingleDiallablePhone,
  selectAutoApplyFields,
} from "../src/lib/recruitment/cv-auto-apply.ts";

// Every value the universal schema can propose: scalars, a number (graduationYear,
// yearsExperience) and a repeating block (workHistory and its four siblings).
type ProposedValue = string | boolean | number | Array<Record<string, unknown>> | null;
const high = (value: ProposedValue) => ({ confidence: "high" as const, value });
const low = (value: ProposedValue) => ({ confidence: "low" as const, value });

// A candidate as it looks straight out of automated intake: identity written by createCandidate,
// every enrichment column still empty and no repeating block stored yet.
function freshCandidate(overrides: Record<string, unknown> = {}) {
  return {
    email: "mazen@example.com",
    faculty: null,
    fullName: "Mazen Mohmed",
    governorate: null,
    hasMedicalRepExperience: null,
    hasPriorWorkExperience: null,
    medicalRepEmployer: null,
    medicalRepExperienceFrom: null,
    medicalRepExperienceTo: null,
    phone: "01016585527",
    positionSpecificFields: {},
    university: null,
    ...overrides,
  };
}

export function runRecruitmentCvAutoApplyTests() {
  // --- isBlankCandidateValue ---------------------------------------------------------------------
  assert.equal(isBlankCandidateValue(null), true);
  assert.equal(isBlankCandidateValue(undefined), true);
  assert.equal(isBlankCandidateValue(""), true);
  assert.equal(isBlankCandidateValue("   "), true, "whitespace is not a real value");
  assert.equal(isBlankCandidateValue("Cairo"), false);
  // `false` is a deliberate answer ("no prior work experience"), not an absence. Treating it as
  // blank would let a later extraction silently flip a recorded "no" into a "yes".
  assert.equal(isBlankCandidateValue(false), false, "a recorded false must never look fillable");
  assert.equal(isBlankCandidateValue(true), false);

  // --- The happy path: high-confidence enrichment lands ------------------------------------------
  const applied = selectAutoApplyFields({
    candidate: freshCandidate(),
    extractedFields: {
      faculty: high("Faculty of Pharmacy"),
      governorate: high("Cairo"),
      hasPriorWorkExperience: high(true),
      university: high("Cairo University"),
    },
    positionKey: "medical_rep",
  });
  assert.deepEqual(applied, {
    faculty: "Faculty of Pharmacy",
    governorate: "Cairo",
    hasPriorWorkExperience: true,
    university: "Cairo University",
  });

  // --- Gate 1: low confidence always waits for a human -------------------------------------------
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { governorate: low("Cairo"), university: low("Cairo University") },
      positionKey: "medical_rep",
    }),
    {},
    "the AI's own hedge is respected — nothing low-confidence is written unattended",
  );

  // --- Gate 3: identity is createCandidate's alone -----------------------------------------------
  // Re-applying name or email could rewrite an EXISTING candidate that intake MATCHED rather than
  // created, silently repointing someone else's record and its dedupe norms. No flag ever unlocks
  // those two.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ email: null, phone: null }),
      extractedFields: {
        email: high("someone.else@example.com"),
        fullName: high("Someone Else"),
        phone: high("01000000000"),
      },
      positionKey: "medical_rep",
    }),
    {},
    "on a MATCHED candidate no identity field is auto-applied, even when the column is empty",
  );
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ email: null, phone: null }),
      candidateWasCreatedByThisIntake: true,
      extractedFields: {
        email: high("someone.else@example.com"),
        fullName: high("Someone Else"),
      },
      positionKey: "medical_rep",
    }),
    {},
    "fullName and email stay locked even when this intake created the candidate",
  );

  // --- Phone: the one identity field a CREATED candidate may have filled -------------------------
  // Email intake takes identity from the SENDER, and a sender's address carries no phone — so an
  // emailed CV creates a candidate with phone NULL while the AI reads the real mobile off the CV.
  // Measured in production 2026-08-15: 134 of 172 extracted candidates showed a blank phone the AI
  // had in fact read (113 at high confidence). Nobody could ring any of them.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: null }),
      candidateWasCreatedByThisIntake: true,
      extractedFields: { phone: high("01000000000") },
      positionKey: "medical_rep",
    }),
    { phone: "01000000000" },
    "a high-confidence phone fills the blank phone of a candidate THIS intake created",
  );

  // The created-only gate is the whole safety story: on a match, the record's identity was resolved
  // by a DIFFERENT CV, so writing this CV's phone could repoint someone else's row (and its
  // phone_norm, which carries a partial UNIQUE index).
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: null }),
      extractedFields: { phone: high("01000000000") },
      positionKey: "medical_rep",
    }),
    {},
    "a MATCHED candidate's blank phone still waits for a human",
  );
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: null }),
      candidateWasCreatedByThisIntake: false,
      extractedFields: { phone: high("01000000000") },
      positionKey: "medical_rep",
    }),
    {},
    "the flag defaults closed — an explicit false behaves exactly like an absent one",
  );

  // The other three gates still apply on top of the created-only one.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: null }),
      candidateWasCreatedByThisIntake: true,
      extractedFields: { phone: low("01000000000") },
      positionKey: "medical_rep",
    }),
    {},
    "a low-confidence phone waits for a human even on a created candidate",
  );
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: "01016585527" }),
      candidateWasCreatedByThisIntake: true,
      extractedFields: { phone: high("01000000000") },
      positionKey: "medical_rep",
    }),
    {},
    "a phone already on the record is never overwritten — this only ever fills a gap",
  );

  // --- Gate 5: a phone column takes ONE diallable number -----------------------------------------
  // The confidence gate cannot catch this class. A CV whose contact line reads
  // "01060464699 & 01112872565" yields a HIGH-confidence extraction — the AI is not wrong, it read
  // the page correctly. What comes back is still a 22-digit string that nobody can ring, and
  // phone_norm's partial UNIQUE index would then carry it, so a later genuine application from
  // either real number fails to match. Every rejected string below is verbatim from production
  // 2026-08-16, where 8 of 42 high-confidence phones were two or three numbers run together.
  assert.equal(isSingleDiallablePhone("01097000634"), true, "an 11-digit Egyptian mobile");
  assert.equal(isSingleDiallablePhone("+20 100 163 9245"), true, "12 digits with a country code");
  assert.equal(isSingleDiallablePhone("0201095986162"), true, "13 digits");
  assert.equal(isSingleDiallablePhone("00201023232472"), true, "14 digits is legitimate in 0020 form");
  assert.equal(isSingleDiallablePhone("(002) 01149858428"), true, "punctuation and spaces are not digits");
  assert.equal(isSingleDiallablePhone("01060464699 & 01112872565"), false, "two numbers run together");
  assert.equal(isSingleDiallablePhone("01221983536 - 01553620677"), false, "a dash does not make it one number");
  assert.equal(isSingleDiallablePhone("+201115551864 / +201211717808"), false, "two international numbers");
  assert.equal(isSingleDiallablePhone("+91-7002466900/9085277771/7002031980"), false, "three numbers, 32 digits");
  assert.equal(isSingleDiallablePhone("12345678901234"), false, "14 digits that are NOT the 0020 form");
  assert.equal(isSingleDiallablePhone("0123456"), false, "too short to be a phone number");
  assert.equal(isSingleDiallablePhone(""), false);
  assert.equal(isSingleDiallablePhone(null), false);
  assert.equal(isSingleDiallablePhone(1016585527), false, "a number is not a phone string");

  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: null }),
      candidateWasCreatedByThisIntake: true,
      extractedFields: { phone: high("01060464699 & 01112872565") },
      positionKey: "medical_rep",
    }),
    {},
    "a high-confidence two-number string is REFUSED even on a candidate this intake created",
  );
  // The rest of the CV must still land. A junk phone is one bad field, not a reason to throw away
  // the university and the governorate the AI read correctly off the same page.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: null }),
      candidateWasCreatedByThisIntake: true,
      extractedFields: {
        governorate: high("Cairo"),
        phone: high("+91-7002466900/9085277771/7002031980"),
        university: high("Cairo University"),
      },
      positionKey: "medical_rep",
    }),
    { governorate: "Cairo", university: "Cairo University" },
    "refusing the phone must not cost the other high-confidence fields on the same CV",
  );
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ phone: null }),
      candidateWasCreatedByThisIntake: true,
      extractedFields: { phone: high("00201023232472") },
      positionKey: "medical_rep",
    }),
    { phone: "00201023232472" },
    "a single number in 0020 form is still written — the gate rejects junk, not foreign formats",
  );

  // --- Gate 4: fill gaps, never overwrite --------------------------------------------------------
  const wontOverwrite = selectAutoApplyFields({
    candidate: freshCandidate({ governorate: "Giza", university: "Ain Shams University" }),
    extractedFields: { faculty: high("Faculty of Pharmacy"), governorate: high("Cairo"), university: high("Cairo University") },
    positionKey: "medical_rep",
  });
  assert.deepEqual(
    wontOverwrite,
    { faculty: "Faculty of Pharmacy" },
    "an existing human/earlier value always wins; only the still-empty column is filled",
  );

  // A recorded `false` is a value, so a later "yes" must not overwrite it.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ hasPriorWorkExperience: false }),
      extractedFields: { hasPriorWorkExperience: high(true) },
      positionKey: "medical_rep",
    }),
    {},
    "a recorded false is not a gap",
  );

  // --- Empty / null proposals are dropped --------------------------------------------------------
  // This is also what disposes of the schema's showWhen dependents for free: the extraction
  // instructions require medicalRepEmployer and the experience dates to be null unless
  // hasMedicalRepExperience is true, so a dependent with nothing to say never arrives here.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: {
        governorate: high(""),
        medicalRepEmployer: high(null),
        medicalRepExperienceFrom: high("   "),
        university: high(null),
      },
      positionKey: "medical_rep",
    }),
    {},
    "null and empty proposals are not values",
  );

  // Values are trimmed on the way in, so a stray-whitespace proposal cannot land untidy.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { governorate: high("  Cairo  ") },
      positionKey: "medical_rep",
    }),
    { governorate: "Cairo" },
  );

  // --- Declared type is enforced against the runtime value ---------------------------------------
  // A malformed model response must not put a string into a boolean column, or vice versa.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: {
        governorate: high(true as unknown as string),
        hasPriorWorkExperience: high("yes" as unknown as boolean),
      },
      positionKey: "medical_rep",
    }),
    {},
    "type mismatches are dropped rather than written",
  );

  // A number field takes a number and nothing else. graduationYear and yearsExperience are
  // `type: "number"` in the universal schema, and a model that answers "2015" as text must not put
  // a string into a numeric column.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { graduationYear: high(2015) },
      positionKey: "medical_rep",
    }),
    { graduationYear: 2015 },
    "a real number lands in a number column",
  );
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { graduationYear: high("2015" as unknown as number), yearsExperience: high("five" as unknown as number) },
      positionKey: "medical_rep",
    }),
    {},
    "a numeric-looking string is not a number — dropped, never coerced",
  );

  // --- Repeating blocks: the jsonb branch of gate 2 ----------------------------------------------
  // Blocks reach a candidate ONLY through here — this function is the sole writer of a non-column
  // field. A work history it declines sits in extracted_fields forever, which is the exact "paid
  // for and invisible" failure this module exists to end.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { workHistory: high([{ employer: "Sanofi", jobTitle: "Medical Rep" }]) },
      positionKey: "medical_rep",
    }),
    { positionSpecificFields: { workHistory: [{ employer: "Sanofi", jobTitle: "Medical Rep" }] } },
    "a block the candidate does not hold yet is written into position_specific_fields",
  );

  // Gate 1 is scalar-only. A block carries no meaningful confidence — an employer row either came
  // off the CV or it did not — so hedging on it would strand most work histories permanently.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { languages: low([{ language: "English", level: "Fluent" }]) },
      positionKey: "medical_rep",
    }),
    { positionSpecificFields: { languages: [{ language: "English", level: "Fluent" }] } },
    "a low-confidence block is still applied — the confidence gate does not reach blocks",
  );

  // Gate 4 at BLOCK granularity: a history a human has edited is never re-extracted over.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ positionSpecificFields: { workHistory: [{ employer: "Corrected by a human" }] } }),
      extractedFields: { workHistory: high([{ employer: "Sanofi" }]) },
      positionKey: "medical_rep",
    }),
    {},
    "a candidate already holding entries under that key keeps them",
  );

  // An empty array is "the CV listed none" — nothing to write, and writing it would make the block
  // look answered and block the next extraction that does find something.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { skills: high([]) },
      positionKey: "medical_rep",
    }),
    {},
    "an empty block is not a finding",
  );

  // All five blocks share ONE jsonb column, so the write has to carry the ones this extraction says
  // nothing about — otherwise applying a work history would clear the skills.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate({ positionSpecificFields: { skills: [{ name: "Selling skills" }] } }),
      extractedFields: { workHistory: high([{ employer: "Sanofi" }]) },
      positionKey: "medical_rep",
    }),
    {
      positionSpecificFields: {
        skills: [{ name: "Selling skills" }],
        workHistory: [{ employer: "Sanofi" }],
      },
    },
    "a new block merges over the stored ones rather than replacing the whole column",
  );

  // --- Unknown position / missing extraction -----------------------------------------------------
  assert.deepEqual(
    selectAutoApplyFields({ candidate: freshCandidate(), extractedFields: { governorate: high("Cairo") }, positionKey: "not_a_position" }),
    {},
    "an unrecognised position has no schema, so nothing is safe to apply",
  );
  assert.deepEqual(
    selectAutoApplyFields({ candidate: freshCandidate(), extractedFields: null, positionKey: "medical_rep" }),
    {},
    "no extraction -> nothing to do",
  );

  // --- A field the AI never mentioned is left alone ----------------------------------------------
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { governorate: high("Cairo") },
      positionKey: "medical_rep",
    }),
    { governorate: "Cairo" },
    "only what the AI actually proposed is considered",
  );

  // --- Position keys: one schema, three names ----------------------------------------------------
  // This used to pin "district_manager shares the Medical Rep field list". Since 2026-08-14 there is
  // no Medical Rep field list: both legacy keys are ALIASES onto the single universal schema, kept
  // only so the historical extraction rows stamped with them keep resolving. What must hold now is
  // that all three keys behave identically — a legacy row and a new one apply the same rules.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { university: high("Cairo University") },
      positionKey: "district_manager",
    }),
    { university: "Cairo University" },
  );
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { university: high("Cairo University") },
      positionKey: "universal",
    }),
    { university: "Cairo University" },
    "the key every NEW extraction is stamped with resolves too",
  );
}
