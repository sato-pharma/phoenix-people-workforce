import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  MEDICAL_REP_MAX_PHOTOS,
  MEDICAL_REP_MIN_PHOTOS,
  medicalRepPhotoProblem,
  validateMedicalRepSimpleExpenseInput,
  type MedicalRepSimpleExpenseAttachment,
} from "../src/lib/outstation/medical-rep-expenses.ts";

const attachment: MedicalRepSimpleExpenseAttachment = {
  bytes: Buffer.from("ticket"),
  contentType: "image/jpeg",
  fileName: "ticket.jpg",
  size: 6,
};

export function runMedicalRepExpensesTests() {
  const normalized = validateMedicalRepSimpleExpenseInput({
    attachments: [attachment, attachment],
    goTicketAmount: 120,
    notes: "Doctor visit in assigned territory",
    returnTicketAmount: 130,
    toLocation: "Mansoura Hospital",
    tripEndDate: "2026-05-19",
    tripStartDate: "2026-05-19",
  });

  assert.equal(normalized.toLocation, "Mansoura Hospital");
  assert.equal(normalized.ticketAmount, 250);
  assert.equal(normalized.notes, "Doctor visit in assigned territory");

  // AT LEAST TWO PHOTOS, EVERY ONE AN IMAGE, AT MOST SIX (owner, 2026-11-11: "upload photo or
  // multiple and all required", answered "Minimum two photos") — replaces the 2026-10-01 rule that
  // the upload was optional.
  const base = {
    goTicketAmount: 120,
    notes: "Doctor visit",
    returnTicketAmount: 130,
    toLocation: "Mansoura Hospital",
    tripEndDate: "2026-05-19",
    tripStartDate: "2026-05-19",
  };
  assert.throws(
    () => validateMedicalRepSimpleExpenseInput({ ...base, attachments: [] }),
    /at least 2 photos are required/i,
    "a claim with no photo must be refused",
  );
  assert.throws(
    () =>
      validateMedicalRepSimpleExpenseInput({
        ...base,
        attachments: undefined as unknown as MedicalRepSimpleExpenseAttachment[],
      }),
    /at least 2 photos are required/i,
    "a client that posts no attachments field must be refused, never waved through",
  );
  assert.throws(
    () => validateMedicalRepSimpleExpenseInput({ ...base, attachments: [attachment] }),
    /add 1 more/i,
    "one photo is not enough — the minimum is two",
  );
  assert.throws(
    () =>
      validateMedicalRepSimpleExpenseInput({
        ...base,
        attachments: [attachment, { ...attachment, contentType: "application/pdf", fileName: "ticket.pdf" }],
      }),
    /must be a photo/i,
    "every attachment must be a photo",
  );
  assert.throws(
    () => validateMedicalRepSimpleExpenseInput({ ...base, attachments: Array(MEDICAL_REP_MAX_PHOTOS + 1).fill(attachment) }),
    /must be 6 or fewer/i,
  );
  assert.equal(MEDICAL_REP_MIN_PHOTOS, 2, "the owner's minimum is two photos");
  assert.equal(
    validateMedicalRepSimpleExpenseInput({ ...base, attachments: [attachment, { ...attachment, contentType: "image/png" }] })
      .attachments.length,
    2,
  );
  assert.equal(medicalRepPhotoProblem([{ contentType: "image/jpeg" }, { contentType: "image/png" }]), null);

  // The form's Submit reads the SAME rule, so it cannot send a claim the server refuses.
  const form = readFileSync(
    new URL("../src/components/employee-portal/medical-rep-expenses.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(form.includes("medicalRepPhotoProblem("), "the form must judge photos with the server's own rule");
  assert.ok(form.includes("!photoProblem &&"), "Submit must stay locked until the photos are enough");
  assert.ok(!form.includes("Attachment (optional)"), "the upload is no longer optional");

  assert.throws(
    () =>
      validateMedicalRepSimpleExpenseInput({
        attachments: [attachment, attachment],
        goTicketAmount: 0,
        notes: "",
        returnTicketAmount: 0,
        toLocation: "Mansoura Hospital",
        tripEndDate: "2026-05-19",
        tripStartDate: "2026-05-19",
      }),
    /note is required/i,
  );

  assert.throws(
    () =>
      validateMedicalRepSimpleExpenseInput({
        attachments: [attachment, attachment],
        goTicketAmount: 120,
        notes: "Doctor visit",
        returnTicketAmount: 130,
        toLocation: "Mansoura Hospital",
        tripEndDate: "2026-05-18",
        tripStartDate: "2026-05-19",
      }),
    /to date must be after from date/i,
  );

  assert.throws(
    () =>
      validateMedicalRepSimpleExpenseInput({
        attachments: [attachment, attachment],
        goTicketAmount: -1,
        notes: "Doctor visit",
        returnTicketAmount: 130,
        toLocation: "Mansoura Hospital",
        tripEndDate: "2026-05-19",
        tripStartDate: "2026-05-19",
      }),
    /cannot be negative/i,
  );
}
