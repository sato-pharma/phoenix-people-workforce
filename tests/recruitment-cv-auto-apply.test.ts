import assert from "node:assert/strict";

import { isBlankCandidateValue, selectAutoApplyFields } from "../src/lib/recruitment/cv-auto-apply.ts";

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
  // Re-applying identity could rewrite an EXISTING candidate that intake MATCHED rather than
  // created, silently repointing someone else's record and its dedupe norms.
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
    "identity fields are never auto-applied, even when the column is empty",
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
  // Blocks reach a candidate ONLY through here. cv-review-queue.ts skips non-column fields (its
  // gate 1), so a work history this function declines has no route to a human at all — it would sit
  // in extracted_fields forever, which is the exact "paid for and invisible" failure this module
  // exists to end.
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
