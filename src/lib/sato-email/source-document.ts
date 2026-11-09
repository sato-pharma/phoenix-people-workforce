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
 * How the document reached the email: its words, the file itself, or neither.
 *
 * `text` — pdf-parse, mammoth or a plain decode recovered the words, and every figure in the draft
 * can be checked against them. `picture` — a scan, a photograph or a PDF with no text layer: the
 * file goes to the model whole, and nothing in the draft can be checked against anything, which is
 * said out loud on screen instead of being quietly skipped.
 *
 * 🔴 `verbatim` — THE FILE IS ALREADY AN EMAIL, AND NOTHING REWRITES IT. Owner, 2026-09-23, after
 * an HTML upload came back rewritten: "when i did with html its lost its design an became awful
 * design", then "i donot whant ai to rewrite it i want to make as as it is exactly". A PDF has to
 * be read and turned into an email because a PDF is not one. An HTML file already is: its
 * headings, its bold, its tables and its order ARE the design, and putting it through a model that
 * writes a fresh announcement out of its words throws every one of those away — which is the whole
 * of what he saw. On this route the model call does not happen at all.
 */
export type SatoSourceRoute = "text" | "picture" | "verbatim";

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
  // Before the text branch, because HTML IS text/*, and an HTML file is not a document to be read
  // and rewritten — it is already an email, and it takes the verbatim route below.
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
    .replace(/[​-‏‪-‮﻿]/g, "")
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
 * The inside of an uploaded HTML file, ready to go into the editor UNCHANGED.
 *
 * 🔴 NOTHING HERE REWRITES, TRANSLATES, SUMMARISES OR RE-ORDERS — that is the entire point of this
 * route. Owner, 2026-09-23: "i donot whant ai to rewrite it i want to make as as it is exactly",
 * after the first build flattened his file to words and let the model write a fresh announcement
 * out of them: "when i did with html its lost its design an became awful design". Every step below
 * either drops what a mail client would refuse to run, or takes off a frame the renderer is about
 * to put back on. Never add a step here that changes what a reader sees.
 *
 * String work rather than a parser because this module is imported by the BROWSER for the accept
 * list and has to stay dependency-free. The safety gate is downstream and unchanged:
 * `prepareSatoEmailBody` runs `sanitizeEmailTemplateHtml` over whatever comes out of here, exactly
 * as it does over anything the sender types, so an unknown tag or a stray attribute is dropped
 * there rather than trusted here.
 */
export function htmlDocumentBody(raw: string): string {
  let whole = String(raw ?? "");
  // Until nothing more comes off: one pass over `<scr<script></script>ipt>…` (or a comment split
  // the same way) leaves a whole new one behind, joined from the pieces either side of the cut.
  // A real file is finished in the first pass, so the second only confirms it.
  for (let previous = ""; previous !== whole; ) {
    previous = whole;
    whole = whole
      // A mail client runs neither, and Outlook prints an unrecognised <style> block as text. They
      // go with their contents: stripping the tags alone would leave the stylesheet as a paragraph.
      .replace(/<(script|style|head|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!doctype[^>]*>/gi, "");
  }
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(whole);
  return unwrapSatoEmailFrame((body ? body[1] : whole).trim());
}

/**
 * 🔴 THE FRAME IS PRINTED ONCE. What he uploads is most often an email this composer itself
 * produced, and the masthead, the brand rule, the title, the sign-off and the colophon are already
 * inside that file. Put it into the editor whole and the renderer wraps a second frame around the
 * first — two mastheads, two logos, two colophons, one nested in the other. So an uploaded house
 * email is cut back to its MESSAGE, and the frame around it is the one the renderer adds.
 *
 * Two anchors, both read off a real rendered email. `class="sato-message"` is the marker the
 * renderer puts on that cell from 2026-09-23. The style signature is the SAME cell before the
 * marker existed — which is every email sent before that date, including the one he was holding
 * when he reported this.
 *
 * A file carrying neither anchor is not a house email and comes back untouched.
 */
export function unwrapSatoEmailFrame(html: string): string {
  const value = String(html ?? "");
  const opening =
    /<td[^>]*class="[^"]*\bsato-message\b[^"]*"[^>]*>/i.exec(value) ??
    /<td[^>]*style="padding:22px 0 0 0;font-size:16px;line-height:27px;[^"]*"[^>]*>/i.exec(value);
  if (!opening) return value;

  // Walk to the cell's OWN closing tag. A message holding a table holds nested <td>s, and the
  // first </td> after the opening belongs to one of those, not to the message.
  const start = opening.index + opening[0].length;
  const boundary = /<(\/?)td\b[^>]*>/gi;
  boundary.lastIndex = start;
  let depth = 1;
  let step = boundary.exec(value);
  while (step) {
    depth += step[1] ? -1 : 1;
    if (depth === 0) return value.slice(start, step.index).trim();
    step = boundary.exec(value);
  }
  // Unbalanced markup: better the whole file than a message cut off mid-sentence.
  return value;
}

/**
 * The subject an uploaded email already carries.
 *
 * `<title>` is where the renderer writes the subject, so a house email hands its own subject back
 * unchanged. A page with no title falls to its first heading, and a file with neither gives an
 * empty string — which leaves whatever the sender typed in the subject field alone.
 */
export function htmlDocumentSubject(raw: string): string {
  const value = String(raw ?? "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(value);
  return (title?.[1] ?? heading?.[1] ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    // LAST, so a title that says `&amp;lt;` reads as the text `&lt;`, never as a second decode.
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Words, the file itself, or neither?
 *
 * A picture is a picture whatever it is wrapped in, and a PDF whose text layer holds less than a
 * paragraph is one of those in disguise. HTML takes neither route: it is already an email, so it
 * goes into the editor as it is and never reaches the model.
 */
export function chooseSourceRoute(input: { kind: SatoSourceKind; text: string }): SatoSourceRoute {
  if (input.kind === "html") return "verbatim";
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
  // 🔴 Say it plainly, because it is the opposite of what the other two routes do and the sender
  // has been burnt by the difference: this file was NOT rewritten.
  if (input.route === "verbatim") {
    return `Loaded ${name} exactly as it is — its own wording, layout and tables, with nothing rewritten.`;
  }
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
  /**
   * The words read out of the file. Empty on the picture route, and only there.
   *
   * On the verbatim route this is the file's own MARKUP, not its words: it goes into the editor,
   * not into a prompt.
   */
  text: string;
  /** Verbatim route only: the subject the uploaded email already carried, if it carried one. */
  subject?: string;
};
