import { TICKET_MAX_FILES } from "@/lib/outstation/ticket-attachment-limits";

export type MedicalRepSimpleExpenseAttachment = {
  bytes: Buffer;
  contentType: string;
  fileName: string;
  size: number;
};

export type MedicalRepSimpleExpenseInput = {
  amWorkload?: number;
  /**
   * The trip's photos — AT LEAST TWO, every one a JPG or PNG (owner, 2026-11-11: "make the
   * outstation expense for reps can upload photo or multiple and all required", answered "Minimum
   * two photos"). This replaces the owner's 2026-10-01 instruction that the upload was optional.
   * The rep may add them one at a time or several at once, up to MEDICAL_REP_MAX_PHOTOS; the form
   * shrinks each to a JPEG first so the body fits the proxy's 10 MB. The row still waits for a
   * human exactly as before — the photos are evidence for HR, they approve nothing.
   */
  attachments: MedicalRepSimpleExpenseAttachment[];
  goTicketAmount: number;
  notes: string;
  pmWorkload?: number;
  returnTicketAmount: number;
  toLocation: string;
  /**
   * The Google place id behind `toLocation`, when the rep chose a suggestion rather than typing.
   *
   * OPTIONAL, and it must stay optional. This path's whole character is that it refuses nothing:
   * it files a ticket amount with an attachment and sends the row to a human. Making a place id
   * mandatory would reject a real claim because a lookup was slow or the key was down — the same
   * shape of failure as the Maps outage that silently blanked residences in August.
   */
  toPlaceId?: string | null;
  tripEndDate: string;
  tripStartDate: string;
};

/** The fewest photos a medical rep's traveling expense may carry (owner, 2026-11-11). */
export const MEDICAL_REP_MIN_PHOTOS = 2;

/** The most photos one claim may carry — six shrunk JPEGs stay well inside the proxy's 10 MB. */
export const MEDICAL_REP_MAX_PHOTOS = 6;

/** The photo types the server stores (car-evidence-storage.ts accepts these two images). */
const MEDICAL_REP_PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);

/**
 * Whether a set of photos is enough to submit, in words the rep can act on — ONE answer for the
 * form's Submit button and the server's refusal, so the screen never lets through what the server
 * then refuses.
 */
export function medicalRepPhotoProblem(photos: ReadonlyArray<{ contentType: string }>): string | null {
  if (photos.length < MEDICAL_REP_MIN_PHOTOS) {
    const missing = MEDICAL_REP_MIN_PHOTOS - photos.length;
    return photos.length === 0
      ? `At least ${MEDICAL_REP_MIN_PHOTOS} photos are required.`
      : `At least ${MEDICAL_REP_MIN_PHOTOS} photos are required — add ${missing} more.`;
  }
  if (photos.length > MEDICAL_REP_MAX_PHOTOS) {
    return `Photos must be ${MEDICAL_REP_MAX_PHOTOS} or fewer — remove ${photos.length - MEDICAL_REP_MAX_PHOTOS}.`;
  }
  if (photos.some((photo) => !MEDICAL_REP_PHOTO_CONTENT_TYPES.has(photo.contentType))) {
    return "Every attachment must be a photo (JPG or PNG).";
  }
  return null;
}

export type NormalizedMedicalRepSimpleExpenseInput = {
  attachments: MedicalRepSimpleExpenseAttachment[];
  goTicketAmount: number;
  notes: string;
  returnTicketAmount: number;
  ticketAmount: number;
  toLocation: string;
  /** Null when nothing was chosen — never an empty string, so the column reads as absent. */
  toPlaceId: string | null;
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

  // At least two photos, all of them images (owner, 2026-11-11). The words contain "required" or
  // "must be", which the route answers as a 400 the form shows as it is.
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const photoProblem = medicalRepPhotoProblem(attachments);
  if (photoProblem) {
    throw new Error(photoProblem);
  }

  return {
    attachments,
    goTicketAmount,
    notes,
    returnTicketAmount,
    ticketAmount,
    toLocation,
    // Normalised to null rather than "" so `to_place_id` reads as absent in the database and in
    // every `is null` query, instead of as a present-but-empty value that looks chosen.
    toPlaceId: text(input.toPlaceId) || null,
    tripEndDate,
    tripStartDate,
  };
}

// ─── Other expense ──────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-11-23: "make it possible to choose either traveling as it is now or other. In other,
// for example, he have an invoice or anything that he paid and need to be paid to him … if other no
// destination will be chosen, only a field for a comment, and it is required, and date, and upload
// PDF or image is required, and make this option to pass by approval or rejection from the system
// administrator."
//
// So an Other claim carries: one date, the amount paid, the rep's comment (required) and the
// invoice — at least one PDF or photo (required). No destination, no tickets, no allowance, no
// distance. It is stored as `expense_type = 'other'` (the column has allowed it since 2026-09-03),
// priced on the typed amount alone, and waits for the Super Admin on Expense Approvals, where a
// non-trip claim is never Ready (approvals/checks.ts reads the invoice as "your call").

/** The two kinds the rep's form offers. Traveling is the form as it was; Other is the invoice claim. */
export type MedicalRepExpenseKind = "traveling" | "other";

export function isMedicalRepExpenseKind(value: unknown): value is MedicalRepExpenseKind {
  return value === "traveling" || value === "other";
}

/** The fewest invoice files an Other claim may carry (owner, 2026-11-23: "upload … is required"). */
export const MEDICAL_REP_OTHER_MIN_FILES = 1;

/** The most — the same cap the main Submit Expense form puts on an invoice or ticket. */
export const MEDICAL_REP_OTHER_MAX_FILES = TICKET_MAX_FILES;

/**
 * The most the files may weigh together. A PDF cannot be shrunk in the browser, and the whole form
 * travels as one body through the proxy, which Next buffers only up to 10 MB.
 */
export const MEDICAL_REP_OTHER_MAX_TOTAL_BYTES = 9 * 1024 * 1024;

/** The invoice types the server stores (car-evidence-storage.ts accepts exactly these three). */
const MEDICAL_REP_OTHER_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/**
 * Whether the invoice files are enough to submit, in words the rep can act on — ONE answer for the
 * form's Submit button and the server's refusal. Every sentence carries "required" or "must be",
 * which the route answers as a 400 the form shows as it is.
 */
export function medicalRepOtherFileProblem(
  files: ReadonlyArray<{ contentType: string; size: number }>,
): string | null {
  if (files.length < MEDICAL_REP_OTHER_MIN_FILES) {
    return "The invoice or receipt is required — attach a PDF or a photo.";
  }
  if (files.length > MEDICAL_REP_OTHER_MAX_FILES) {
    return `Files must be ${MEDICAL_REP_OTHER_MAX_FILES} or fewer — remove ${files.length - MEDICAL_REP_OTHER_MAX_FILES}.`;
  }
  if (files.some((file) => !MEDICAL_REP_OTHER_CONTENT_TYPES.has(file.contentType))) {
    return "Every file must be a PDF or a photo (JPG or PNG).";
  }
  const total = files.reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0);
  if (total > MEDICAL_REP_OTHER_MAX_TOTAL_BYTES) {
    return "The files must be 9 MB or less together — remove one, or attach a smaller PDF.";
  }
  return null;
}

export type MedicalRepOtherExpenseInput = {
  amount: number;
  attachments: MedicalRepSimpleExpenseAttachment[];
  /** The day the rep paid, as the form's date box sends it (YYYY-MM-DD). */
  expenseDate: string;
  notes: string;
};

export type NormalizedMedicalRepOtherExpenseInput = {
  amount: number;
  attachments: MedicalRepSimpleExpenseAttachment[];
  /** Midnight UTC of the chosen day, the same shape the traveling form stores its dates in. */
  expenseDate: string;
  notes: string;
};

/**
 * Checks an Other claim. `today` is Cairo's calendar day (YYYY-MM-DD): an invoice is a cost already
 * paid, so a day after today is refused — the date box on the form stops at today as well.
 */
export function validateMedicalRepOtherExpenseInput(
  input: MedicalRepOtherExpenseInput,
  today: string,
): NormalizedMedicalRepOtherExpenseInput {
  const rawDate = text(input.expenseDate);
  if (!rawDate) {
    throw new Error("Date is required.");
  }
  const day = rawDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) {
    throw new Error("Date is invalid.");
  }
  if (today && day > today) {
    throw new Error("Date must be today or earlier.");
  }

  const amount = roundMoney(numberValue(input.amount));
  if (amount <= 0) {
    throw new Error("Invoice amount is required — enter the amount on the invoice.");
  }

  const notes = text(input.notes);
  if (!notes) {
    throw new Error("Comment is required — say what this payment was for.");
  }

  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const fileProblem = medicalRepOtherFileProblem(attachments);
  if (fileProblem) {
    throw new Error(fileProblem);
  }

  return {
    amount,
    attachments,
    expenseDate: new Date(`${day}T00:00:00Z`).toISOString(),
    notes,
  };
}
