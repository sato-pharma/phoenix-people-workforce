/**
 * Phoenix CRM — the unplanned (off-plan) visit, with no I/O.
 *
 * Owner, 2026-09-26. Before he chooses the doctor, the rep chooses the KIND of visit:
 *
 *   PLANNED    — the picker offers only the doctors on today's plan. Nothing to write, nothing to
 *                approve; this is the ordinary day.
 *   UNPLANNED  — the picker opens his whole list and he types WHY he went. The visit saves with the
 *                same evidence as any other (live photo, GPS, products, pharmacy stock) and counts in
 *                NOTHING until it is approved: his direct manager first, then the SFE.
 *
 * Unplanned is what replaces the old iReports360 "Campaign (Prospection)" (src/lib/crm/visit-types.ts
 * CAMPAIGN_TYPE). It is deliberately NOT the vendor's vocabulary: that feed jammed calls (a named
 * doctor, a place) and day activities (a meeting, training, a health day, leave — no doctor at all)
 * into one table, which is why `isFieldWorkVisit` has to exist to pull them apart again. Here a visit
 * is always a call, and its type says only whether the call was planned.
 *
 * WHO DECIDES, in order (his ruling — not "any one of them", not "all three"): the territory's own
 * manager, then the SFE Manager. One refusal at either stage ends it. The manager's manager sees the
 * queue and never decides it. A territory whose manager chain is vacant starts at the SFE stage —
 * only the application can read the organogram, so the first stage is resolved server-side and passed
 * to the database, never chosen by the phone.
 *
 * WHAT DECIDES "PLANNED" is not in this file, because it cannot be: it is a query against the plan's
 * own history, run inside phoenix_crm_save_visit. Plan-row existence alone is NOT the test — the rep
 * owns his draft plan and today is an editable day, so that would let him place the doctor at the door
 * and never be unplanned. See the migration's header.
 */

/** What the rep picks on the first step of Add Visit, before he picks the doctor. */
export type VisitTypeChoice = "planned" | "unplanned";

/** Where an off-plan visit's approval has got to. */
export type UnplannedVisitStatus = "manager_pending" | "sfe_pending" | "approved" | "refused";

/** Which of the two stages a viewer is deciding as. */
export type UnplannedVisitStage = "manager" | "sfe";

export const UNPLANNED_FIRST_STATUSES = ["manager_pending", "sfe_pending"] as const;

/** The rep's written "why I went". Long enough to be a reason, short enough to read on a phone. */
export const UNPLANNED_REASON_MIN = 10;
export const UNPLANNED_REASON_MAX = 500;
export const UNPLANNED_DECISION_NOTE_MAX = 500;

export function isUnplannedVisitStatus(value: unknown): value is UnplannedVisitStatus {
  return value === "manager_pending" || value === "sfe_pending" || value === "approved" || value === "refused";
}

export function isUnplannedVisitStage(value: unknown): value is UnplannedVisitStage {
  return value === "manager" || value === "sfe";
}

/** Still waiting on somebody — so counting in nothing. */
export function isUnplannedVisitWaiting(status: UnplannedVisitStatus): boolean {
  return status === "manager_pending" || status === "sfe_pending";
}

/** The stage a status is waiting on, or null once it is settled. */
export function unplannedVisitStageOf(status: UnplannedVisitStatus): UnplannedVisitStage | null {
  if (status === "manager_pending") return "manager";
  if (status === "sfe_pending") return "sfe";
  return null;
}

export function unplannedVisitStatusLabel(status: UnplannedVisitStatus): string {
  if (status === "manager_pending") return "Waiting for your manager";
  if (status === "sfe_pending") return "Waiting for SFE";
  if (status === "approved") return "Approved — it counts";
  return "Refused — it does not count";
}

/** What the rep is told on his own visit. The same words whichever screen he is on. */
export function unplannedVisitRepNote(status: UnplannedVisitStatus): string {
  if (status === "manager_pending") return "Off the plan. It counts once your manager and then SFE approve it.";
  if (status === "sfe_pending") return "Off the plan. Your manager approved it; it counts once SFE does.";
  if (status === "approved") return "Off the plan, approved — it counts like a planned visit.";
  return "Off the plan and refused, so it does not count.";
}

/** Where the approval starts: with the territory's own manager when it has one, else with SFE. */
export function unplannedFirstStatus(hasReviewer: boolean): Extract<UnplannedVisitStatus, "manager_pending" | "sfe_pending"> {
  return hasReviewer ? "manager_pending" : "sfe_pending";
}

export type UnplannedReasonResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * The clarification, cleaned the same way the database cleans it (trim, collapse runs of whitespace)
 * so the two can never disagree about a length. The floor exists because "ok" is not a reason.
 */
export function parseUnplannedReason(raw: unknown): UnplannedReasonResult {
  const text = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (text.length < UNPLANNED_REASON_MIN) return { ok: false, error: "Write why you visited this customer off your plan." };
  if (text.length > UNPLANNED_REASON_MAX) return { ok: false, error: `Keep the reason under ${UNPLANNED_REASON_MAX} characters.` };
  return { ok: true, value: text };
}
