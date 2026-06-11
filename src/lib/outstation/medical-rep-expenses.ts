export type MedicalRepSimpleExpenseAttachment = {
  bytes: Buffer;
  contentType: string;
  fileName: string;
  size: number;
};

export type MedicalRepSimpleExpenseInput = {
  amWorkload?: number;
  attachments: MedicalRepSimpleExpenseAttachment[];
  goTicketAmount: number;
  notes: string;
  pmWorkload?: number;
  returnTicketAmount: number;
  toLocation: string;
  tripEndDate: string;
  tripStartDate: string;
};

export type NormalizedMedicalRepSimpleExpenseInput = {
  attachments: MedicalRepSimpleExpenseAttachment[];
  goTicketAmount: number;
  notes: string;
  returnTicketAmount: number;
  ticketAmount: number;
  toLocation: string;
  tripEndDate: string;
  tripStartDate: string;
};

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function parseRequiredDate(value: unknown, fieldLabel: string) {
  const raw = text(value);
  if (!raw) {
    throw new Error(`${fieldLabel} is required.`);
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldLabel} is invalid.`);
  }

  return date.toISOString();
}

export function validateMedicalRepSimpleExpenseInput(
  input: MedicalRepSimpleExpenseInput,
): NormalizedMedicalRepSimpleExpenseInput {
  const toLocation = text(input.toLocation);
  if (!toLocation) {
    throw new Error("Destination is required.");
  }

  const notes = text(input.notes);
  if (!notes) {
    throw new Error("Expense note is required.");
  }

  const tripStartDate = parseRequiredDate(input.tripStartDate, "From date");
  const tripEndDate = parseRequiredDate(input.tripEndDate, "To date");
  if (new Date(tripEndDate).getTime() < new Date(tripStartDate).getTime()) {
    throw new Error("To date must be after from date.");
  }

  const goTicketAmount = roundMoney(numberValue(input.goTicketAmount));
  const returnTicketAmount = roundMoney(numberValue(input.returnTicketAmount));
  if (goTicketAmount < 0 || returnTicketAmount < 0) {
    throw new Error("Ticket amounts cannot be negative.");
  }

  const ticketAmount = roundMoney(goTicketAmount + returnTicketAmount);
  if (ticketAmount <= 0) {
    throw new Error("At least one ticket amount is required.");
  }

  if (!Array.isArray(input.attachments) || input.attachments.length === 0) {
    throw new Error("Ticket attachment is required.");
  }

  return {
    attachments: input.attachments,
    goTicketAmount,
    notes,
    returnTicketAmount,
    ticketAmount,
    toLocation,
    tripEndDate,
    tripStartDate,
  };
}
