import assert from "node:assert/strict";

import {
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
    attachments: [attachment],
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

  // THE UPLOAD IS OPTIONAL (owner, 2026-10-01). A claim with no ticket file must validate and
  // normalise to an empty array — it used to throw "Ticket attachment is required.", which sent a
  // rep away with nothing filed even though this path approves nothing and waits for a human.
  const withoutAttachment = validateMedicalRepSimpleExpenseInput({
    attachments: [],
    goTicketAmount: 120,
    notes: "Doctor visit",
    returnTicketAmount: 130,
    toLocation: "Mansoura Hospital",
    tripEndDate: "2026-05-19",
    tripStartDate: "2026-05-19",
  });

  assert.deepEqual(
    withoutAttachment.attachments,
    [],
    "a medical rep expense with no ticket attachment must be accepted — the upload is optional",
  );
  assert.equal(withoutAttachment.ticketAmount, 250);

  // A client that posts nothing at all for the field normalises the same way, so the insert writes
  // attachment_count 0 and an empty metadata array rather than undefined.
  assert.deepEqual(
    validateMedicalRepSimpleExpenseInput({
      attachments: undefined as unknown as MedicalRepSimpleExpenseAttachment[],
      goTicketAmount: 120,
      notes: "Doctor visit",
      returnTicketAmount: 130,
      toLocation: "Mansoura Hospital",
      tripEndDate: "2026-05-19",
      tripStartDate: "2026-05-19",
    }).attachments,
    [],
    "a missing attachments field must normalise to an empty array, never undefined",
  );

  assert.throws(
    () =>
      validateMedicalRepSimpleExpenseInput({
        attachments: [attachment],
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
        attachments: [attachment],
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
        attachments: [attachment],
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
