import assert from "node:assert/strict";

import {
  countProposedCvFields,
  countUnappliedCvFields,
  normalizeStoredExtractionFields,
  seedReviewFieldsFromCandidate,
} from "../src/lib/recruitment/cv-extraction-fields.ts";
import { getCvPositionSchema } from "../src/lib/recruitment/cv-field-schemas.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

// `medical_rep` is now an ALIAS onto the ONE universal schema rather than a template of its own
// (cv-field-schemas.ts, 2026-08-14). This file deliberately keeps resolving it: 170 historical
// ats_candidate_cv_extractions rows are stamped with that key and their review-queue entries break
// the moment it stops resolving. Whatever it returns is the same 38-field list `universal` returns.
const medicalRep = getCvPositionSchema("medical_rep")!;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    address: null,
    appliedForEvidence: null,
    appliedForJobTitle: null,
    backgroundConfirmedAt: null,
    backgroundConfirmedByHrId: null,
    backgroundConfirmedOutcome: null,
    createdAt: "2026-07-31T00:00:00Z",
    createdBy: null,
    currentEmployer: null,
    currentJobTitle: null,
    currentRoleResponsibilities: null,
    cvExternalUrl: null,
    cvReferenceName: null,
    dateOfBirth: null,
    declaredBackground: null,
    declaredExpectedSalary: null,
    declaredExperience: null,
    degree: null,
    email: null,
    expectedSalary: null,
    faculty: null,
    // Not on the CV shelf — this fixture is about extraction, and a filed candidate is simply a
    // candidate with somewhere to wait. See candidate-folder.ts.
    folder: null,
    fullName: "Mazen Hassan",
    gender: null,
    governorate: null,
    grade: null,
    graduationYear: null,
    hasMedicalRepExperience: null,
    hasPriorWorkExperience: null,
    id: "candidate-1",
    linkedinUrl: null,
    managerNotified: null,
    maritalStatus: null,
    medicalRepEmployer: null,
    medicalRepExperienceFrom: null,
    medicalRepExperienceTo: null,
    militaryStatus: null,
    nationalId: null,
    nationality: null,
    noticePeriod: null,
    notes: null,
    phone: null,
    placeOfBirth: null,
    positionSpecificFields: {},
    preferencesDeclaredAt: null,
    preferredAreaName: null,
    preferredRegionCode: null,
    preferredRegionName: null,
    professionalSummary: null,
    screeningExtraAnswers: {},
    sentFor: null,
    source: "whatsapp",
    status: "Candidate Created",
    statusChangedAt: null,
    statusChangedByHrId: null,
    statusNote: null,
    university: null,
    updatedAt: "2026-07-31T00:00:00Z",
    whatsapp: null,
    yearsExperience: null,
    ...overrides,
  };
}

export function runRecruitmentCvExtractionFieldsTests() {
  // --- normalizeStoredExtractionFields (extracted_fields is jsonb: trust nothing) ------------
  assert.deepEqual(normalizeStoredExtractionFields(null), {}, "a row with no extraction yields no fields");
  assert.deepEqual(normalizeStoredExtractionFields("nonsense"), {});
  assert.deepEqual(normalizeStoredExtractionFields([{ value: "x" }]), {}, "an array is not a field map");

  const normalized = normalizeStoredExtractionFields({
    email: { confidence: "weird", value: "  a@b.com  " },
    fullName: { confidence: "high", value: "Mazen Hassan" },
    governorate: { confidence: "low", value: "   " },
    hasMedicalRepExperience: { confidence: "high", value: false },
    missingValueKey: { confidence: "high" },
    notAnObject: "Cairo",
    university: { confidence: "high", value: 42 },
  });
  assert.equal(normalized.fullName.value, "Mazen Hassan");
  assert.equal(normalized.email.value, "a@b.com", "surrounding whitespace is trimmed off the stored value");
  assert.equal(normalized.email.confidence, "low", "any confidence that isn't exactly \"high\" is treated as low");
  assert.equal(normalized.governorate.value, null, "a blank string is not a finding");
  assert.equal(normalized.hasMedicalRepExperience.value, false, "a boolean judgment survives normalization");
  // This used to pin `null` — "a value of the wrong type is dropped, not coerced" — because a number
  // in a string field could only be junk while the schema held nothing but strings and booleans.
  // Since 2026-08-14 numbers are a real field type (graduationYear, yearsExperience), so this pass
  // can no longer tell "wrong type" from "right type" at all: it does not read the schema, only the
  // runtime shape. Declared-type enforcement lives downstream instead, where the field DEFINITION is
  // in hand — cv-auto-apply.ts, selectPendingReviewFields and buildReviewBoardFields each drop a
  // number proposed into a string field, and candidateFieldValue reads per declared type.
  assert.equal(normalized.university.value, 42, "a number is a legal stored value now; the schema is what rejects it later");
  assert.equal("missingValueKey" in normalized, false, "an entry without a value key is skipped entirely");
  assert.equal("notAnObject" in normalized, false, "a bare string is not the {value, confidence} shape");

  // --- normalizeStoredExtractionFields: arrays and numbers must SURVIVE read-back ---------------
  // Until 2026-08-14 anything that was not a string or a boolean was flattened to null here. That
  // was harmless while the schema held only those two types, but the universal schema stores the
  // five repeating blocks as arrays and graduationYear/yearsExperience as numbers — and a value
  // dropped on read-back is indistinguishable, on screen, from a value the AI never found. So
  // reopening a stored extraction silently emptied every work history it had cost money to read.
  const widened = normalizeStoredExtractionFields({
    graduationYear: { confidence: "high", value: 2015 },
    languages: { confidence: "high", value: [] },
    skills: { confidence: "high", value: [{ name: "Selling skills" }, "not-an-entry", null, [{ nested: true }]] },
    workHistory: { confidence: "high", value: [{ employer: "Sanofi", jobTitle: "Medical Rep" }] },
    yearsExperience: { confidence: "high", value: Number.POSITIVE_INFINITY },
  });
  assert.deepEqual(
    widened.workHistory.value,
    [{ employer: "Sanofi", jobTitle: "Medical Rep" }],
    "a repeating block survives read-back intact",
  );
  assert.equal(widened.graduationYear.value, 2015, "a number survives read-back — it is neither a string nor nothing");
  assert.deepEqual(
    widened.skills.value,
    [{ name: "Selling skills" }],
    "non-object entries inside a block are dropped, not coerced — a bare string there means the row is malformed",
  );
  assert.equal(widened.languages.value, null, "an empty block is \"the CV listed none\", which is not a finding");
  assert.equal(
    widened.yearsExperience.value,
    null,
    "a non-finite number round-trips through jsonb as null anyway — reject it rather than let it reach a column",
  );

  // --- countProposedCvFields (drives the "N fields already read from this CV" prompt) --------
  assert.equal(countProposedCvFields({}), 0);
  assert.equal(
    countProposedCvFields({
      fullName: { confidence: "high", value: "Mazen Hassan" },
      governorate: { confidence: "low", value: null },
      hasMedicalRepExperience: { confidence: "high", value: false },
    }),
    2,
    "a boolean false IS a finding (\"no medical rep experience\"); only null/blank is uncounted",
  );

  // --- countUnappliedCvFields (what the banner/notification must report) ---------------------
  // Intake auto-applies the high-confidence findings (cv-auto-apply.ts) WITHOUT writing
  // applied_fields, so "nobody reviewed this row" stays true forever. Counting raw findings would
  // therefore nag on every inbound candidate with a number that overstates the remaining work.
  const proposal = {
    address: { confidence: "high", value: "El waha district, Nasr city" } as const,
    faculty: { confidence: "low", value: null } as const,
    fullName: { confidence: "high", value: "Mazen Hassan" } as const,
    governorate: { confidence: "high", value: "Cairo" } as const,
    hasMedicalRepExperience: { confidence: "low", value: false } as const,
    university: { confidence: "low", value: "Misr International University" } as const,
  };

  assert.equal(
    countUnappliedCvFields(proposal, candidate(), medicalRep),
    4,
    "an otherwise-empty record: address, governorate, university and the medical-rep judgment are " +
      "outstanding. faculty is null in the proposal so it never counts, and fullName is never a gap — " +
      "createCandidate requires a name, so every candidate already has one.",
  );

  assert.equal(
    countUnappliedCvFields(
      proposal,
      // What the record looks like AFTER intake auto-applied the high-confidence column fields.
      candidate({ address: "El waha district, Nasr city", fullName: "Mazen Hassan", governorate: "Cairo" }),
      medicalRep,
    ),
    2,
    "only the low-confidence leftovers auto-apply skipped still need a human",
  );

  assert.equal(
    countUnappliedCvFields(
      proposal,
      candidate({
        address: "El waha district, Nasr city",
        fullName: "Mazen Hassan",
        governorate: "Cairo",
        hasMedicalRepExperience: false,
        university: "Misr International University",
      }),
      medicalRep,
    ),
    0,
    "everything landed — the banner must disappear rather than nag forever",
  );

  assert.equal(
    countUnappliedCvFields(
      { hasPriorWorkExperience: { confidence: "high", value: true } },
      candidate({ hasPriorWorkExperience: false }),
      medicalRep,
    ),
    0,
    "a saved boolean false is an answer, not a gap — it must not be counted as outstanding",
  );

  // A repeating block is stored in positionSpecificFields, not in a column of its own, so the count
  // has to read it from there. If it did not, a candidate whose work history auto-apply had ALREADY
  // written would be reported as having it outstanding on every single visit and the banner would
  // never clear.
  const blockProposal = {
    skills: { confidence: "high" as const, value: [{ name: "Selling skills" }] },
    workHistory: { confidence: "high" as const, value: [{ employer: "Sanofi" }] },
  };
  assert.equal(
    countUnappliedCvFields(blockProposal, candidate(), medicalRep),
    2,
    "a candidate holding no blocks has both of the proposed ones outstanding",
  );
  assert.equal(
    countUnappliedCvFields(
      blockProposal,
      candidate({ positionSpecificFields: { workHistory: [{ employer: "Sanofi" }] } }),
      medicalRep,
    ),
    1,
    "a stored block is applied, not a gap — only the block the candidate still lacks is counted",
  );
  assert.equal(
    countUnappliedCvFields(
      blockProposal,
      candidate({ positionSpecificFields: { skills: [], workHistory: [{ employer: "Sanofi" }] } }),
      medicalRep,
    ),
    1,
    "an EMPTY stored block holds no entries, so it is still a gap",
  );

  // --- seedReviewFieldsFromCandidate ---------------------------------------------------------
  // The review board writes EVERY schema field on save, so an unseeded board would blank whatever
  // the CV didn't mention. This is the guard against that: it is why opening a stored extraction
  // cannot wipe a direct WhatsApp applicant's phone, which came from the sender, not the document.
  const seeded = seedReviewFieldsFromCandidate(
    {
      fullName: { confidence: "high", value: "Mazen M. Hassan" },
      phone: { confidence: "low", value: null },
      university: { confidence: "high", value: "MIU" },
    },
    candidate({ email: "sender@example.com", hasMedicalRepExperience: false, phone: "01234567890", university: "Old University" }),
    medicalRep,
  );
  assert.equal(seeded.phone.value, "01234567890", "an empty proposal falls back to what is already saved");
  assert.equal(seeded.phone.confidence, "high", "a value taken from the record is not an AI guess — no low-confidence badge");
  assert.equal(seeded.email.value, "sender@example.com", "a field the CV never mentioned is still seeded from the record");
  assert.equal(seeded.university.value, "MIU", "a real proposal wins over the saved value — that is the point of reviewing");
  assert.equal(seeded.fullName.value, "Mazen M. Hassan");
  assert.equal(
    seeded.hasMedicalRepExperience.value,
    false,
    "a saved boolean false is a real answer and must be seeded, not treated as missing",
  );
  assert.equal(seeded.governorate?.value ?? null, null, "a field empty in both the CV and the record stays empty");

  // A candidate with nothing saved leaves the proposal exactly as the AI produced it.
  const untouched = seedReviewFieldsFromCandidate(
    { governorate: { confidence: "low", value: "Cairo" } },
    candidate(),
    medicalRep,
  );
  assert.equal(untouched.governorate.value, "Cairo");
  assert.equal(untouched.governorate.confidence, "low", "seeding never rewrites a confidence the AI reported");
  assert.equal(untouched.fullName.value, "Mazen Hassan", "the candidate's own name seeds the name slot");

  // A repeating block gets the same protection as a column: the board writes every block it renders,
  // so a work history the CV in front of the reviewer happens not to mention must still be on the
  // board — otherwise saving the review blanks it.
  const seededBlocks = seedReviewFieldsFromCandidate(
    { workHistory: { confidence: "low", value: null } },
    candidate({ positionSpecificFields: { workHistory: [{ employer: "Sanofi" }] } }),
    medicalRep,
  );
  assert.deepEqual(seededBlocks.workHistory.value, [{ employer: "Sanofi" }], "a stored block seeds an empty proposal");
  assert.equal(seededBlocks.workHistory.confidence, "high", "a stored block is not an AI guess to check");
}
