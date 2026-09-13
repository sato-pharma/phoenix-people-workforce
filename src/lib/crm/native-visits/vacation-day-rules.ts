/**
 * Working on an approved vacation day — the pure rules (CRM phase 6, rule 9).
 *
 * The owner's rule, 2026-09-13: a rep cannot submit a visit on a day HR approved as his vacation,
 * "except if he send a request to his manager and the HR". So the day opens only when BOTH approved.
 * Nothing here decides for anyone: a decision is the named manager's own click, or HR's.
 *
 * Dormant until the CRM cutover date: before it, and while the date is null, no visit is refused.
 *
 * Pure: no database, no clock. The service is native-visits/vacation-days.ts.
 */

import { addDaysIso } from "@/lib/crm/dates";
import type { NativeVisitContactRule } from "@/lib/crm/native-visits/rules";

export const VACATION_DAY_REASON_MAX = 1000;
export const VACATION_DAY_NOTE_MAX = 500;
/** How far ahead a rep may ask. A request also works for yesterday, the oldest day he can enter. */
export const VACATION_DAY_REQUEST_AHEAD_DAYS = 60;

export type VacationDayDecision = "pending" | "approved" | "rejected";
export type VacationDayDeciderRole = "manager" | "hr";
export type VacationDayRequestStatus = "waiting" | "approved" | "rejected" | "cancelled";

export type VacationDayRequestState = {
  managerDecision: VacationDayDecision;
  hrDecision: VacationDayDecision;
  cancelledAt: string | null;
};

export const VACATION_DAY_BLOCKED_MESSAGE =
  "That day is your approved vacation. Send a request to your manager and HR to enter visits on it.";

export const VACATION_DAY_WAITING_MESSAGE =
  "That day is your approved vacation. Your request to work on it is still waiting for your manager and HR.";

/** One status for a request: approved only when BOTH deciders approved. */
export function vacationDayRequestStatus(state: VacationDayRequestState): VacationDayRequestStatus {
  if (state.cancelledAt) return "cancelled";
  if (state.managerDecision === "rejected" || state.hrDecision === "rejected") return "rejected";
  if (state.managerDecision === "approved" && state.hrDecision === "approved") return "approved";
  return "waiting";
}

/**
 * Why a visit on this day is refused, or null when it may be saved.
 *
 * Only a visit with a contact is blocked (a doctor visit or a campaign). A day type with no contact —
 * annual vacation itself, a meeting, training — stays open, so a rep can still record the vacation.
 */
export function vacationDayWorkRefusal(input: {
  /** The CRM cutover date is set and the visit day is on or after it. */
  ruleActive: boolean;
  contactRule: NativeVisitContactRule;
  onApprovedVacation: boolean;
  /** The rep's live request for that day, if any. */
  request: VacationDayRequestState | null;
}): string | null {
  if (!input.ruleActive || input.contactRule === "none" || !input.onApprovedVacation) return null;
  const status = input.request ? vacationDayRequestStatus(input.request) : null;
  if (status === "approved") return null;
  if (status === "waiting") return VACATION_DAY_WAITING_MESSAGE;
  return VACATION_DAY_BLOCKED_MESSAGE;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Why a new request is refused, or null. The service separately checks the day is approved vacation. */
export function vacationDayRequestRefusal(input: { visitDate: string; reason: string; cairoToday: string }): string | null {
  if (!ISO_DAY.test(input.visitDate)) return "Choose the day you want to work.";
  if (input.visitDate < addDaysIso(input.cairoToday, -1)) {
    return "That day is too far back to enter visits, so there is nothing to ask for.";
  }
  if (input.visitDate > addDaysIso(input.cairoToday, VACATION_DAY_REQUEST_AHEAD_DAYS)) {
    return `You can ask up to ${VACATION_DAY_REQUEST_AHEAD_DAYS} days ahead.`;
  }
  if (!input.reason.trim()) return "Say why you need to work on your vacation day.";
  if (input.reason.length > VACATION_DAY_REASON_MAX) return `Keep the reason under ${VACATION_DAY_REASON_MAX} characters.`;
  return null;
}

export function parseVacationDayDecision(raw: unknown): "approved" | "rejected" | null {
  return raw === "approved" || raw === "rejected" ? raw : null;
}

export function parseVacationDayDeciderRole(raw: unknown): VacationDayDeciderRole | null {
  return raw === "manager" || raw === "hr" ? raw : null;
}

/**
 * Who gives the HR approval. The owner, 2026-09-13: "only administrator" — the Super Admin alone, not
 * the HR seats, not even the one that approves leave.
 */
export const VACATION_DAY_HR_DECIDER_ROLE = "Super Admin";

export function isVacationDayHrDecider(role: string | null | undefined): boolean {
  return role === VACATION_DAY_HR_DECIDER_ROLE;
}

/**
 * Why this viewer may not record this decision, or null.
 *
 * Hr ids arrive already canonical. The manager answers only as the manager stored on the request, and
 * only for a rep beneath him. The HR approval is the administrator's alone, and never on a request
 * where he is the rep or the manager — one person is never both approvals.
 */
export function vacationDayDecisionRefusal(input: {
  as: VacationDayDeciderRole;
  viewerHrKey: string | null;
  repHrKey: string;
  managerHrKey: string;
  state: VacationDayRequestState;
  isHrAuthority: boolean;
  repInViewerScope: boolean;
  decision: "approved" | "rejected";
  note: string | null;
}): string | null {
  if (!input.viewerHrKey) return "Sign in again to answer this request.";
  if (input.state.cancelledAt) return "The rep withdrew this request.";
  if (vacationDayRequestStatus(input.state) === "rejected") return "This request was already refused. The rep can send a new one.";
  if (input.viewerHrKey === input.repHrKey) return "Nobody answers their own request.";
  if (input.as === "manager") {
    if (input.viewerHrKey !== input.managerHrKey) return "Only the manager the request was sent to answers it as manager.";
    if (!input.repInViewerScope) return "This rep is not beneath you.";
    if (input.state.managerDecision !== "pending") return "You have already answered this request.";
  } else {
    if (!input.isHrAuthority) return "Only the administrator gives the HR approval.";
    if (input.viewerHrKey === input.managerHrKey) return "The rep's manager cannot also answer as HR.";
    if (input.state.hrDecision !== "pending") return "HR has already answered this request.";
  }
  if (input.decision === "rejected" && !input.note?.trim()) return "Say why you are refusing.";
  return null;
}
