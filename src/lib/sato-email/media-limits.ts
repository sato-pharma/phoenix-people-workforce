/**
 * The rules about a Sato email attachment that a BROWSER also has to know.
 *
 * Split out of `media.ts` for one reason: that module reaches storage and the service-role client,
 * so importing it from the composer would drag Node crypto and the Supabase admin key into the
 * client bundle. These are the pure halves - the ceilings, the type allowlist, the refusal wording -
 * and the composer, the route and the test all read them from here, so a limit written on screen is
 * the same limit the server enforces rather than a number somebody copied.
 */

/**
 * 10MB per file AND 10MB for everything on one email.
 *
 * Not a round number picked for looks. Resend, the primary provider, accepts 40MB; Brevo, the
 * backup, rejects a message over 10MB outright. Mail fails over to Brevo on a quota or auth error,
 * which is precisely the bad day — so a 20MB attachment would work every time it was tested and
 * fail the one time it mattered. One ceiling, both providers, same behaviour.
 *
 * 🔴 AND IT REFUSES RATHER THAN DROPS. `guardAttachments` in send-phoenix-email.ts silently omits an
 * over-budget file and sends the mail anyway — a defensible default for a system notification and
 * completely wrong here: this screen mails an entire distribution list at once, and "here is the
 * policy, see attached" arriving with nothing attached cannot be recalled.
 */
export const SATO_EMAIL_MEDIA_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SATO_EMAIL_MEDIA_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** The most files one email may carry, so a stray loop cannot post a hundred rows. */
export const SATO_EMAIL_MEDIA_MAX_FILES = 10;

export type SatoEmailMediaKind = "inline" | "attachment";

/**
 * What may be uploaded, by MIME type, and the extension each is stored under.
 *
 * 🔴 NO SVG AND NO HTML. Both can carry script, and both would be served from this application's own
 * origin by the token route — a stored-XSS primitive handed out by the one screen whose whole job is
 * mailing links to the whole company. An image that cannot be expressed as one of these four raster
 * types does not belong in a company announcement.
 */
const INLINE_TYPES: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const ATTACHMENT_ONLY_TYPES: Record<string, string> = {
  "application/msword": "doc",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/csv": "csv",
  "text/plain": "txt",
};

const ATTACHMENT_TYPES: Record<string, string> = { ...INLINE_TYPES, ...ATTACHMENT_ONLY_TYPES };

/** The `accept` attribute for each picker, so the file dialog offers only what will be accepted. */
export const SATO_EMAIL_INLINE_ACCEPT = Object.keys(INLINE_TYPES).join(",");
export const SATO_EMAIL_ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).join(",");

export type SatoEmailMediaRecord = {
  byteSize: number;
  contentType: string;
  filename: string;
  id: string;
  kind: SatoEmailMediaKind;
  /** Present only for an inline picture — the address the `<img src>` points at. */
  url: string | null;
};

export type SatoEmailUploadRefusal = { message: string };

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.max(1, Math.round(bytes))} bytes`;
}

/**
 * Everything that can be decided about an upload without touching storage.
 *
 * Pure on purpose: the same rules are checked here, at the route, and by the test, and a rule that
 * needed a database to state could not be checked by any of the three.
 */
export function validateSatoEmailUpload(input: {
  byteSize: number;
  contentType: string;
  kind: SatoEmailMediaKind;
}): { extension: string } | SatoEmailUploadRefusal {
  const kind = input.kind;
  if (kind !== "inline" && kind !== "attachment") {
    return { message: "A file is either a body picture or an attachment." };
  }

  const contentType = String(input.contentType ?? "").trim().toLowerCase().split(";")[0];
  const table = kind === "inline" ? INLINE_TYPES : ATTACHMENT_TYPES;
  const extension = table[contentType];
  if (!extension) {
    return {
      message:
        kind === "inline"
          ? "A body picture must be a JPEG, PNG, GIF or WebP image."
          : "That file type cannot be attached. Pictures, PDF, Word, Excel, PowerPoint, CSV and plain text are accepted.",
    };
  }

  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0) {
    return { message: "That file is empty." };
  }
  if (input.byteSize > SATO_EMAIL_MEDIA_MAX_FILE_BYTES) {
    return { message: `A file must be ${formatBytes(SATO_EMAIL_MEDIA_MAX_FILE_BYTES)} or smaller.` };
  }

  return { extension };
}

/**
 * The name the recipient sees on the attachment.
 *
 * Stripped of every path separator and control character, because it lands in a `Content-Disposition`
 * header at the provider and in a Save dialog on somebody's machine. The extension is forced to the
 * one the MIME type actually maps to, so `salary.pdf.exe` cannot be talked into arriving as an exe.
 */
export function safeAttachmentFileName(name: string, extension: string): string {
  const base = String(name ?? "")
    .replace(/[\\/]+/g, " ")
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return `${base || "attachment"}.${extension}`;
}

/** Whether a stored content type is one of the four picture types the inline route may serve. */
export function isSatoEmailInlineContentType(contentType: string): boolean {
  return Object.hasOwn(INLINE_TYPES, String(contentType ?? "").trim().toLowerCase());
}
