// The rules for a picture attached to a deduction dispute reply — pure, so a test can run them
// without a database. The server module (comment-attachments.ts) stores and serves the bytes; this
// file decides which bytes are acceptable and where they live.

export const DISPUTE_ATTACHMENT_BUCKET = "deductions-dispute-attachments";

/** A reply carries a few pictures, not an album. */
export const DISPUTE_ATTACHMENT_MAX_FILES = 4;

/** Matches the bucket's file_size_limit. The browser shrinks a phone photo well below this first. */
export const DISPUTE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export type DisputeAttachmentContentType = "image/jpeg" | "image/png" | "image/webp";

/**
 * What the bytes ARE, read from the file's own first bytes — never from the name or the type the
 * browser claimed. A renamed script or a PDF must not be served back to the employee as a picture.
 */
export function sniffDisputeImageType(bytes: Uint8Array): DisputeAttachmentContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const EXTENSION_BY_TYPE: Record<DisputeAttachmentContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** A file name safe to show and to keep in a row: no path parts, no control characters, bounded. */
export function cleanDisputeFileName(raw: unknown, contentType: DisputeAttachmentContentType): string {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = `picture.${EXTENSION_BY_TYPE[contentType]}`;
  if (!base) return fallback;
  return base.length > 120 ? `${base.slice(0, 116).replace(/\.[^.]*$/, "")}.${EXTENSION_BY_TYPE[contentType]}` : base;
}

/**
 * Where the bytes live. Keyed on the candidate and the attachment's OWN uuid — the original file
 * name never reaches the storage key, so a name cannot collide, traverse or leak.
 */
export function buildDisputeAttachmentPath(input: {
  attachmentId: string;
  candidateId: string;
  contentType: DisputeAttachmentContentType;
}): string {
  const safe = (value: string) => value.trim().replace(/[^a-zA-Z0-9-]+/g, "");
  const candidateId = safe(input.candidateId);
  const attachmentId = safe(input.attachmentId);
  if (!candidateId || !attachmentId) throw new Error("Cannot store a picture without the deduction it belongs to.");
  return `${candidateId}/${attachmentId}.${EXTENSION_BY_TYPE[input.contentType]}`;
}

export type CheckedDisputeImage = {
  bytes: Buffer;
  contentType: DisputeAttachmentContentType;
  fileName: string;
};

/** Accept or refuse one uploaded file. The message is what the sender reads, so it says what to do;
 *  the "Validation:" prefix is what turns it into a 400 in deductions/http.ts. */
export function checkDisputeImage(input: { bytes: Uint8Array; name: unknown }): CheckedDisputeImage {
  if (input.bytes.length === 0) throw new Error("Validation: A picture is empty. Choose it again.");
  if (input.bytes.length > DISPUTE_ATTACHMENT_MAX_BYTES) {
    throw new Error("Validation: A picture is larger than 5 MB. Choose a smaller one.");
  }
  const contentType = sniffDisputeImageType(input.bytes);
  if (!contentType) throw new Error("Validation: Only JPEG, PNG or WebP pictures can be attached.");
  return {
    bytes: Buffer.from(input.bytes),
    contentType,
    fileName: cleanDisputeFileName(input.name, contentType),
  };
}
