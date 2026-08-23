// Recruitment / ATS — logic shared by both inbound-CV-import allowlists (WhatsApp forward
// imports and email forward imports). Each channel's "is this sender an import source" check is
// channel-specific (phone-number-tail matching vs. address matching — see
// whatsapp-payload-parser.ts and email-message-parser.ts), but the sender-list parsing and the
// "does this filename look like a person's name" heuristic are identical, so they live here once.

/** Splits a configured comma-separated import-sender list (env var) into entries. */
export function parseImportSenderList(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Filenames are the last resort for a name when the CV itself could not be read. Anything that
// merely describes the file rather than the person is rejected, so an obviously-flagged
// placeholder is used instead — an obviously-blank record beats a hundred candidates called
// "Document".
const GENERIC_ATTACHMENT_NAME = /^(cv|resume|document|doc|file|image|img|scan|photo|whatsapp|attachment)([\s\d]|image|document)*$/i;

// A CV forwarded out of a mail archive carries the whole envelope in its filename:
//   "Nayera S Mahmoud HR Resume From(Nayera Samy Mahmoud (nsmahmoud@outlook com)) Subject(…) Date(…)"
// The display name inside From(…) is the only part of that string that names a person; the rest
// describes the message. The 2026-08-18 bulk forward stored 220 candidates under the raw stem —
// full envelope and all — because the guard below only rejected short generic stems.
const ENVELOPE_SENDER = /(?:^|[\s_])From\(\s*([^()]*?)\s*\(/i;
const ENVELOPE_MARKER = /(?:^|[\s_])(?:From|Subject|Date)\(/i;

// Shared mailboxes forward other people's CVs, so their display name is not the applicant's.
const GENERIC_MAILBOX_NAME = /^(personnel|admin|hr|info|careers?|jobs?|recruitment|cv|resume|noreply|no-reply|mail|support|contact|team|office)([\s._-]|$)/i;

// Egyptian names run long, but an eight-word "name" is a sentence or a document heading.
const MAX_NAME_WORDS = 7;

function personNameOrNull(raw: string): string | null {
  const name = raw
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return null;
  if (GENERIC_ATTACHMENT_NAME.test(name)) return null;
  if (GENERIC_MAILBOX_NAME.test(name)) return null;
  if (name.includes("@")) return null; // an address is not a name
  if (name.split(" ").length > MAX_NAME_WORDS) return null;
  // Needs at least one letter (Latin or Arabic) — a date-stamped name is not a person.
  return /[a-z؀-ۿ]/i.test(name) ? name : null;
}

export function nameFromAttachmentFilename(filename: string | null): string | null {
  if (!filename) return null;
  const stem = filename.replace(/\.[a-z0-9]+$/i, "");

  const sender = stem.match(ENVELOPE_SENDER)?.[1];
  if (sender !== undefined) return personNameOrNull(sender);
  // An envelope whose sender could not be read describes the message, not the applicant.
  if (ENVELOPE_MARKER.test(stem)) return null;

  return personNameOrNull(stem);
}
