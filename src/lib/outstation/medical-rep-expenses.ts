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
export const MEDICAL_REP_PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);

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
