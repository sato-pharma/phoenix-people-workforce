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

// The one import this file has, and it is still no I/O: `personKey` is the comparison rule for two hr
// ids across Phoenix CRM, and `scope.ts` is a pure module (it reads `hrIdForStorage` and a type).
// Needed by `reviewerWasOnTheVisit` below, where a raw `===` would miss on case and padding alone.
import { personKey } from "@/lib/phoenix-crm/scope";

/** What the rep picks on the first step of Add Visit, before he picks the doctor. */
export type VisitTypeChoice = "planned" | "unplanned";

/**
 * The two ways a visit can be off the plan (owner, 2026-09-29):
 *
 *   OUT OF PLAN — someone on his list who is not on today's sent plan. He writes why, and the visit
 *                 counts once his manager and then SFE approve it (everything above).
 *   OUT OF LIST — someone not on his list at all. He validates the customer on the spot (live photo,
 *                 location, days and hours), and the district manager and SFE approve the CUSTOMER,
 *                 not the visit: it counts once the customer is admitted, in the month it happened,
 *                 and never if he is dropped. No reason is asked and no approval row is raised.
 */
export type UnplannedKind = "out_of_plan" | "out_of_list";

export function isUnplannedKind(value: unknown): value is UnplannedKind {
  return value === "out_of_plan" || value === "out_of_list";
}

export function unplannedKindLabel(kind: UnplannedKind): string {
  return kind === "out_of_list" ? "Out of list" : "Out of plan";
}

/** What the rep is told on an out-of-list visit. The customer's own admission is what it waits on. */
export const OUT_OF_LIST_REP_NOTE = "Out of your list. It counts once this customer is added to your list.";

/**
 * The out-of-list visit's note, from where its CUSTOMER has got to — the visit has no approval of its
 * own. Waiting outside (or with the request on its way): not counting yet. Admitted: it counts, in the
 * month it happened. In the Archive: it never will.
 */
export function outOfListVisitNote(customerStatus: string | null): { label: string; note: string } {
  if (customerStatus === "active") {
    return { label: "Added to your list — it counts", note: "Out of your list when you went; the customer was added since, so it counts." };
  }
  if (customerStatus === "dropped") {
    return { label: "Not added — it does not count", note: "This customer was not added to your list, so this visit does not count." };
  }
  return { label: "Waiting to be added to your list", note: OUT_OF_LIST_REP_NOTE };
}

/**
 * 🔴 THE OFF-PLAN CAP — AT MOST TWO DOCTORS A DAY AND EIGHT A WEEK OUT OF PLAN (owner, 2026-10-10).
 * The numbers are SETTINGS (`offplan_daily_cap`, `offplan_weekly_cap`), read live by the visit trigger
 * `phoenix_crm_visits_offplan_cap`; two and eight are only their defaults. It counts DISTINCT doctors
 * (AM and PM customers) of the `out_of_plan` kind per seat — never an out-of-list visit, never a
 * pharmacy — in the visit day and in the field week (Saturday to Thursday).
 *
 * These sentences sit in `db.ts`'s static REFUSALS table, which knows only the code, so they name no
 * number. Golden rule #1: they say what to do, never that he is being checked.
 */
export const OFFPLAN_DAY_FULL_CODE = "phoenix_crm:offplan_day_full";
export const OFFPLAN_WEEK_FULL_CODE = "phoenix_crm:offplan_week_full";
export const OFFPLAN_DAY_FULL_TEXT =
  "You have reached the most customers you can visit out of your plan in one day. Plan this one for another day.";
export const OFFPLAN_WEEK_FULL_TEXT =
  "You have reached the most customers you can visit out of your plan in one week. Plan this one for next week.";

/**
 * Where an off-plan visit's approval has got to. `admin_pending` is a RECORDED visit's first step
 * (owner, 2026-10-16): the Administrator approves the recording first, and only then does the visit
 * reach the step it was going to start at. It is the one place the Administrator is a step.
 */
export type UnplannedVisitStatus = "admin_pending" | "manager_pending" | "sfe_pending" | "approved" | "refused";

/** Which of the two stages a viewer is deciding as. */
export type UnplannedVisitStage = "manager" | "sfe";

export const UNPLANNED_FIRST_STATUSES = ["manager_pending", "sfe_pending"] as const;

/** The rep's written "why I went". Long enough to be a reason, short enough to read on a phone. */
export const UNPLANNED_REASON_MIN = 10;
export const UNPLANNED_REASON_MAX = 500;
export const UNPLANNED_DECISION_NOTE_MAX = 500;

export function isUnplannedVisitStatus(value: unknown): value is UnplannedVisitStatus {
  return value === "admin_pending" || value === "manager_pending" || value === "sfe_pending" || value === "approved" || value === "refused";
}

export function isUnplannedVisitStage(value: unknown): value is UnplannedVisitStage {
  return value === "manager" || value === "sfe";
}

/** Still waiting on somebody — so counting in nothing. */
export function isUnplannedVisitWaiting(status: UnplannedVisitStatus): boolean {
  return status === "admin_pending" || status === "manager_pending" || status === "sfe_pending";
}

/**
 * The manager's or SFE's stage a status is waiting on, or null once it is settled — and null while it
 * waits for the Administrator, whose step is decided on the Visit Recording page, never here.
 */
export function unplannedVisitStageOf(status: UnplannedVisitStatus): UnplannedVisitStage | null {
  if (status === "manager_pending") return "manager";
  if (status === "sfe_pending") return "sfe";
  return null;
}

export function unplannedVisitStatusLabel(status: UnplannedVisitStatus): string {
  if (status === "admin_pending") return "Waiting for approval";
  if (status === "manager_pending") return "Waiting for your manager";
  if (status === "sfe_pending") return "Waiting for SFE";
  if (status === "approved") return "Approved — it counts";
  return "Refused — it does not count";
}

/**
 * What the rep is told on his own visit. The same words whichever screen he is on.
 *
 * `managerStepTaken` exists because `sfe_pending` reaches that stage two different ways, and only one
 * of them means a manager approved anything. A visit whose manager step was never available — a
 * vacant chain, or a reviewer who was on the visit himself (below) — starts AT the SFE stage, and
 * telling that rep "your manager approved it" would be a plain untruth about his own visit. It
 * defaults to true so the generic single-argument form still reads as it always did; the two callers
 * that can tell pass what is actually on the row.
 */
export function unplannedVisitRepNote(status: UnplannedVisitStatus, managerStepTaken = true): string {
  if (status === "admin_pending") return "Off the plan. It counts once it is approved.";
  if (status === "manager_pending") return "Off the plan. It counts once your manager and then SFE approve it.";
  if (status === "sfe_pending") {
    return managerStepTaken
      ? "Off the plan. Your manager approved it; it counts once SFE does."
      : "Off the plan. It counts once SFE approves it.";
  }
  if (status === "approved") return "Off the plan, approved — it counts like a planned visit.";
  return "Off the plan and refused, so it does not count.";
}

/**
 * Where the approval starts: with the territory's own manager when it has one, else with SFE.
 *
 * 🔴 AND WITH SFE WHEN THAT MANAGER WAS ON THE VISIT HIMSELF (owner, 2026-10-12). Measured on
 * production that day: of the 31 off-plan visits carrying a companion, 27 were decided by that
 * companion — every one the named manager, every one approved — because nothing at any layer compared
 * the approver against who went. His ruling is that the manager's step is then UNAVAILABLE and the
 * visit goes straight to the SFE, which is not a new rule so much as the one already here: a territory
 * whose manager chain is vacant starts at SFE for exactly the same reason, that there is no one at
 * that step who can honestly take it.
 *
 * 🔴 WHAT THIS IS NOT. It adds no step, removes none, and blocks nobody: his chain is untouched —
 * direct manager, then SFE; one refusal ends it; the Administrator is not a step and may only refuse.
 * It raises no flag, is never called fraud, and no rep is told anything about it. The manager keeps
 * every other visit he has always decided.
 */
export function unplannedFirstStatus(
  hasReviewer: boolean,
  reviewerWasOnTheVisit = false,
): Extract<UnplannedVisitStatus, "manager_pending" | "sfe_pending"> {
  return hasReviewer && !reviewerWasOnTheVisit ? "manager_pending" : "sfe_pending";
}

/**
 * Was the manager who would decide this visit one of the people on it?
 *
 * `personKey` is what compares two hr ids anywhere in Phoenix CRM — the raw strings differ in case and
 * padding between the columns that store them, so a raw `===` would quietly answer "no" and hand the
 * step straight back to the companion. A null reviewer is not on anything: a vacant chain is already
 * answered by `hasReviewer` above, and reading null as a match would send every such visit to SFE for
 * the wrong reason.
 */
export function reviewerWasOnTheVisit(
  reviewerHrId: string | null | undefined,
  companionHrIds: ReadonlyArray<string | null | undefined>,
): boolean {
  const reviewer = personKey(reviewerHrId);
  if (reviewer === null) return false;
  return companionHrIds.some((hrId) => personKey(hrId) === reviewer);
}

/**
 * 🔴 DOES THIS VISIT COUNT IN A KPI — THE TYPESCRIPT TWIN OF `phoenix_crm_countable_visits` AND ITS
 * `customer_validated` COLUMN, WORD FOR WORD.
 *
 * Both halves of the one question (the view's own comment says the same thing from the SQL side):
 *
 *   APPROVAL        an off-plan visit counts in nothing until the manager and then SFE approve it
 *                   (owner, 2026-09-26); an OUT-OF-LIST visit has no approval of its own and waits
 *                   on its customer instead, which is the other half;
 *   VALIDATION      a visit to a customer nobody has validated is saved and counts in nothing
 *                   (owner, 2026-10-01: "not counted in KPIs till validated").
 *
 * It exists because a reader of the RAW table has no view to ask. The day page is exactly that: it
 * reads `phoenix_crm_visits` (it has to — it lists every visit, with its status), and its three
 * headline figures counted every row, while the calendar cell that OPENS it counts only the rows the
 * view and the column agree on. So one rep's Tuesday read 3 on the grid and 5 on the page it links
 * to, with nothing on either screen to say which was right.
 *
 * `false` is never "this visit is not real" — it is "not yet", or, on a refusal, "not ever". The
 * caller says which in words; nothing here is a verdict about the rep.
 */
export function visitCountsInKpi(input: {
  isUnplanned: boolean;
  unplannedKind: UnplannedKind | null;
  /** The off-plan approval's own status, where there is one. */
  unplannedStatus: UnplannedVisitStatus | null;
  /** `phoenix_crm_customers.validated_at is not null` for the visited customer. */
  customerValidated: boolean;
}): boolean {
  if (!input.customerValidated) return false;
  if (!input.isUnplanned) return true;
  if (input.unplannedKind === "out_of_list") return true;
  return input.unplannedStatus === "approved";
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
