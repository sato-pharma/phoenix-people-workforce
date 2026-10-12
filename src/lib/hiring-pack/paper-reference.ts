// THE REFERENCE NUMBER EVERY PRINTED PAPER CARRIES — "make sure every paper and document is auto
// numbered" (the owner, 2026-09-13).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE NUMBER COMES FROM THE DATABASE, never from this file. A counter in the browser or in a server
// process restarts, and two papers carrying one number are worse than two carrying none. The
// register (`hiring_pack_paper_register`, see paper-register-store.ts) hands out the next one; this
// module only knows what one looks like and where it goes on the page.
//
// WHERE IT GOES. Every house paper opens with the company's name block — `.lh__id` from
// `houseLetterhead`, or `.doc-mast__id` on the papers that draw their own masthead. The number is
// written as one more line under that name, in the muted ink the block already uses, so it reads as
// part of the letterhead rather than as something stamped over it. Where the masthead sits in a
// repeating table header it repeats on every page, which is the point. The contract's first page has
// a title masthead instead, and the number goes under its subtitle. A paper in the HR premium
// identity (`premium-identity.ts`) carries an empty `.pm-mast__ref` slot at the end of its masthead's
// name line, and the number is written into it — on that line, so it adds no height to a paper set to
// its last millimetre, and on every page the masthead repeats on.
//
// A PAPER WITH NO MASTHEAD (an uploaded company template) gets a small line fixed to the bottom
// corner. Chromium repeats a fixed element on every printed page, so it too is numbered throughout.
//
// THE AUTHORITY'S OWN FORMS ARE NEVER WRITTEN ON. `paperReferencePrintsOnFace` says which; for those
// the number is issued and kept in the register only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { paperReferencePrintsOnFace } from "@/lib/hiring-pack/forms-drive";
import type { PrintableDocument } from "@/lib/hiring-pack/document-registry";

/** `HR-2026-000123`: the prefix, the year it was issued, and a six-digit running number. */
export const PAPER_REFERENCE_PATTERN = /^HR-\d{4}-\d{6,}$/;

export function isPaperReference(value: unknown): value is string {
  return typeof value === "string" && PAPER_REFERENCE_PATTERN.test(value);
}

/** The line printed on the paper. Arabic label, the number itself held left-to-right. */
export function paperReferenceText(reference: string): string {
  return `رقم المرجع: ${reference}`;
}

const REFERENCE_CLASS = "hp-ref";

/**
 * The stylesheet the stamp needs. Text only — no fill, no box — so the ink rule holds.
 *
 * `unicode-bidi: isolate` on the number is what keeps "HR-2026-000123" reading left to right inside
 * an Arabic line; without it the hyphens are neutral and the groups come out reversed.
 */
export const PAPER_REFERENCE_CSS = `
  .${REFERENCE_CLASS} { display: block; margin-top: .6mm; color: #64748b; font-size: 6.5pt; font-weight: 600; line-height: 1.4; }
  .${REFERENCE_CLASS} bdi { unicode-bidi: isolate; direction: ltr; letter-spacing: .02em; }
  .${REFERENCE_CLASS}--fixed { position: fixed; bottom: 3mm; left: 4mm; margin: 0; z-index: 5; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function referenceMarkup(reference: string, tag: "span" | "p" | "div", extraClass = ""): string {
  const className = extraClass ? `${REFERENCE_CLASS} ${extraClass}` : REFERENCE_CLASS;
  return `<${tag} class="${className}" data-hp-ref="${escapeHtml(reference)}">رقم المرجع: <bdi>${escapeHtml(reference)}</bdi></${tag}>`;
}

/** The company name block on `houseLetterhead` papers. */
const LETTERHEAD_ID = /(<div class="lh__id"><strong>[^<]*<\/strong>(?:<span dir="ltr">[^<]*<\/span>)?)/g;
/** The company name block on the papers that draw their own masthead. */
const MAST_ID =
  /(<span class="doc-mast__side doc-mast__id">\s*<strong>[^<]*<\/strong>\s*(?:<span dir="ltr">[^<]*<\/span>)?)/g;
/** The contract's first-page title block. */
const MASTHEAD_TITLE = /(<div class="masthead__title">\s*<h1>[^<]*<\/h1>\s*(?:<p>[^<]*<\/p>)?)/g;
/** The HR premium masthead's reference slot on its name line — empty, so it takes no space until a number is written. */
const PREMIUM_SLOT = /(<span class="pm-mast__ref" dir="rtl">)(<\/span>)/g;

/**
 * The paper with its reference number written on it.
 *
 * Returns the html UNCHANGED for an official form, for a malformed reference, and when the number is
 * already on it — stamping twice would print two lines, and a reprint of a stamped page is possible.
 */
export function stampPaperReference(
  html: string,
  reference: string | null,
  document: PrintableDocument,
): string {
  if (!reference || !isPaperReference(reference)) return html;
  if (!paperReferencePrintsOnFace(document)) return html;
  if (html.includes(`data-hp-ref="`)) return html;

  let placed = 0;
  let stamped = html.replace(LETTERHEAD_ID, (match) => {
    placed += 1;
    return `${match}${referenceMarkup(reference, "span")}`;
  });
  stamped = stamped.replace(MAST_ID, (match) => {
    placed += 1;
    return `${match}${referenceMarkup(reference, "span")}`;
  });
  stamped = stamped.replace(MASTHEAD_TITLE, (match) => {
    placed += 1;
    return `${match}${referenceMarkup(reference, "p")}`;
  });
  stamped = stamped.replace(PREMIUM_SLOT, (_match, open: string, close: string) => {
    placed += 1;
    return `${open}${referenceMarkup(reference, "span")}${close}`;
  });

  const fixed = placed === 0 ? referenceMarkup(reference, "div", `${REFERENCE_CLASS}--fixed`) : "";
  const style = `<style data-hp-ref-style>${PAPER_REFERENCE_CSS}</style>`;

  stamped = stamped.includes("</head>")
    ? stamped.replace("</head>", `${style}</head>`)
    : `${style}${stamped}`;
  if (fixed) {
    stamped = stamped.includes("</body>")
      ? stamped.replace("</body>", `${fixed}</body>`)
      : `${stamped}${fixed}`;
  }
  return stamped;
}

/**
 * The same stamp, applied to a document already open in a frame on screen.
 *
 * The paper editor and the manual workspace print the page they are SHOWING — with every edit typed
 * onto it — so the number has to be written into that live document rather than into a fresh render
 * that would lose the edits. Same placement rules as `stampPaperReference`, by construction: both
 * read the same four blocks.
 */
export function stampPaperReferenceInDocument(
  doc: Document,
  reference: string | null,
  document: PrintableDocument,
): void {
  if (!reference || !isPaperReference(reference)) return;
  if (!paperReferencePrintsOnFace(document)) return;

  // A reprint of the same open page: replace the old number rather than adding a second line.
  doc.querySelectorAll(`[data-hp-ref]`).forEach((node) => node.remove());

  if (!doc.querySelector("style[data-hp-ref-style]")) {
    const style = doc.createElement("style");
    style.setAttribute("data-hp-ref-style", "");
    style.textContent = PAPER_REFERENCE_CSS;
    (doc.head ?? doc.documentElement).appendChild(style);
  }

  const make = (tag: "span" | "p" | "div", extraClass?: string) => {
    const node = doc.createElement(tag);
    node.className = extraClass ? `${REFERENCE_CLASS} ${extraClass}` : REFERENCE_CLASS;
    node.setAttribute("data-hp-ref", reference);
    node.setAttribute("contenteditable", "false");
    node.append(doc.createTextNode("رقم المرجع: "));
    const number = doc.createElement("bdi");
    number.textContent = reference;
    node.append(number);
    return node;
  };

  const blocks = doc.querySelectorAll(".lh__id, .doc-mast__id, .pm-mast__ref");
  blocks.forEach((block) => block.appendChild(make("span")));
  const titles = doc.querySelectorAll(".masthead__title");
  titles.forEach((block) => block.appendChild(make("p")));

  if (blocks.length === 0 && titles.length === 0) {
    doc.body?.appendChild(make("div", `${REFERENCE_CLASS}--fixed`));
  }
}
