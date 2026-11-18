// The type a file is STORED under in a storage bucket, as opposed to the type the app records for it.
//
// Two buckets take files whose type nobody in the company chooses: `whatsapp-inbox-media` (what a
// sender outside the company sends, under the type Meta reports) and `notification-held-attachments`
// (a held email's files, kept until someone approves it). Both carry an exact list of allowed types
// (migration 20261119014513), so a web page or a script can never be stored and served from them.
//
// A file whose type is NOT on the list is still kept — stored as `application/octet-stream`, which
// both lists allow and which storage serves as a download, never renders. Nothing is lost: the
// WhatsApp inbox records the real type on the message row, and a held email records it on the held
// attachment, and both read the file back under THAT type. Before this, an unlisted type would have
// failed the upload: the inbox could not open the file, and the held email could not be approved.
//
// 🔴 Each list here must equal its bucket's `allowed_mime_types` exactly.
// tests/stored-content-type.test.ts reads the migration and fails when they differ.

export const GENERIC_BINARY = "application/octet-stream";

const PDF = "application/pdf";
const WORD = "application/msword";
const WORD_X = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const EXCEL = "application/vnd.ms-excel";
const EXCEL_X = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const POWERPOINT = "application/vnd.ms-powerpoint";
const POWERPOINT_X = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * The media types WhatsApp delivers to the Cloud API (images, stickers, voice notes and audio, video,
 * and the document types), plus the generic type every other file is stored under. Every type that
 * has reached production's inbox is here.
 */
export const WHATSAPP_INBOX_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/3gpp",
  "audio/aac",
  "audio/amr",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "text/plain",
  PDF,
  WORD,
  WORD_X,
  EXCEL,
  EXCEL_X,
  POWERPOINT,
  POWERPOINT_X,
  GENERIC_BINARY,
]);

/** What Phoenix's emails attach: documents, spreadsheets, slides, pictures and plain text or CSV. */
export const HELD_ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
  PDF,
  WORD,
  WORD_X,
  EXCEL,
  EXCEL_X,
  POWERPOINT,
  POWERPOINT_X,
  GENERIC_BINARY,
]);

/**
 * The content type to upload a file under: its own type when the bucket allows it (parameters such
 * as `; codecs=opus` kept, since storage compares only the type itself), otherwise the generic type.
 */
export function storedContentType(contentType: string | null | undefined, allowed: ReadonlySet<string>): string {
  const own = (contentType ?? "").trim();
  const base = own.split(";")[0]!.trim().toLowerCase();
  return base && allowed.has(base) ? own : GENERIC_BINARY;
}
