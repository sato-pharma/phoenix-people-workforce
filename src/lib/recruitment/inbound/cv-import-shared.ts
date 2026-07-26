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

export function nameFromAttachmentFilename(filename: string | null): string | null {
  if (!filename) return null;
  const stem = filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stem || GENERIC_ATTACHMENT_NAME.test(stem)) return null;
  // Needs at least one letter (Latin or Arabic) — a date-stamped name is not a person.
  return /[a-z؀-ۿ]/i.test(stem) ? stem : null;
}
