/**
 * Phoenix CRM — asking to edit a week that is already sent, with no I/O.
 *
 * Owner, 2026-10-01: a rep no longer takes a sent week back himself. He presses "Ask to edit this
 * week" (one button — no reason asked, his ruling), and the request runs:
 *
 *   the territory's district manager APPROVES → the SFE Manager APPROVES → HR ACKNOWLEDGES
 *
 * and only after the acknowledgement does the week open again for him to change the days from today
 * on and send it again. HR is Omar Gawish himself (`PLAN_EDIT_ACKNOWLEDGER_HR_ID`, his own ruling).
 * One refusal, at the manager's step or SFE's, ends it. A territory whose manager chain is vacant
 * starts at SFE, exactly as an off-plan visit does (unplanned-rules.ts). A request whose week has
 * passed before it is settled expires: there is nothing left to change.
 *
 * Every step tells the next person to act, the rep, the district manager and the SFE Manager — by
 * email, in-app and Telegram (his ruling; the one Phoenix CRM notice that emails, see
 * phoenix-crm-channel-guard.ts).
 */

/** Where a request to edit a week has got to. */
export type PlanEditStatus = "manager_pending" | "sfe_pending" | "hr_pending" | "reopened" | "refused" | "expired";

/** Which of the three steps a viewer acts at. */
export type PlanEditStage = "manager" | "sfe" | "hr";

/** HR's step is Omar Gawish's own (owner, 2026-10-01). */
export const PLAN_EDIT_ACKNOWLEDGER_HR_ID = "B-10";

export const PLAN_EDIT_NOTE_MAX = 500;

export const PLAN_EDIT_WAITING_STATUSES = ["manager_pending", "sfe_pending", "hr_pending"] as const;

export function isPlanEditStatus(value: unknown): value is PlanEditStatus {
  return (
    value === "manager_pending" ||
    value === "sfe_pending" ||
    value === "hr_pending" ||
    value === "reopened" ||
    value === "refused" ||
    value === "expired"
  );
}

/** Still waiting on somebody. */
export function isPlanEditWaiting(status: PlanEditStatus): boolean {
  return status === "manager_pending" || status === "sfe_pending" || status === "hr_pending";
}

/** The step a status is waiting on, or null once it is settled. */
export function planEditStageOf(status: PlanEditStatus): PlanEditStage | null {
  if (status === "manager_pending") return "manager";
  if (status === "sfe_pending") return "sfe";
  if (status === "hr_pending") return "hr";
  return null;
}

/** Where the request starts: with the territory's own manager when it has one, else with SFE. */
export function planEditFirstStatus(hasReviewer: boolean): Extract<PlanEditStatus, "manager_pending" | "sfe_pending"> {
  return hasReviewer ? "manager_pending" : "sfe_pending";
}

/** Where one step's yes moves the request: manager → SFE → HR → the week reopens. */
export function nextPlanEditStatus(stage: PlanEditStage): Extract<PlanEditStatus, "sfe_pending" | "hr_pending" | "reopened"> {
  if (stage === "manager") return "sfe_pending";
  if (stage === "sfe") return "hr_pending";
  return "reopened";
}

/** What a step's decision is called on its button. HR acknowledges; it never approves or refuses. */
export function planEditDecisionsFor(stage: PlanEditStage): ReadonlyArray<"approve" | "refuse" | "acknowledge"> {
  return stage === "hr" ? ["acknowledge"] : ["approve", "refuse"];
}

export function planEditStatusLabel(status: PlanEditStatus): string {
  if (status === "manager_pending") return "Waiting for the district manager";
  if (status === "sfe_pending") return "Waiting for SFE";
  if (status === "hr_pending") return "Waiting for HR";
  if (status === "reopened") return "Open again to edit";
  if (status === "refused") return "Refused";
  return "Expired — the week passed";
}

/** What the rep reads on his week. The same words wherever he meets it. */
export function planEditRepNote(status: PlanEditStatus): string {
  if (status === "manager_pending") return "You asked to edit this week. Your district manager decides first, then SFE, then HR.";
  if (status === "sfe_pending") return "Your district manager approved. SFE decides next, then HR.";
  if (status === "hr_pending") return "Your district manager and SFE approved. The week opens once HR acknowledges it.";
  if (status === "reopened") {
    return "The week is open again. Change the days from today on and send it again. Until you send it, your visits this week count as off-plan.";
  }
  if (status === "refused") return "Your request to edit this week was refused. The week stays as it was sent.";
  return "The week passed before your request was settled.";
}
