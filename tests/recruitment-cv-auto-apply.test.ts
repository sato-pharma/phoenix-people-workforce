import assert from "node:assert/strict";

import { isBlankCandidateValue, selectAutoApplyFields } from "../src/lib/recruitment/cv-auto-apply.ts";

const high = (value: string | boolean | null) => ({ confidence: "high" as const, value });
const low = (value: string | boolean | null) => ({ confidence: "low" as const, value });

// A candidate as it looks straight out of automated intake: identity written by createCandidate,
// every enrichment column still empty.
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

  // district_manager shares the Medical Rep field list, so the same rules apply there.
  assert.deepEqual(
    selectAutoApplyFields({
      candidate: freshCandidate(),
      extractedFields: { university: high("Cairo University") },
      positionKey: "district_manager",
    }),
    { university: "Cairo University" },
  );
}
