// ── READING A WORD 97-2003 CV ON THE SCREEN ────────────────────────────────────────────────────
//
// The legacy binary .doc is an OLE2 compound file, not the modern OOXML zip, and NOTHING in a
// browser can render one: docx-preview unzips, and mammoth reads only the same zip. So until this
// module existed the preview had a dead end for that format — "This is an older Word (.doc) format
// that can't be previewed here", with a link to download the file and open it in Word. The owner
// hit it on a CV that arrived on 2026-09-27.
//
// There are 13 of them on production (12 candidates, measured 2026-09-27) and they keep arriving:
// an applicant sending a CV he wrote in 2009 has no idea his file is a different format.
//
// WHAT THIS RETURNS IS TEXT, NOT A PAGE, and that is the honest limit of the format here. The one
// reader that can open a binary .doc in this stack is word-extractor, which walks the WordDocument
// stream and hands back characters — no fonts, no columns, no tables as tables. It is already a
// dependency and already trusted: the CV extraction pipeline has read exactly these files with it
// since 2026-08-27 (cv-extraction.ts), which is why they are searchable today even though nobody
// could look at one. A CV as clean text is READABLE, which is the whole job; the alternative on
// offer was a sentence saying no.
//
// Server-only, and deliberately not imported by cv-extraction.ts's own path: this is the PREVIEW's
// shape of the same read (paragraphs, ready to paint) and that one wants a single blob of text for
// a model. The byte-level format test they share lives in cv-file-kind.ts.

import { isLegacyDocBytes } from "./cv-file-kind";

export type LegacyDocText = {
  /** One entry per line in the document. An empty string is a blank line the writer put there. */
  paragraphs: string[];
  /** True when the document was longer than MAX_CHARS and the tail was dropped. */
  truncated: boolean;
};

/**
 * A CV is a page or three. This ceiling exists only so a mislabelled 40MB archive cannot turn one
 * preview into a response nothing can paint — not because any real CV comes near it.
 */
const MAX_CHARS = 250_000;

export class NotALegacyDocError extends Error {
  constructor() {
    super("These bytes are not a Word 97-2003 (.doc) document.");
    this.name = "NotALegacyDocError";
  }
}

/**
 * Reads a Word 97-2003 binary .doc into the lines a reader sees, in order.
 *
 * Throws NotALegacyDocError when the bytes are not OLE2 — the caller has the bytes and has already
 * decided, so reaching here with a .docx is a wiring mistake and must not be papered over with an
 * empty result that would read on screen as "this CV is blank".
 */
export async function extractLegacyDocText(bytes: Buffer): Promise<LegacyDocText> {
  if (!isLegacyDocBytes(bytes)) throw new NotALegacyDocError();

  // Dynamically imported so word-extractor (a Node-only OLE reader) is pulled in only by the one
  // request that needs it, rather than by every route that serves a recruitment file.
  const { default: WordExtractor } = await import("word-extractor");
  const document = await new WordExtractor().extract(bytes);

  // TEXT BOXES ARE READ AS WELL AS THE BODY, and that is not tidiness. In a binary .doc a text box
  // lives in its own stream, so a CV that puts the name, phone and email in a box down the side —
  // a common 2000s Word template — has NONE of that in the body. Appended after it rather than
  // merged in place, because the format records no way to know where on the page the box sat.
  const body = document.getBody() ?? "";
  const boxes = (document.getTextboxes() ?? "").trim();

  const combined = boxes ? `${body}\n\n${boxes}` : body;
  const truncated = combined.length > MAX_CHARS;

  return { paragraphs: legacyDocLines(truncated ? combined.slice(0, MAX_CHARS) : combined), truncated };
}

/**
 * Word's own line breaks into the lines to paint. Exported because it is the whole of the shaping
 * and it is pure — the OLE reader above needs a real Word file to say anything, this does not
 * (tests/legacy-doc-cv-preview.test.ts).
 *
 * word-extractor has already mapped the format's control characters (filters.js): every flavour of
 * break becomes "\n" and a table cell boundary becomes a tab. What is left to do is make the shape
 * readable: normalise the line ending, drop the control characters that survive in an old file,
 * keep ONE blank line where the writer left any number of them, and trim the run of blanks at each
 * end so the page does not open on empty space.
 */
export function legacyDocLines(text: string): string[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    // Everything below space except the tab, which carries the only structure a table has here.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""));

  const paragraphs: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (paragraphs.length === 0) continue; // no leading blanks
      if (paragraphs[paragraphs.length - 1] === "") continue; // never two in a row
      paragraphs.push("");
      continue;
    }
    paragraphs.push(line);
  }
  while (paragraphs.length > 0 && paragraphs[paragraphs.length - 1] === "") paragraphs.pop();
  return paragraphs;
}
