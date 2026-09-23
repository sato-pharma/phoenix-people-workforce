/**
 * Sato composer — "build the email out of this document".
 *
 * Owner 2026-09-23: "i want to have an option to for example upload pdf and the system absorb and
 * extract the data from the pdf and make it as email". He attached the Semester 2 2026 incentive
 * policy — three pages, a curve table, a worked example — and wants the announcement that carries
 * it written from the paper itself rather than retyped.
 *
 * This module is the PURE half: which files are accepted, how big they may be, what the words read
 * out of one look like once the page furniture is gone, and whether the file could be read at all.
 * It is imported by the browser (the composer's accept list) as well as the server, so it must stay
 * free of pdf-parse, mammoth and the OpenAI client — those live in `read-source-document.ts`.
 *
 * `countReadableCharacters` is borrowed from the recruitment text-layer module rather than written
 * again here: it is pure, it is Unicode-aware, and an Arabic policy must not score zero the way a
 * \w-based count would. The threshold it feeds answers the same question there and here — is there
 * enough text in this PDF to work from, or is it a photograph wearing a .pdf.
 */

import { countReadableCharacters } from "@/lib/recruitment/cv-text-layer";

export type SatoSourceKind = "pdf" | "word" | "html" | "text" | "picture" | "unsupported";

/**
 * How the document reached the model: its words, or the file itself.
 *
 * `text` — pdf-parse, mammoth or a plain decode recovered the words, and every figure in the draft
 * can be checked against them. `picture` — a scan, a photograph or a PDF with no text layer: the
 * file goes to the model whole, and nothing in the draft can be checked against anything, which is
 * said out loud on screen instead of being quietly skipped.
 */
export type SatoSourceRoute = "text" | "picture";

/**
 * 10 MB, the same ceiling as an attachment. Not a model limit — a sender limit: a document bigger
 * than this is a catalogue, and an email built from one is a document, not an email.
 */
export const SATO_EMAIL_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** What the file picker offers. Wider than what can be READ is a refusal the sender never sees. */
export const SATO_EMAIL_DOCUMENT_ACCEPT =
  ".pdf,.doc,.docx,.html,.htm,.txt,.csv,.md,.jpg,.jpeg,.png,.webp," +
  "application/pdf,application/msword," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "text/html,text/plain,text/csv,text/markdown,image/jpeg,image/png,image/webp";

/**
 * How many characters of the document the assistant reads.
 *
 * The incentive policy that prompted this is 5,078 characters across three pages, so this is about
 * fourteen pages of the same density — past any announcement and short of a token bill nobody
 * asked for. Longer documents are cut at a paragraph boundary and the sender is told, never
 * silently shortened.
 */
export const SATO_EMAIL_SOURCE_MAX_CHARS = 24_000;

/**
 * Below this many letters and digits a PDF is treated as a picture and sent to the model whole.
 * Same number, same reasoning as the CV intake: a real document runs to thousands, and the failure
 * it catches is a scan that answered with a page marker and nothing else.
 */
export const MIN_SOURCE_TEXT_CHARS = 200;

export function detectSatoSourceKind(contentType: string, fileName: string): SatoSourceKind {
  const mime = (contentType || "").toLowerCase();
  const name = (fileName || "").toLowerCase();
  if (mime.includes("pdf") || name.endsWith(".pdf")) return "pdf";
  if (mime.includes("wordprocessingml") || mime.includes("msword") || name.endsWith(".docx") || name.endsWith(".doc")) {
    return "word";
  }
  if (mime.startsWith("image/") || /\.(jpe?g|png|webp)$/.test(name)) return "picture";
  // Before the text branch, because HTML IS text/* and a plain decode of it hands the model
  // tag soup — every style rule, every table attribute, and the words buried inside them.
  if (mime.includes("html") || /\.x?html?$/.test(name)) return "html";
  // Deliberately last: a .csv can arrive as application/vnd.ms-excel, and a .md as text/markdown,
  // octet-stream or nothing at all. The extension decides when the label is useless.
  if (mime.startsWith("text/") || mime.includes("csv") || /\.(txt|csv|md|markdown|log)$/.test(name)) return "text";
  return "unsupported";
}

/** The page furniture pdf-parse leaves behind: `-- 2 of 3 --` between every page. */
const PAGE_MARKER = /^[ \t]*-{2,}\s*\d+\s+of\s+\d+\s*-{2,}[ \t]*$/gim;

/**
 * The words of a document, ready to be read by something that cannot see the page.
 *
 * Nothing here rewrites: it removes what the READER added — page markers, the blank lines a
 * repeated footer leaves, the zero-width and direction characters a Word export scatters through
 * Arabic — and nothing else. The length cut is `capSourceText`, kept separate so the caller can
 * tell the sender his document was long, rather than silently shortening it.
 */
export function tidySourceText(raw: string): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(PAGE_MARKER, "")
    // Zero-width and bidi-control characters. A Word or PDF export scatters them through Arabic,
    // where they are invisible on the page and pure noise in a prompt.
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * How much of a long document the assistant reads, cut at a paragraph boundary.
 *
 * Never an ellipsis — the owner's standing rule — and never silent: `truncated` is what puts the
 * "only the first part was used" line on screen.
 */
export function capSourceText(text: string): { text: string; truncated: boolean } {
  const value = String(text ?? "");
  if (value.length <= SATO_EMAIL_SOURCE_MAX_CHARS) return { text: value, truncated: false };
  const head = value.slice(0, SATO_EMAIL_SOURCE_MAX_CHARS);
  const paragraphEnd = head.lastIndexOf("\n");
  return {
    text: (paragraphEnd > SATO_EMAIL_SOURCE_MAX_CHARS / 2 ? head.slice(0, paragraphEnd) : head).trim(),
    truncated: true,
  };
}

/**
 * A web page, or a saved email, read as the words a person would see on it.
 *
 * Owner 2026-09-23: "me able also to the system absorb uploaded html and write email from" — the
 * thing he uploads is most often an email this composer itself produced, or a page someone sent
 * him. A plain utf8 decode of one is tag soup: the whole house stylesheet arrives before the
 * first word, and a 6 KB announcement reads as 40 KB of attributes the model then has to ignore.
 *
 * Done here with string work rather than a parser on purpose. This module is imported by the
 * BROWSER for the composer's accept list, so it must stay free of dependencies, and the job is
 * narrower than parsing: the output is never rendered, never trusted as markup and never sent
 * anywhere — it is prompt text. Anything ambiguous therefore drops out rather than being guessed
 * at, and the tag stripper runs LAST, after the blocks that carry meaning have become newlines.
 *
 * 🔴 A TABLE HAS TO SURVIVE AS A GRID. The instructions tell the assistant that a table in the
 * document arrives as a table in the email, and it can only obey that if the rows still look like
 * rows: cells are joined with " | " and each row ends at a newline. Flatten a rate card into one
 * long sentence here and no prompt rule downstream can put it back.
 */
export function htmlToSourceText(raw: string): string {
  return String(raw ?? "")
    // Script, style and head hold no words a reader ever sees. They go first, contents and all,
    // because stripping their tags alone would leave the CSS itself standing as body text.
    .replace(/<(script|style|head|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // An image is a word the reader can see, and in a house email the alt text is the only
    // description of it there is.
    .replace(/<img\b[^>]*\balt\s*=\s*"([^"]+)"[^>]*>/gi, "$1")
    // The cell separator goes on the CLOSING tag: an opening <td> may carry a style attribute
    // longer than the cell's own contents, and the divider belongs between values, not before
    // the first one.
    .replace(/<\/(td|th)\s*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|ul|ol|table|thead|tbody|section|blockquote)\s*>/gi, "\n")
    .replace(/<(hr|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // Entities last, so a &lt; that was text in the page cannot become a tag the stripper above
    // would then eat along with everything after it.
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos|middot|mdash|ndash|hellip|rsquo|lsquo|ldquo|rdquo);/gi, (entity) => {
      const table: Record<string, string> = {
        amp: "&", apos: "'", gt: ">", hellip: "…", lt: "<", ldquo: "\u201c", lsquo: "\u2018",
        mdash: "—", middot: "·", nbsp: " ", ndash: "–", quot: '"', rdquo: "\u201d", rsquo: "\u2019",
        "#39": "'",
      };
      return table[entity.slice(1, -1).toLowerCase()] ?? entity;
    })
    .replace(/&#(\d{1,6});/g, (whole, code) => {
      const point = Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    // A row that ended in a cell divider now reads "… | \n". The divider was between cells, and
    // there is no next cell.
    .replace(/\|\s*(?=\n|$)/g, "")
    .replace(/[ \t]*\|[ \t]*/g, " | ");
}

/**
 * Words, or the file itself? A picture is a picture whatever it is wrapped in, and a PDF whose text
 * layer holds less than a paragraph is one of those in disguise.
 */
export function chooseSourceRoute(input: { kind: SatoSourceKind; text: string }): SatoSourceRoute {
  if (input.kind === "picture") return "picture";
  if (input.kind === "pdf" && countReadableCharacters(input.text) < MIN_SOURCE_TEXT_CHARS) return "picture";
  return "text";
}

/** Thousands separated, because a sender reads "5,078 characters" and skims "5078". */
function groupDigits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

/**
 * The one line the sender reads to know what the assistant actually had in front of it. It names
 * the file, so a draft built from yesterday's upload cannot be mistaken for today's.
 */
export function describeSourceRead(input: {
  characters: number;
  fileName: string;
  route: SatoSourceRoute;
  truncated: boolean;
}): string {
  const name = input.fileName.trim() || "the file";
  if (input.route === "picture") {
    return `Read ${name} as a picture — there is no text in the file, so the page itself was used.`;
  }
  const read = `Read ${name} — ${groupDigits(input.characters)} characters of text.`;
  return input.truncated
    ? `${read} Only the first part was used, so check that nothing later in the document is missing.`
    : read;
}

/**
 * A document the sender uploaded, in the shape the assistant reads it.
 *
 * Declared in this pure module rather than beside the assistant so the reader, the route, the test
 * and the browser all name the same thing — and so nothing that only needs the SHAPE has to import
 * pdf-parse to get it.
 */
export type SatoAssistSource = {
  /** Picture route only: the file itself, base64, handed to the model whole. */
  file?: { contentType: string; data: string };
  fileName: string;
  route: SatoSourceRoute;
  /** The words read out of the file. Empty on the picture route, and only there. */
  text: string;
};
