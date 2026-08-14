import assert from "node:assert/strict";

import { buildReviewBoardFields, selectPendingReviewFields } from "../src/lib/recruitment/cv-review-queue.ts";

// Every value the universal schema can propose: scalars, a number (graduationYear,
// yearsExperience) and a repeating block (workHistory and its four siblings).
type ProposedValue = string | boolean | number | Array<Record<string, unknown>> | null;
const high = (value: ProposedValue) => ({ confidence: "high" as const, value });
const low = (value: ProposedValue) => ({ confidence: "low" as const, value });

// A candidate as it looks straight out of automated intake AFTER cv-auto-apply has run: identity
// written by createCandidate, the confident fields already filled, the hedged ones still empty.
function autoIntakeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    address: null,
    email: "yousab@example.com",
    faculty: null,
    fullName: "Yousab Ezzat",
    governorate: "Assiut",
    hasMedicalRepExperience: false,
    hasPriorWorkExperience: true,
    medicalRepEmployer: null,
    medicalRepExperienceFrom: null,
    medicalRepExperienceTo: null,
    phone: "01229035737",
    positionSpecificFields: {},
    university: "Assiut university",
    ...overrides,
  };
}

export function runRecruitmentCvReviewQueueTests() {
  // --- The point of the queue: low-confidence proposals ARE surfaced ------------------------------
  // cv-auto-apply declines these on purpose; before this module nothing ever showed them to anyone.
  const pending = selectPendingReviewFields({
    candidate: autoIntakeCandidate(),
    extractedFields: {
      address: low("New Cairo"),
      faculty: low("Faculty of Pharmacy"),
      fullName: high("Yousab Ezzat"),
      governorate: low("Cairo"),
      university: high("Assiut university"),
    },
    positionKey: "medical_rep",
  });
  const keys = pending.map((field) => field.key).sort();
  assert.deepEqual(keys, ["address", "faculty"], "only blank, non-identity, valued fields are pending");

  const address = pending.find((field) => field.key === "address");
  assert.equal(address?.value, "New Cairo");
  assert.equal(address?.confidence, "low");
  assert.equal(address?.type, "string");
  assert.ok(address?.label, "the label is carried through for display");

  // `governorate` is dropped because the candidate already HAS a value — a settled field is not a
  // decision. `university` is dropped for the same reason (auto-apply wrote it).

  // --- Identity is never offered, even when the column is blank ----------------------------------
  // The queue shares CV_IDENTITY_FIELD_KEYS with cv-auto-apply precisely so it cannot drift and
  // start offering to repoint an existing candidate's identity + dedupe norms.
  const identityBlank = selectPendingReviewFields({
    candidate: autoIntakeCandidate({ email: null, fullName: "", phone: null }),
    extractedFields: { email: high("other@example.com"), fullName: high("Someone Else"), phone: high("0100") },
    positionKey: "medical_rep",
  });
  assert.deepEqual(identityBlank, [], "identity fields are never queued for review");

  // --- High confidence still surfaces when it was NOT applied -----------------------------------
  // An extraction predating cv-auto-apply, or one whose best-effort apply failed, leaves a
  // high-confidence value with a blank column. Filtering the queue on confidence would hide it.
  const unappliedHigh = selectPendingReviewFields({
    candidate: autoIntakeCandidate({ university: null }),
    extractedFields: { university: high("Assiut university") },
    positionKey: "medical_rep",
  });
  assert.deepEqual(
    unappliedHigh.map((field) => field.key),
    ["university"],
    "an unapplied high-confidence field still needs a human",
  );

  // --- Empty / null / mistyped proposals are not decisions ---------------------------------------
  const noise = selectPendingReviewFields({
    candidate: autoIntakeCandidate({ address: null, faculty: null, hasPriorWorkExperience: null }),
    extractedFields: {
      address: low(""),
      faculty: low(null),
      // A malformed model response must never reach the UI shaped like a boolean field.
      hasPriorWorkExperience: low("yes"),
    },
    positionKey: "medical_rep",
  });
  assert.deepEqual(noise, [], "empty, null, and type-mismatched proposals are dropped");

  // A real boolean in a blank boolean column IS a decision, including `false`.
  const boolPending = selectPendingReviewFields({
    candidate: autoIntakeCandidate({ hasMedicalRepExperience: null }),
    extractedFields: { hasMedicalRepExperience: low(false) },
    positionKey: "medical_rep",
  });
  assert.deepEqual(boolPending.map((field) => field.key), ["hasMedicalRepExperience"]);
  assert.equal(boolPending[0]?.value, false, "a proposed false is a reviewable answer, not an absence");

  // A number in a number column is a decision; a number-shaped string is not.
  const numeric = selectPendingReviewFields({
    candidate: autoIntakeCandidate(),
    extractedFields: { graduationYear: low(2015), yearsExperience: low("five" as unknown as number) },
    positionKey: "medical_rep",
  });
  assert.deepEqual(numeric.map((field) => field.key), ["graduationYear"], "a string in a number field never reaches the UI");
  assert.equal(numeric[0]?.value, 2015, "the number is carried through unchanged, not stringified");
  assert.equal(numeric[0]?.type, "number", "the type is carried through so the board renders a number control");

  // --- A repeating block is never a pending decision ---------------------------------------------
  // Gate 1 excludes non-column fields, and since 2026-08-14 that is a CONCLUSION rather than a
  // deferral: cv-auto-apply.ts now writes a block itself whenever the candidate holds none, so a
  // block only ever reaches this function when the candidate ALREADY has entries. That is settled,
  // not pending — replacing an existing work history is a profile edit, not a gap to fill, and
  // queueing it would invite a reviewer to overwrite one by accident.
  const withBlocks = selectPendingReviewFields({
    candidate: autoIntakeCandidate(),
    extractedFields: {
      address: low("New Cairo"),
      skills: high([{ name: "Selling skills" }]),
      workHistory: high([{ employer: "Sanofi", jobTitle: "Medical Rep" }]),
    },
    positionKey: "medical_rep",
  });
  assert.deepEqual(
    withBlocks.map((field) => field.key),
    ["address"],
    "an array field never becomes a pending row, however confident the proposal",
  );

  // --- Unknown position / missing extraction -----------------------------------------------------
  assert.deepEqual(
    selectPendingReviewFields({ candidate: autoIntakeCandidate(), extractedFields: {}, positionKey: "nope" }),
    [],
    "an unregistered position yields nothing rather than throwing",
  );
  assert.deepEqual(
    selectPendingReviewFields({ candidate: autoIntakeCandidate(), extractedFields: null, positionKey: "medical_rep" }),
    [],
  );

  // --- buildReviewBoardFields: identity is seeded from the CANDIDATE, not the CV -----------------
  // The board writes every field it renders. Prefilling identity from the extraction would show a
  // competing identity a reviewer could save without noticing, overwriting the one createCandidate
  // resolved (and the dedupe norms derived from it).
  const board = buildReviewBoardFields({
    candidate: { email: "stored@example.com", fullName: "Stored Name", phone: "01000000000" },
    extractedFields: {
      email: high("cv@example.com"),
      fullName: high("CV Name"),
      governorate: low("Cairo"),
      phone: high("01199999999"),
    },
    positionKey: "medical_rep",
  });
  assert.equal(board.fullName?.value, "Stored Name", "board shows the stored identity");
  assert.equal(board.email?.value, "stored@example.com");
  assert.equal(board.phone?.value, "01000000000");
  // This candidate has no stored governorate, so the proposal is still what the reviewer judges —
  // and it keeps its "low" confidence so the board's "Check this" badge survives.
  assert.equal(board.governorate?.value, "Cairo");
  assert.equal(board.governorate?.confidence, "low");

  // A candidate with no stored email/phone yields null rather than leaking the CV's value in.
  const boardNulls = buildReviewBoardFields({
    candidate: { email: null, fullName: "Stored Name", phone: null },
    extractedFields: { email: high("cv@example.com"), phone: high("01199999999") },
    positionKey: "medical_rep",
  });
  assert.equal(boardNulls.email?.value, null);
  assert.equal(boardNulls.phone?.value, null);

  // The source extraction object is not mutated — it is the audit trail.
  const source = { governorate: low("Cairo") };
  buildReviewBoardFields({
    candidate: { email: null, fullName: "X", phone: null },
    extractedFields: source,
    positionKey: "medical_rep",
  });
  assert.deepEqual(Object.keys(source), ["governorate"], "buildReviewBoardFields must not mutate its input");

  // --- buildReviewBoardFields: a stored column always survives the save --------------------------
  // The board persists every field it renders, so the prefill is the only thing protecting the rest
  // of the record. Two ways that used to lose data on an EXISTING candidate, both fixed here:
  //   (a) a column the AI never extracted arrived blank and was written back as null, wiping it;
  //   (b) a column the AI DID extract but that was already filled arrived holding the AI's value,
  //       overwriting the human's.
  // selectPendingReviewFields only ever queues BLANK columns, so neither was a decision anyone
  // asked the reviewer to make.
  const settled = buildReviewBoardFields({
    candidate: autoIntakeCandidate(),
    extractedFields: {
      faculty: low("Faculty of Pharmacy"),
      governorate: low("Cairo"),
      hasPriorWorkExperience: high(false),
    },
    positionKey: "medical_rep",
  });
  assert.equal(settled.governorate?.value, "Assiut", "(b) a stored value beats the AI's proposal");
  assert.equal(settled.governorate?.confidence, "high", "a stored value is not an AI guess to check");
  assert.equal(
    settled.university?.value,
    "Assiut university",
    "(a) a stored value the AI never proposed is still on the board, so the save writes it back",
  );
  assert.equal(settled.faculty?.value, "Faculty of Pharmacy", "a genuinely blank column keeps the proposal");
  assert.equal(settled.faculty?.confidence, "low");
  // Booleans go through the same rule: the candidate's recorded `true` outranks the AI's proposed
  // `false`. isBlankCandidateValue also treats a stored `false` as an answer rather than an
  // absence, so a recorded "no" is equally safe from a later extraction proposing "yes".
  assert.equal(settled.hasPriorWorkExperience?.value, true, "the stored boolean wins over the proposal");

  // Every schema-backed column the candidate holds is on the board. This is the invariant the two
  // cases above are instances of: if it is filled, the reviewer sees it and saving cannot clear it.
  const storedKeys = ["governorate", "hasMedicalRepExperience", "hasPriorWorkExperience", "university"] as const;
  for (const key of storedKeys) {
    assert.notEqual(settled[key]?.value, null, `${key} must be prefilled, not saved back as null`);
  }

  // A stored value of the wrong runtime type is ignored rather than rendered into the wrong control
  // — the same defence selectPendingReviewFields applies to a malformed proposal.
  const mistyped = buildReviewBoardFields({
    candidate: autoIntakeCandidate({ governorate: 7 }),
    extractedFields: { governorate: low("Cairo") },
    positionKey: "medical_rep",
  });
  assert.equal(mistyped.governorate?.value, "Cairo", "a mistyped stored value falls back to the proposal");

  // --- buildReviewBoardFields: a stored repeating block also survives the save --------------------
  // Case (b) above, applied to position_specific_fields. The board's save writes every block it was
  // handed, so prefilling a block from a NEW extraction would replace a work history a human had
  // corrected with the model's fresh guess at it — and unlike a column, nothing else on the screen
  // would show that it had changed.
  const boardBlocks = buildReviewBoardFields({
    candidate: autoIntakeCandidate({
      positionSpecificFields: {
        skills: [{ name: "Corrected skill" }],
        workHistory: [{ employer: "Corrected by a human", jobTitle: "Medical Rep" }],
      },
    }),
    extractedFields: {
      languages: high([{ language: "English", level: "Fluent" }]),
      workHistory: high([{ employer: "The model's guess" }]),
    },
    positionKey: "medical_rep",
  });
  assert.deepEqual(
    boardBlocks.workHistory?.value,
    [{ employer: "Corrected by a human", jobTitle: "Medical Rep" }],
    "the candidate's stored block beats the extraction's",
  );
  assert.equal(boardBlocks.workHistory?.confidence, "high", "a stored block is not an AI guess to check");
  assert.deepEqual(
    boardBlocks.skills?.value,
    [{ name: "Corrected skill" }],
    "a stored block the AI never proposed is still on the board, so the save writes it back",
  );
  assert.deepEqual(
    boardBlocks.languages?.value,
    [{ language: "English", level: "Fluent" }],
    "a block the candidate does not hold keeps the proposal",
  );

  // A stored block holding no usable entries is not a value to defend — the proposal stands.
  const junkBlock = buildReviewBoardFields({
    candidate: autoIntakeCandidate({ positionSpecificFields: { workHistory: ["not-an-entry"] } }),
    extractedFields: { workHistory: high([{ employer: "Sanofi" }]) },
    positionKey: "medical_rep",
  });
  assert.deepEqual(junkBlock.workHistory?.value, [{ employer: "Sanofi" }], "a malformed stored block falls back to the proposal");

  // An unregistered position still yields the identity override rather than throwing.
  const unknownPosition = buildReviewBoardFields({
    candidate: autoIntakeCandidate(),
    extractedFields: { fullName: high("CV Name") },
    positionKey: "nope",
  });
  assert.equal(unknownPosition.fullName?.value, "Yousab Ezzat");
}
