/**
 * Phoenix CRM — the rep fills in his OWN saved visit's detail, afterwards. No I/O.
 *
 * Owner, 2026-10-15: *"they're working from doctor to doctor and they may not have suitable time to do
 * the full report needed by the company in between the visits … I want them to log the visit as fast as
 * it could be. The most important thing for me is to capture the location while they log the visit, and
 * the time … they can go to the visit, press on it, have those things editable … anything edited, it
 * should appear that this is edited, in the date and time."*
 *
 * ## This is the THIRD visit write, and the first that is the rep's own
 *
 *   - `saveVisit` LOGS the visit — one tap at the door, the location and the time.
 *   - `visit-edit-rules.ts` is the SUPER ADMIN correcting what the rep chose and got wrong: who was on
 *     the visit, the products, the door comment (owner, 2026-10-06). Untouched by this file.
 *   - this one is the REP completing his own report, and it moves a DIFFERENT, non-overlapping set.
 *
 * ## The six things he may change
 *
 *   - THE DETAILED COMMENT — a second, longer account. 🔴 The comment he typed or spoke at the door is
 *     KEPT and is not editable here, by his own instruction: *"the comment which they wrote while they
 *     were doing the visit, leave it and make them able to add another detailed comment."*
 *   - THE OBJECTION and what was said, THE NEXT STEP and the day he means to do it.
 *   - WHAT HE LEFT BEHIND, and THE PHARMACY STOCK answers.
 *   - A PHARMACY NAME the visit does not yet carry — 🔴 ADD-ONLY (his answer, asked directly on
 *     2026-10-15). Naming a pharmacy FILES A VISIT to that pharmacy, so changing or clearing a name
 *     would delete a logged visit, and a visit is evidence.
 *
 * ## What it never touches, and why the fixed half is fixed
 *
 * The customer, the day, the time, the location, the photo and the voice note are the EVIDENCE every
 * figure and integrity check reads. AM/PM is copied from the customer's own list and was never a field
 * the rep chose. Single/double/chain, who was on it, and the products are the Super Admin's to correct.
 * He named the last three himself: *"they will not be able to edit in AM or PM … not whether it's
 * single, double, or chain … not in product discussed."*
 *
 * ## An unknown value is DROPPED, and almost nothing is refused
 *
 * The same rule as `visit-outcome.ts` and `samples.ts`, for a sharper version of the same reason: he is
 * typing this up at the end of a long day, and a chip key from a build one release behind must not cost
 * him the paragraph he just wrote. Only the visit's own id, an over-long detailed comment and a pharmacy
 * name the visit may not take are refused — and the last of those is answered with a sentence, never a
 * silent drop, because he would otherwise believe he had changed it.
 *
 * `server/visit-detail-edit.ts` does the reading and the saving.
 */

import {
  cleanText,
  PHARMACY_NAME_MAX,
  parseProductAvailability,
  type ProductAvailability,
} from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { parseSamplesGiven, type SamplesGiven } from "@/lib/phoenix-crm/samples";
import { parseVisitOutcome, type VisitOutcome } from "@/lib/phoenix-crm/visit-outcome";

/** Twice the door comment's 1,000: this is the long account the door had no time for. */
export const VISIT_DETAIL_COMMENT_MAX = 2000;

export type VisitDetailEdit = {
  visitId: string;
  /** Null when he left it empty, or cleared what he had written. */
  detailComment: string | null;
  outcome: VisitOutcome;
  samplesGiven: SamplesGiven;
  productAvailability: Record<string, ProductAvailability>;
  /** A pharmacy name being ADDED. Null whenever he is not adding one. */
  pharmacyName: string | null;
};

export type VisitDetailParse = { ok: true; value: VisitDetailEdit } | { ok: false; error: string };

/**
 * One edit from the wire.
 *
 * The outcome is folded by `parseVisitOutcome`, which reads the four keys flat exactly as the Add-visit
 * form sends them — so the edit panel and the door form speak the same shape and neither can drift.
 */
export function parseVisitDetailEdit(raw: unknown): VisitDetailParse {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isUuid(body.visitId)) return { ok: false, error: "Reload the page and try again." };

  const detail = typeof body.detailComment === "string" ? body.detailComment.trim() : "";
  if (detail.length > VISIT_DETAIL_COMMENT_MAX) {
    return { ok: false, error: `The detailed comment is longer than ${VISIT_DETAIL_COMMENT_MAX} characters.` };
  }

  return {
    ok: true,
    value: {
      visitId: String(body.visitId).toLowerCase(),
      detailComment: detail || null,
      outcome: parseVisitOutcome(body),
      samplesGiven: parseSamplesGiven(body.samplesGiven),
      productAvailability: parseProductAvailability(body.productAvailability),
      pharmacyName: cleanText(body.pharmacyName, PHARMACY_NAME_MAX),
    },
  };
}

// ── Whether this visit's detail is his to fill in ───────────────────────────────────────────────────

export const VISIT_DETAIL_FIXED_NO_REP = "This visit has no rep on it, so its detail stays as recorded.";
export const VISIT_DETAIL_FIXED_OTHER_REP = "This visit is another rep's, so its detail stays as they recorded it.";
export const VISIT_DETAIL_FIXED_LINKED =
  "This pharmacy visit came from the visit that named it. Add the detail on that visit.";
export const VISIT_DETAIL_FIXED_HISTORY = "This visit came from the old system's history, so its detail stays as it was recorded.";

/**
 * Whether the rep may fill in this visit's detail, and if not, why — in one sentence.
 *
 * His own visit, and only his. A visit a MANAGER entered for himself carries no rep at all; one the
 * Super Admin entered because the rep missed logging it carries the REP, so it IS the rep's to
 * complete — he made the visit, the Super Admin only recorded it (`capture_source = 'admin'`).
 *
 * A visit with `linkedFromVisitId` set is the pharmacy visit that a doctor's visit filed. It is part of
 * that one submission and never a second piece of work, so its detail belongs to the visit it came
 * from — and the sentence says where to go rather than just refusing.
 */
export function visitDetailEditable(visit: {
  repHrId: string | null;
  linkedFromVisitId: string | null;
  actorHrId: string;
  /** `imported_from_ireports360_at`: a visit copied from the old system is history, never his to write up. */
  importedAt?: string | null;
}): { editable: true } | { editable: false; reason: string } {
  if (visit.importedAt) return { editable: false, reason: VISIT_DETAIL_FIXED_HISTORY };
  if (visit.linkedFromVisitId) return { editable: false, reason: VISIT_DETAIL_FIXED_LINKED };
  const rep = (visit.repHrId ?? "").trim().toUpperCase();
  if (!rep) return { editable: false, reason: VISIT_DETAIL_FIXED_NO_REP };
  if (rep !== visit.actorHrId.trim().toUpperCase()) return { editable: false, reason: VISIT_DETAIL_FIXED_OTHER_REP };
  return { editable: true };
}

// ── The pharmacy name, which is add-only ────────────────────────────────────────────────────────────

export const PHARMACY_NAME_IS_ADD_ONLY =
  "The pharmacy you named stays as you recorded it. You can still change what it has.";
export const PHARMACY_IS_THE_CUSTOMER = "This visit is to the pharmacy itself, so there is no name to add.";

/**
 * Whether a pharmacy name may be added to this visit, and if not, why.
 *
 * Kept apart from `visitDetailEditable` because it refuses ONE FIELD, never the edit: a rep correcting
 * the stock answers on a visit that already names a pharmacy is doing exactly what he should.
 */
export function pharmacyNameAddable(visit: {
  listType: string;
  pharmacyName: string | null;
}): { addable: true } | { addable: false; reason: string } {
  if (visit.listType === "Pharmacy") return { addable: false, reason: PHARMACY_IS_THE_CUSTOMER };
  if (visit.pharmacyName) return { addable: false, reason: PHARMACY_NAME_IS_ADD_ONLY };
  return { addable: true };
}

// ── What a screen prints when the detail has been edited ────────────────────────────────────────────

export const VISIT_DETAIL_EDIT_PROMPT = "Add the detail";
export const VISIT_DETAIL_EDIT_AGAIN = "Edit the detail";

/**
 * The marker, in the module's own wording: the fact, then the Cairo date and time.
 *
 * It takes the formatter rather than importing one, so the one sentence reads identically wherever it is
 * printed and this file stays free of a date library. The REPORT's own column already renders the Super
 * Admin's correction as `Yes · <date time>` (`server/visit-report-values.ts`); this is the same shape
 * said as a sentence, for a card.
 */
export function visitDetailEditedLine(editedAt: string | null, format: (iso: string) => string): string | null {
  return editedAt ? `Edited · ${format(editedAt)}` : null;
}
