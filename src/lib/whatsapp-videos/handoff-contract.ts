// The contract between this inbox and the Future Talents Portal, which claims the videos.
//
// Pure on purpose — no Supabase, no logger, no alias imports — so the shape the portal depends on
// is checkable in the unit suite without a database or a running app.

/** How long a download link handed to the portal stays valid. Long enough to copy a 100 MB file
 *  on an office connection; short enough that a link pasted somewhere is dead by the time it is read. */
export const HANDOFF_DOWNLOAD_TTL_SECONDS = 15 * 60;

/** The most videos listed, or marked, in one call. The portal copies them one at a time, so a
 *  larger page would only hand out links that expire before their turn comes. */
export const MAX_HANDOFF_BATCH = 50;

/**
 * One video, safe in the bucket and not yet claimed, as the portal receives it.
 *
 * `waId` is null for a sender who uses a WhatsApp username and whose phone number Meta did not send;
 * `userId` (the business-scoped user id) is then the only identity, and the submission id that sender
 * typed is what says who they are. At least one of the two is always present — the table refuses a
 * row with neither.
 */
export type HandoffVideo = {
  wamid: string;
  waId: string | null;
  userId: string | null;
  username: string | null;
  contactName: string | null;
  fileName: string | null;
  caption: string | null;
  sentAt: string | null;
  byteSize: number | null;
  mimeType: string;
  historical: boolean;
  downloadUrl: string;
};

/**
 * The wamids a claim names, or null when the body is not a claim at all.
 *
 * Refuses rather than trims: a body carrying 51 ids, a non-string, or an empty string is a portal
 * bug, and quietly marking the first fifty as claimed would hide the fifty-first forever — a claimed
 * row is never listed again.
 */
export function parseHandoffWamids(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const wamids = (body as { wamids?: unknown }).wamids;
  if (!Array.isArray(wamids) || wamids.length === 0 || wamids.length > MAX_HANDOFF_BATCH) return null;
  const clean: string[] = [];
  for (const wamid of wamids) {
    if (typeof wamid !== "string") return null;
    const trimmed = wamid.trim();
    if (!trimmed || trimmed.length > 200) return null;
    clean.push(trimmed);
  }
  return [...new Set(clean)];
}

/**
 * The submission ids one WhatsApp sender has sent, as the portal receives them. Keyed like a video:
 * the phone number when Meta sent one, the business-scoped user id always when Meta sent one.
 */
export type HandoffSenderId = {
  waId: string | null;
  userId: string | null;
  submissionIds: string[];
  sentAt: string | null;
};

/**
 * A Future Talents submission id — "FTP-" and eight digits — however a phone typed it.
 *
 * Interns send their id as a message next to their closing videos, and the portal uses it to tell
 * whose videos a chat holds. Typed on a phone it arrives as "FTP-12345678", "ftp 12345678",
 * "FTP12345678" or with Arabic-Indic digits, so all of those fold to the one canonical form.
 *
 * 🔴 NARROW ON PURPOSE. A message this matches is taken OUT of the recruitment pipeline — it is
 * never buffered, classified or answered — so the prefix is required and bare digits are never
 * read as an id. Guessing would swallow an applicant's message; requiring the prefix cannot.
 * No lookbehind: Phoenix type-checks against a target where TypeScript rejects one.
 */
const SUBMISSION_ID = /(?:^|[^A-Za-z0-9])FTP[\s\-_‐-―]*(\d{8})(?!\d)/gi;

export function extractFtpSubmissionIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const ascii = text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
  const found = new Set<string>();
  for (const match of ascii.matchAll(SUBMISSION_ID)) found.add(`FTP-${match[1]}`);
  return [...found];
}
