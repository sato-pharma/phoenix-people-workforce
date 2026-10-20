/**
 * Phoenix CRM — asking to edit a week that is already sent, with no I/O.
 *
 * Owner, 2026-10-01: a rep no longer takes a sent week back himself. He presses "Ask to edit this
 * week" (one button — no reason asked, his ruling), and the request runs:
 *
 *   the territory's district manager APPROVES → the SFE Manager APPROVES
 *
 * and SFE's approval opens the week again for him to change the days from today on and send it again.
 * 🔴 NOTHING WAITS FOR THE ADMINISTRATOR (owner, 2026-10-08: HR was taken out of the approvals). He is
 * Omar Gawish himself (`PHOENIX_CRM_ADMINISTRATOR_HR_ID`) and may DECLINE a request waiting at either
 * step, with a note the rep reads — never "HR", never an "override". One refusal, at the manager's step,
 * SFE's or the Administrator's, ends it. A territory whose manager chain is vacant
 * starts at SFE, exactly as an off-plan visit does (unplanned-rules.ts). A request whose week has
 * passed before it is settled expires: there is nothing left to change.
 *
 * 🔴 TWICE A WEEK AT MOST (owner, 2026-10-20: the rep makes the plan and sends it, and after the
 * approval "he has only 2 times to request edit per week"). Every request raised on a week counts,
 * whatever became of it — a refused one included — because what is capped is the asking
 * (`PLAN_EDIT_ASKS_PER_WEEK`, refused on the server in plan-edits.ts `raisePlanEdit`).
 *
 * Every step tells the next person to act, the rep, the district manager and the SFE Manager — by
 * email, in-app and Telegram (his ruling; the one Phoenix CRM notice that emails, see
 * phoenix-crm-channel-guard.ts).
 */

/** Where a request to edit a week has got to. */
export type PlanEditStatus = "manager_pending" | "sfe_pending" | "reopened" | "refused" | "expired";

/** Which of the two steps a request waits at. */
export type PlanEditStage = "manager" | "sfe";

/** The Administrator is Omar Gawish (owner, 2026-10-01; no longer a step since 2026-10-08). */
export const PHOENIX_CRM_ADMINISTRATOR_HR_ID = "B-10";

/**
 * Who the daily expiry pass records as the actor: nobody. A request whose week has passed is closed
 * because the week passed, not because a person decided it, and writing a real HR id there would
 * read for ever as that person having refused a rep's request.
 *
 * It reaches only `phoenix_crm_plan_edit_request_events.actor_hr_id`, which no screen resolves to a
 * name — the expiry branch writes no `*_decided_by_hr_id` column at all.
 */
export const PLAN_EDIT_EXPIRY_ACTOR_HR_ID = "SYSTEM";

export const PLAN_EDIT_NOTE_MAX = 500;

/**
 * 🔴 How many times a rep may ask to edit one week (owner, 2026-10-20). The week's own plan is the unit —
 * one plan per territory per week — and every request raised on it counts, refused and expired ones too.
 */
export const PLAN_EDIT_ASKS_PER_WEEK = 2;

/** The asks a week has left, from the requests already raised on it. */
export function planEditAsksLeft(asked: number): number {
  const used = Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : 0;
  return Math.max(0, PLAN_EDIT_ASKS_PER_WEEK - used);
}

/** What the server answers a third ask with. */
export const PLAN_EDIT_ASKS_USED_UP =
  "You have already asked to edit this week twice, the most a week allows. The week stays as it is now.";

/** What the rep reads about the asks a week has left: beside the button, in its confirmation, and once both are spent. */
export function planEditAsksNote(left: number): string {
  if (left <= 0) return "You have asked to edit this week twice, the most a week allows. The week stays as it is now.";
  if (left === 1) return "This is your last ask to edit this week. A week can be asked to edit twice.";
  return "A week can be asked to edit twice.";
}

/** The short count under the button. */
export function planEditAsksLeftLine(left: number): string {
  return left === 1 ? "1 ask left this week" : `${Math.max(0, left)} asks left this week`;
}

export const PLAN_EDIT_WAITING_STATUSES = ["manager_pending", "sfe_pending"] as const;

export function isPlanEditStatus(value: unknown): value is PlanEditStatus {
  return (
    value === "manager_pending" ||
    value === "sfe_pending" ||
    value === "reopened" ||
    value === "refused" ||
    value === "expired"
  );
}

/** Still waiting on somebody. */
export function isPlanEditWaiting(status: PlanEditStatus): boolean {
  return status === "manager_pending" || status === "sfe_pending";
}

/** The step a status is waiting on, or null once it is settled. */
export function planEditStageOf(status: PlanEditStatus): PlanEditStage | null {
  if (status === "manager_pending") return "manager";
  if (status === "sfe_pending") return "sfe";
  return null;
}

/** Where the request starts: with the territory's own manager when it has one, else with SFE. */
export function planEditFirstStatus(hasReviewer: boolean): Extract<PlanEditStatus, "manager_pending" | "sfe_pending"> {
  return hasReviewer ? "manager_pending" : "sfe_pending";
}

/** Where one step's yes moves the request: manager → SFE → the week reopens. */
export function nextPlanEditStatus(stage: PlanEditStage): Extract<PlanEditStatus, "sfe_pending" | "reopened"> {
  return stage === "manager" ? "sfe_pending" : "reopened";
}

/** What a step may decide. The Administrator's only act is a decline (see `canAdminister`). */
export function planEditDecisionsFor(_stage: PlanEditStage): ReadonlyArray<"approve" | "refuse"> {
  return ["approve", "refuse"];
}

export function planEditStatusLabel(status: PlanEditStatus): string {
  if (status === "manager_pending") return "Waiting for the district manager";
  if (status === "sfe_pending") return "Waiting for SFE";
  if (status === "reopened") return "Open again to edit";
  if (status === "refused") return "Refused";
  return "Expired — the week passed";
}

/** What the rep reads on his week. The same words wherever he meets it. */
export function planEditRepNote(status: PlanEditStatus): string {
  if (status === "manager_pending") return "You asked to edit this week. Your district manager decides first, then SFE.";
  if (status === "sfe_pending") return "Your district manager approved. SFE decides next, and the week opens once SFE approves.";
  if (status === "reopened") {
    return "The week is open again. Change the days from today on and send it again. Until you send it, your visits this week count as off-plan.";
  }
  if (status === "refused") return "Your request to edit this week was refused. The week stays as it was sent.";
  return "The week passed before your request was settled.";
}
