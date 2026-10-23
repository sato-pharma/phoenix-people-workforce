/**
 * Phoenix CRM — a manager writes up his OWN logged single visit, afterwards. No I/O.
 *
 * Owner, 2026-10-23: *"let a district manager write up his own logged single visit afterwards"* — asked
 * for after a visit logged on 19 Oct 2026 saved with its products and no comment, because the words were
 * typed into the territory form, which refused them. There was no way back into a logged single visit at
 * all, so the comment had to be written into the row by hand.
 *
 * ## The same shape the rep already has, deliberately
 *
 * `visit-detail-edit-rules.ts` is the REP completing his own visit (owner, 2026-10-15), and this is its
 * sibling for the manager's own single visits. The repo already answers what "write up" means here, so
 * this file does not invent a second answer — it reuses the rep's own wording for the prompt and for the
 * edited line, and it moves ONE thing:
 *
 *   - THE DETAILED WRITE-UP — a second, longer account. 🔴 The comment he typed while logging is KEPT
 *     and is not editable, exactly as the rep's door comment is: *"leave it and make them able to add
 *     another detailed comment."*
 *
 * ## What it never touches, and why
 *
 * The customer, the day, the time, the location and the address, area and brick a vacant area's visit
 * recorded are the evidence his own report reads — and on a vacant territory that visit is the only
 * record of where its doctor is. The products stay as logged for the same reason the rep's do: nobody
 * else corrects a manager's own single visit, so a product list that can be rewritten weeks later is a
 * record that says nothing. Logging stays one tap; this is the paragraph the door had no time for.
 *
 * `server/manager-visits.ts` does the reading and the saving.
 */

import { isUuid } from "@/lib/phoenix-crm/plan-rules";

/** Twice the door comment's 1,000, the rep's ratio: this is the account the door had no time for. */
export const MANAGER_VISIT_DETAIL_MAX = 2000;

export type ManagerVisitDetailEdit = {
  visitId: string;
  /** Null when he left it empty, or cleared what he had written. */
  detailComment: string | null;
};

export type ManagerVisitDetailParse = { ok: true; value: ManagerVisitDetailEdit } | { ok: false; error: string };

/**
 * One write-up from the wire.
 *
 * Only two things are refused: an unreadable visit id, and an account longer than the limit. Everything
 * else a build one release behind might send is ignored rather than refused — he is typing this up at
 * the end of a long day, and an unknown key must not cost him the paragraph he just wrote.
 */
export function parseManagerVisitDetail(raw: unknown): ManagerVisitDetailParse {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isUuid(body.visitId)) return { ok: false, error: "Reload the page and try again." };
  const detail = typeof body.detailComment === "string" ? body.detailComment.trim() : "";
  if (detail.length > MANAGER_VISIT_DETAIL_MAX) {
    return { ok: false, error: `The write-up is longer than ${MANAGER_VISIT_DETAIL_MAX} characters.` };
  }
  return { ok: true, value: { visitId: String(body.visitId).toLowerCase(), detailComment: detail || null } };
}

export const MANAGER_VISIT_DETAIL_FIXED_OTHER = "This visit is another manager's, so its write-up stays as they recorded it.";

/**
 * Whether this visit's write-up is his to fill in: his own, and only his.
 *
 * A manager's single visit carries exactly one person — the manager who made it and logged it — so there
 * is no equivalent of the rep's "entered by the Super Admin" case and no linked pharmacy visit. The HR
 * ids are compared folded, the way every other `personKey` comparison in the module is, because they are
 * stored upper-cased and arrive however the caller had them.
 */
export function managerVisitDetailEditable(visit: {
  managerHrId: string | null;
  actorHrId: string;
}): { editable: true } | { editable: false; reason: string } {
  const owner = (visit.managerHrId ?? "").trim().toUpperCase();
  if (!owner || owner !== visit.actorHrId.trim().toUpperCase()) {
    return { editable: false, reason: MANAGER_VISIT_DETAIL_FIXED_OTHER };
  }
  return { editable: true };
}
