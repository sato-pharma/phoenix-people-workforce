// The two things an operator can drop onto an HR paper that are pictures rather than words: the
// company stamp and the signature.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, AND HOW IT SITS WITH THE RULING THAT CAME BEFORE IT.
//
// On 2026-09-29 the owner had the seal removed from every hiring renderer — `house-identity.ts`
// records the reason in his own terms: a document that arrives pre-stamped is a document NOBODY
// stamped, and the clearance certificate's own clause requiring it to be stamped بختم الشركة stops
// being a control the moment the stamp prints itself. That ruling stands, unchanged, and this module
// does not touch it: NO RENDERER DRAWS A MARK OF ITS OWN ACCORD. There is no default placement, no
// per-document table of seal positions, and nothing here runs unless a person put a mark on a page.
//
// Later the same day he asked for the other half — "the option to add the Sato stamp seal and my
// signature and be able to move and drag them freely in any form". That is not the thing the ruling
// forbade. It is a deliberate act, on one paper, by the person who is entitled to stamp it: the mark
// is a FIELD-LAYER ROW like every other, placed by hand, stored against that document and template
// version, visible in the field table, draggable, and deletable. The distinction the ruling actually
// draws is between a stamp that appears because the renderer always draws one and a stamp that
// appears because somebody put it there, and only the first is a stamp nobody applied.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 🔒 A MARK BELONGS TO THE FORM, NOT TO ONE EMPLOYEE — owner's ruling, 2026-09-29, asked in writing
// and answered "keep the stamp per form, not per employee".
//
// A row is stored against the document and its template VERSION with `employee_hr_id` null, exactly
// like every other field-layer row. So a stamp dropped on the contract prints on every contract
// drawn from that version, not only on the one that was on screen when it was placed. He was shown
// that consequence in those words before he ruled, because it sits close to the pre-stamped failure
// he had corrected hours earlier — and it is still not that failure: the paper carries a seal
// because he put one there, and one click takes it off again.
//
// The table already has the `employee_hr_id` column, so a per-employee mark is buildable. Do NOT
// build it, and do not re-raise it: the decision is his and it is recorded here. It would also
// change what "add it to any form" means, which is the thing he actually asked for.
//
// 🔒 AND THE SIGNATURE STAYS THE SUPER ADMIN'S TO PLACE — same day, same question, answered "keep
// the signature super admin only". The gate is in `app/api/hiring-pack/document-fields/route.ts`,
// beside the one on the signature image itself. Do not widen it to `employee_documents:update` to
// let HR Operations sign a contract they are preparing; that was the alternative he was offered.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE ARTWORK IS A DATA URI AND NEVER A PATH, for BOTH marks.
//
// The signature has no choice: a signature image reachable at a URL is a forgery kit, which is why
// `spotlight/cheque-signature.ts` keeps the CEO's in a PRIVATE bucket and why this keeps the HR one
// the same way. It leaves the server only inside a rendered document.
//
// The stamp could have been emitted as `src="/brand/sato-hr-seal.svg"` and left to
// `paper-artwork.ts`'s inliner, which already allow-lists that path. It is not, for one reason: the
// filing path hands the HTML to Chromium through `setContent`, which gives the page no origin, so a
// root-relative path resolves to nothing and the image silently does not load. That failure mode is
// already documented at the top of `paper-artwork.ts` and it is the worst one available here — a
// paper filed as signed, with the stamp missing and nothing saying so. Two mechanisms for two marks
// would mean the signature was safe from it and the stamp was not; one mechanism means neither is.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A MARK WITH NO ARTWORK PRINTS NOTHING — never a box, never a placeholder, never alt text. That is
// the same answer the field layer already gives a value the employee's record does not have, and it
// is the only safe one: a signature that could not be read must leave the paper UNSIGNED so a human
// signs it, not leave a grey rectangle that reads as one at a glance.

// NOTHING IN THIS FILE READS A FILE OR A BUCKET, and that is a constraint rather than a
// coincidence: `paper-editor.tsx` is a "use client" component and imports the vocabulary, the
// labels and the default sizes below. A `node:fs` import here would put the seal's reader into the
// browser bundle and break the build. The two readers live next door —
// `document-mark-artwork.ts` for the seal on disk, `hr-signature.ts` for the signature in its
// private bucket — and both are reached only from the server.

import type { DocumentFieldRow } from "@/lib/hiring-pack/field-layout";

/** The marks a paper can carry. Two, and adding a third is a deliberate edit in four places. */
export const DOCUMENT_MARKS = ["stamp", "signature"] as const;

export type DocumentMark = (typeof DOCUMENT_MARKS)[number];

export function isDocumentMark(value: unknown): value is DocumentMark {
  return typeof value === "string" && (DOCUMENT_MARKS as readonly string[]).includes(value);
}

/** What each mark is called on the screen that places it, and in the field list afterwards. */
export const DOCUMENT_MARK_LABELS: Readonly<Record<DocumentMark, string>> = {
  stamp: "Company stamp",
  signature: "Signature",
};

/**
 * A sensible first size for each mark, in points — the size it lands at before anyone drags it.
 *
 * Square for the seal because the artwork is round; wider than it is tall for a signature because a
 * handwritten name is. Neither is a constraint: both are resized freely afterwards, and the numbers
 * only decide what the first drop looks like rather than what any stored mark is.
 */
export const DOCUMENT_MARK_DEFAULT_SIZE: Readonly<Record<DocumentMark, { w: number; h: number }>> = {
  stamp: { w: 96, h: 96 },
  signature: { w: 130, h: 46 },
};

/** Every mark's artwork, or null for one that could not be read. */
export type MarkArtwork = Readonly<Record<DocumentMark, string | null>>;

export const NO_MARK_ARTWORK: MarkArtwork = { stamp: null, signature: null };

/** Whether any row in a layout is a mark at all — the question that decides if a bucket read runs. */
export function layoutUsesMark(rows: readonly DocumentFieldRow[], mark: DocumentMark): boolean {
  return rows.some((row) => !row.hidden && row.source.kind === "mark" && row.source.mark === mark);
}

/** Which marks a layout has a position for — what the print dialog is allowed to offer. */
export function marksPlacedOn(rows: readonly DocumentFieldRow[]): DocumentMark[] {
  return DOCUMENT_MARKS.filter((mark) => layoutUsesMark(rows, mark));
}

/**
 * WHICH MARKS THIS PRINT ASKED FOR. Absent means NONE, and that default is the whole feature.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A PLACED MARK IS NOT A PRINTED MARK. The owner, 2026-09-29, after seeing the first version:
 * "donot put the stamp permanent, make able to add them freely as i want" — and then, choosing
 * between three designs, the print dialog. A layout row says WHERE the seal goes on this paper; it
 * does not say that this paper is stamped. The stamping is decided per print, in the same box that
 * already asks how many copies and which address, and it starts unticked every time.
 *
 * That is also what keeps faith with the ruling earlier the same day. A document that arrives
 * pre-stamped is a document nobody stamped; with this, a stamp appears only because somebody ticked
 * it for this run of this paper, which is as close to pressing a real stamp as software gets.
 *
 * UNKNOWN NAMES ARE DROPPED, NOT REFUSED. This arrives as a query string, so it is whatever a URL
 * contained. A name this build does not know cannot be drawn, and refusing the whole print because
 * of one bad word would take out the paper somebody needs today for a parameter they never typed.
 */
export function parseMarkSelection(raw: string | null | undefined): Set<DocumentMark> {
  if (!raw) return new Set();
  const asked = raw
    .split(",")
    .map((part) => part.trim())
    .filter(isDocumentMark);
  return new Set(asked);
}

/**
 * The same rows, with each mark row carrying the artwork it prints.
 *
 * `src` is a RENDER-TIME field and is never stored: the database row says WHICH mark, and what that
 * mark looks like is decided by the seal in this build and the signature in the bucket at the moment
 * the paper is drawn. Storing the image on the row would freeze a signature into a layout, so
 * replacing it would leave every previously placed one printing the old one.
 *
 * Rows that are not marks come back untouched and by reference — this runs on every render of every
 * paper, and the overwhelming majority of layouts contain no mark at all.
 */
export function withMarkArtwork(
  rows: readonly DocumentFieldRow[],
  artwork: MarkArtwork,
): DocumentFieldRow[] {
  return rows.map((row) =>
    row.source.kind === "mark"
      ? { ...row, source: { ...row.source, src: artwork[row.source.mark] } }
      : row,
  );
}
