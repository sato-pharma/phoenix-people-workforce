/**
 * Phoenix CRM — the Super Admin corrects a visit a rep submitted, with no I/O.
 *
 * Owner, 2026-10-06: "make the admin able to edit a visit submitted by an employee. Example, if he
 * chooses a wrong double visit, make me able to enter and edit it."
 *
 * This is the SECOND of the Super Admin's visit writes, and it is not the first one's mirror image. "A
 * record a rep MISSED" (missed-records.ts) ADDS what is missing and never rewrites what the rep
 * recorded — his own ruling of 2026-10-01. This one CORRECTS what he recorded, and only the three things
 * a rep's own tap or typing decides and can get wrong:
 *
 *   - WHO WAS ON THE VISIT — single / double / chain and the people (visit-company.ts);
 *   - THE PRODUCTS discussed, from the line's own list;
 *   - THE COMMENT, which stays required, as it is on the rep's own form.
 *
 * 🔴 WHAT IT NEVER TOUCHES IS THE EVIDENCE: the customer, the day, the time, the location, the photo and
 * the voice note. Those are what the integrity checks and every figure read, and a correction must not be
 * able to move a visit onto another day or another customer — that is a remove-and-enter, and a rep's
 * own visit is not removable here.
 *
 * 🔴 NOTHING IS LOST. `phoenix_crm_admin_edit_visit` keeps what each of the three said before, with who
 * changed it and when (`phoenix_crm_visit_edits`), because production has no point-in-time recovery.
 *
 * 🔴 AND THE REP IS TOLD NOTHING (Golden Rule #1): this is a correction to a record, not a check on him.
 * It sends no notice to him or to anybody; the visit simply reads right from then on.
 *
 * `server/visit-edit.ts` does the reading and the saving.
 */

import { cleanText, VISIT_COMMENT_MAX, VISIT_COMMENT_REQUIRED, VISIT_PRODUCTS_MAX } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { COMPANY_MOST, type VisitCompanyChoice } from "@/lib/phoenix-crm/visit-company";

/** What the Super Admin sends to change who was on the visit. Null on the wire when he left it alone. */
export type VisitEditWho = { choice: VisitCompanyChoice; picked: string[] };

export type VisitEditEntry = {
  visitId: string;
  /** Null: who was on the visit is left exactly as the rep recorded it. */
  who: VisitEditWho | null;
  products: string[];
  comment: string;
};

export type VisitEditParse = { ok: true; value: VisitEditEntry } | { ok: false; error: string };

function isChoice(value: unknown): value is VisitCompanyChoice {
  return value === "single" || value === "double" || value === "chain";
}

/** One edit from the wire. The people are NOT checked here — only the server holds the territory's chain. */
export function parseVisitEdit(raw: unknown): VisitEditParse {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isUuid(body.visitId)) return { ok: false, error: "Reload the page and try again." };

  let who: VisitEditWho | null = null;
  if (body.who !== null && body.who !== undefined) {
    const entry = (typeof body.who === "object" ? body.who : {}) as Record<string, unknown>;
    if (!isChoice(entry.choice)) return { ok: false, error: "Choose who was on the visit." };
    const picked = (Array.isArray(entry.picked) ? entry.picked : [])
      .map((hrId) => cleanText(hrId, 40))
      .filter((hrId): hrId is string => Boolean(hrId));
    // More than the choice takes is a refusal, never a quiet trim: two ticks under "Double visit" is a
    // form that lost track of itself, and guessing which one he meant would file the wrong person.
    if (picked.length > COMPANY_MOST[entry.choice]) return { ok: false, error: "Choose who was on the visit." };
    who = { choice: entry.choice, picked };
  }

  const products = [
    ...new Set((Array.isArray(body.products) ? body.products : []).map((product) => cleanText(product, 80)).filter((product): product is string => Boolean(product))),
  ];
  if (products.length === 0) return { ok: false, error: "Choose the products discussed." };
  if (products.length > VISIT_PRODUCTS_MAX) return { ok: false, error: `Choose at most ${VISIT_PRODUCTS_MAX} products.` };

  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (!comment) return { ok: false, error: VISIT_COMMENT_REQUIRED };
  if (comment.length > VISIT_COMMENT_MAX) return { ok: false, error: `The comment is longer than ${VISIT_COMMENT_MAX} characters.` };

  return { ok: true, value: { visitId: String(body.visitId).toLowerCase(), who, products, comment } };
}

export const VISIT_PEOPLE_FIXED_MANAGER_ENTRY =
  "A manager entered this visit, so who was on it stays as they recorded. The products and the comment can still be corrected.";
export const VISIT_PEOPLE_FIXED_NO_REP = "This visit has no rep on it, so who was on it stays as recorded.";

/**
 * Whether WHO WAS ON THE VISIT can be changed on this visit, and if not, why — in one sentence.
 *
 * Only a visit the rep entered himself, or one the Super Admin entered for him: on those the person who
 * entered it is the rep or nobody on it, so changing the manager can never make a visit read as "entered
 * by somebody who was not on it" (`isEnteredForRep`). A visit a MANAGER entered carries that manager as
 * the visit's manager, and re-picking him would turn the manager's own record into one the Super Admin
 * appears to have entered.
 */
export function visitWhoEditable(visit: {
  repHrId: string | null;
  enteredByHrId: string | null;
  captureSource: string | null;
}): { editable: true } | { editable: false; reason: string } {
  const rep = (visit.repHrId ?? "").trim().toUpperCase();
  if (!rep) return { editable: false, reason: VISIT_PEOPLE_FIXED_NO_REP };
  const enteredBy = (visit.enteredByHrId ?? "").trim().toUpperCase();
  if (enteredBy === rep || visit.captureSource === "admin") return { editable: true };
  return { editable: false, reason: VISIT_PEOPLE_FIXED_MANAGER_ENTRY };
}
