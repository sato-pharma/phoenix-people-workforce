/**
 * What an employee may attach to an outstation request as its ticket or invoice, judged BEFORE
 * anything is sent.
 *
 * The server refuses a decoded attachment over 5 MB (car-evidence-storage.ts) and the whole request
 * travels as ONE JSON body — every file base64-encoded, plus the arrival photo — through
 * proxy.ts, which Next buffers only up to 10 MB. A phone camera shot is routinely 4-8 MB, and the
 * picker offers `image/*` (HEIC, WebP, GIF included) plus multi-select, so a perfectly ordinary
 * invoice photo reached the server as a refusal or a truncated body and the employee saw either a
 * message about "5MB" they had no way to act on, or "Unable to submit the request." with nothing.
 * Production agrees: across the last 60 days every stored ticket file is a JPEG under 3 MB.
 *
 * The wizard therefore shrinks photos itself (see prepareTicketAttachment in the wizard) and asks
 * this module two things first: is the file one we can accept at all, and will the finished body
 * fit. Both answers are words the employee can act on.
 */

/** A PDF cannot be shrunk in the browser, so it is held to the server's own cap, with headroom. */
export const TICKET_PDF_MAX_BYTES = 4.5 * 1024 * 1024;

/** The longest side, in pixels, an attached photo is scaled down to — legible for an invoice. */
export const TICKET_IMAGE_MAX_DIMENSION = 1600;

/** JPEG quality for a re-encoded attachment; the second value is the fallback when it is too big. */
export const TICKET_IMAGE_QUALITY = 0.8;
export const TICKET_IMAGE_FALLBACK_QUALITY = 0.6;

/** The most one submission may carry, as the base64 characters that go over the wire. */
export const SUBMIT_BODY_MAX_CHARS = 9 * 1024 * 1024;

/** The most files one submission may carry. */
export const TICKET_MAX_FILES = 3;

export type TicketFileVerdict =
  | { kind: "image" | "pdf"; ok: true }
  | { message: string; ok: false };

function megabytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether one chosen file can be attached. `type` may be empty on some Android pickers. */
export function checkTicketAttachmentFile(file: {
  name: string;
  size: number;
  type: string;
}): TicketFileVerdict {
  const type = file.type.trim().toLowerCase();
  const name = file.name.trim().toLowerCase();
  const isPdf = type === "application/pdf" || (!type && name.endsWith(".pdf"));
  const isImage = type.startsWith("image/") || (!type && /\.(jpe?g|png|webp|heic|heif|gif)$/.test(name));

  if (file.size <= 0) {
    return { message: `"${file.name}" is empty. Choose the file again.`, ok: false };
  }
  if (isPdf) {
    if (file.size > TICKET_PDF_MAX_BYTES) {
      return {
        message: `"${file.name}" is ${megabytes(file.size)}, and a PDF can be at most ${megabytes(TICKET_PDF_MAX_BYTES)}. Take a photo of the invoice instead, or send a smaller PDF.`,
        ok: false,
      };
    }
    return { kind: "pdf", ok: true };
  }
  if (isImage) return { kind: "image", ok: true };

  return {
    message: `"${file.name}" cannot be attached. Use a photo (JPG or PNG) or a PDF.`,
    ok: false,
  };
}

/** Whether the finished request body fits. `chars` is the summed length of every data URL sent. */
export function checkSubmitBodySize(chars: number): { message: string; ok: false } | { ok: true } {
  if (chars <= SUBMIT_BODY_MAX_CHARS) return { ok: true };
  return {
    message: `The attachments are too large to send together (${megabytes(chars)} of ${megabytes(SUBMIT_BODY_MAX_CHARS)} allowed). Remove one, or attach a smaller photo.`,
    ok: false,
  };
}

/** `invoice.HEIC` -> `invoice.jpg`; a name with no extension gains one. */
export function jpegFileName(name: string) {
  const base = name.replace(/\.[^./\\]+$/, "").trim();
  return `${base || "attachment"}.jpg`;
}
