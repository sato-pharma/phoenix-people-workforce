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

  assert.throws(
    () =>
      validateMedicalRepSimpleExpenseInput({
        attachments: [],
        goTicketAmount: 120,
        notes: "Doctor visit",
        returnTicketAmount: 130,
        toLocation: "Mansoura Hospital",
        tripEndDate: "2026-05-19",
        tripStartDate: "2026-05-19",
      }),
    /attachment is required/i,
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
