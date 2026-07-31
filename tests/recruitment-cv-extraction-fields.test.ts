import assert from "node:assert/strict";

import {
  countProposedCvFields,
  countUnappliedCvFields,
  normalizeStoredExtractionFields,
  seedReviewFieldsFromCandidate,
} from "../src/lib/recruitment/cv-extraction-fields.ts";
import { getCvPositionSchema } from "../src/lib/recruitment/cv-field-schemas.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";

const medicalRep = getCvPositionSchema("medical_rep")!;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    address: null,
    createdAt: "2026-07-31T00:00:00Z",
    createdBy: null,
    currentEmployer: null,
    cvExternalUrl: null,
    cvReferenceName: null,
    email: null,
    expectedSalary: null,
    faculty: null,
    fullName: "Mazen Hassan",
    governorate: null,
    hasMedicalRepExperience: null,
    hasPriorWorkExperience: null,
    id: "candidate-1",
    medicalRepEmployer: null,
    medicalRepExperienceFrom: null,
    medicalRepExperienceTo: null,
    nationalId: null,
    noticePeriod: null,
    notes: null,
    phone: null,
    positionSpecificFields: {},
    source: "whatsapp",
    status: "Candidate Created",
    university: null,
    updatedAt: "2026-07-31T00:00:00Z",
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
  assert.equal(normalized.university.value, null, "a value of the wrong type is dropped, not coerced");
  assert.equal("missingValueKey" in normalized, false, "an entry without a value key is skipped entirely");
  assert.equal("notAnObject" in normalized, false, "a bare string is not the {value, confidence} shape");

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
    candidate({ email: "sender@example.com", hasMedicalRepExperience: false, phone: "01016585527", university: "Old University" }),
    medicalRep,
  );
  assert.equal(seeded.phone.value, "01016585527", "an empty proposal falls back to what is already saved");
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
}
