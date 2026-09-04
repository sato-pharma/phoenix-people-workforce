// Where a confirmed paper is filed, and what it is called when it gets there.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PURE ON PURPOSE. Everything here is a decision about rows somebody else fetched, so the rules can
// be pinned by a test without a database. The reads live in `paper-filing-store.ts` and the writing
// lives in the route; this file only ever answers "given these slots, where does this paper go, and
// what should the file be called".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A REFUSAL IS AN ANSWER, NOT AN ERROR. Every path that cannot file returns a reason written for
// the person who will read it on screen, because all of them are ordinary states rather than
// faults: a company template that has not been pointed at a slot, a slot somebody retired, a paper
// nobody has linked yet. Throwing here would turn "this template does not file anywhere" into a red
// banner over a signature that was recorded perfectly well.
//
// The one thing this must never do is pick a slot it is not sure about. Filing an employment
// contract into the wrong drawer is worse than not filing it, because the second is visible and the
// first is not.

/**
 * A checklist slot, as much of it as any decision here needs.
 *
 * `hiring_pack_document` is the pinned link added by 20260904234000 — NOT the slot's name. The name
 * is admin-editable free text and matching on it would stop the filing the day somebody tidied a
 * label, with nothing anywhere to say why.
 */
export type FilingSlotRow = {
  id: string;
  name: string;
  is_active: boolean;
  hiring_pack_document: string | null;
};

/** Where a paper goes, or why it does not go anywhere. */
export type FilingDecision =
  | { filed: true; definitionId: string; slotName: string }
  | { filed: false; why: string };

/**
 * The seven papers whose signature the app records, and which therefore have a moment to file at.
 *
 * DELIBERATELY NOT DERIVED FROM `SIGNABLE_DOCUMENTS`. It would be the same seven today, and the two
 * lists answer different questions: that one is "can a signed date be recorded", this one is "is
 * there a filing rule for it". A document could gain a recorded date and want no file — the worker
 * data form and the custody receipts already sit in that shape for the opposite reason. Keeping
 * them apart means adding one never silently changes the other; the test asserts they agree today.
 */
export const FILEABLE_BUILT_IN_DOCUMENTS = [
  "contract",
  "form1",
  "form6",
  "resignation",
  "mutualTermination",
  "clearanceEmployee",
  "clearanceCompany",
] as const;

export type FileableBuiltInDocument = (typeof FILEABLE_BUILT_IN_DOCUMENTS)[number];

const FILEABLE = new Set<string>(FILEABLE_BUILT_IN_DOCUMENTS);

/** Whether this paper has a filing rule at all. A custody receipt does not, by design. */
export function isFileableBuiltIn(document: string): document is FileableBuiltInDocument {
  return FILEABLE.has(document);
}

/**
 * The slot a built-in paper files into, read off the pinned column.
 *
 * A RETIRED SLOT IS REFUSED RATHER THAN REVIVED. `attachHiringDocumentFiles` already refuses an
 * inactive definition — "That hiring document is no longer on the checklist" — so filing into one
 * would fail deeper down with a message about a checklist the person never mentioned. Answering it
 * here says the true thing at the point somebody can act on it.
 */
export function resolveBuiltInFilingSlot(
  document: string,
  slots: readonly FilingSlotRow[],
): FilingDecision {
  if (!isFileableBuiltIn(document)) {
    return { filed: false, why: "This paper has no filing rule, so it prints without being filed." };
  }

  const slot = slots.find((row) => row.hiring_pack_document === document);
  if (!slot) {
    return {
      filed: false,
      why: "No checklist slot names this paper, so there is nowhere to file it. Point one at it in Hiring Documents.",
    };
  }
  if (!slot.is_active) {
    return {
      filed: false,
      why: `The checklist slot "${slot.name}" is retired, so the paper prints without being filed.`,
    };
  }
  return { definitionId: slot.id, filed: true, slotName: slot.name };
}

/**
 * The slot a company template files into, read off the template's own column.
 *
 * UNSET IS THE NORMAL STATE, not a misconfiguration — every template uploaded before this existed
 * reads as null, and a template nobody signs never needs a slot at all. So the wording says what
 * will happen and how to change it, and says nothing that sounds like a fault.
 */
export function resolveCustomFilingSlot(
  filesUnderDocumentId: string | null,
  slots: readonly FilingSlotRow[],
): FilingDecision {
  if (!filesUnderDocumentId) {
    return {
      filed: false,
      why: "This template does not file anywhere yet. Choose a checklist slot for it in Company templates.",
    };
  }
  const slot = slots.find((row) => row.id === filesUnderDocumentId);
  if (!slot) {
    return {
      filed: false,
      why: "The checklist slot this template files into no longer exists, so the paper prints without being filed.",
    };
  }
  if (!slot.is_active) {
    return {
      filed: false,
      why: `The checklist slot "${slot.name}" is retired, so the paper prints without being filed.`,
    };
  }
  return { definitionId: slot.id, filed: true, slotName: slot.name };
}

/**
 * What the filed PDF is called.
 *
 * THE SIGNED DATE IS IN THE NAME, and it is the date written on the paper rather than the day it
 * was filed — the two differ routinely, which is the whole reason `/sign` takes a date from the
 * caller instead of reading the clock. A folder of these sorts by paper then by the date that
 * actually matters.
 *
 * "(issued)" IS IN THE NAME AS WELL AS IN THE `source` COLUMN. The column is the machine-readable
 * answer and the screen shows it, but a file downloaded to somebody's laptop keeps only its name —
 * and at that point it is a PDF of an employment contract with no signature on it, sitting in a
 * downloads folder. It should say what it is without needing the system that produced it.
 */
export function buildIssuedFileName(input: {
  label: string;
  hrId: string;
  signedDate: string;
}): string {
  const label = input.label.trim() || "Document";
  const hrId = input.hrId.trim().toUpperCase();
  const date = input.signedDate.trim();
  // Anything a file system or a Content-Disposition header would argue about. Not a security
  // control — `buildHiringDocumentFilePath` sanitises the storage key separately — this is so the
  // name survives a download on Windows, where a colon silently truncates the rest of the name.
  const safeLabel = label.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  return `${safeLabel} — ${hrId} — signed ${date} (issued).pdf`;
}
