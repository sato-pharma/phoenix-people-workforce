/**
 * Who is INFORMED of a vacation request without being asked to decide it.
 *
 * OWNER INSTRUCTION, 2026-09-29: "in any av request on phx make yasmeena informed." AV is the
 * Annual Vacation, and "informed" is the whole of it — she is told, she is not an approver.
 *
 * INFORMED IS NOT AN APPROVAL STEP, and keeping the two apart is the point of this module existing
 * at all. The approval chain is built in `approval-flow.ts` and every name in it gets a step, a
 * clock, an SLA escalation and Approve/Reject buttons. Adding her there would have made every
 * annual vacation in the company wait on a third signature — the opposite of what he asked for.
 * So this resolves ONE extra notification recipient, and nothing reads it but the notification
 * dispatch.
 *
 * ALL THREE CHANNELS — IN-APP, EMAIL AND TELEGRAM (owner, 2026-09-30: "yasmine informed in app email
 * telegram"). It shipped the day before as in-app + Telegram only, because AGENTS.md §4 requires an
 * email recipient to be asked about before it is wired rather than assumed; he was asked in the
 * report on that PR and this is his answer, so the email is now his instruction and not an
 * inference. Removing a channel from that set needs his word exactly as adding one did.
 *
 * ANNUAL ONLY, because that is the type he named. Sick, Emergency, Other and Compensatory keep
 * exactly the recipients they had. Widening this list is a product decision, not a tidy-up.
 *
 * IT NEVER DOUBLES UP. When she is already a recipient of the same request — she raised it, or she
 * sits in its approval chain — the resolver returns null and she gets her real notification only.
 * Matching is on `normalizeHrIdForAccess`, which strips the hyphen as well as the case, so "HR-009"
 * and "HR009" are one person. `canonicalHrIdKey` alone only lowercases, and the two spellings both
 * occur in this data.
 */

import { normalizeHrIdForAccess } from "@/lib/hr-id";
import type { VacationType } from "@/lib/vacation/types";

/**
 * Yasmeena Khaled Ahmed Hussein Elsafory — HR-009, HR Operations.
 *
 * The same person and the same HR ID the probation Day 30/60/75 emails are addressed to
 * (`PROBATION_MILESTONE_TO_HR_ID`). Deliberately NOT imported from there: that constant is the
 * recipient of a probation email and this one is the informed party on a vacation request, and
 * collapsing them would mean a future change to either silently moved the other.
 */
export const VACATION_INFORMED_HR_ID = "HR-009";

/** The types whose requests she is informed of. Annual only — the owner named the AV. */
export const VACATION_INFORMED_TYPES: readonly VacationType[] = ["annual"];

export function isVacationInformedType(vacationType: string | null | undefined): boolean {
  const normalized = String(vacationType ?? "").trim().toLowerCase();
  return VACATION_INFORMED_TYPES.some((type) => type === normalized);
}

/**
 * The HR ID to inform for this request, or null when nobody extra should be told — either because
 * the type is not an annual vacation, or because she is already a recipient of it.
 */
export function resolveVacationInformedHrId(input: {
  alreadyNotifiedHrIds: readonly (string | null | undefined)[];
  vacationType: string | null | undefined;
}): string | null {
  if (!isVacationInformedType(input.vacationType)) return null;
  const informedKey = normalizeHrIdForAccess(VACATION_INFORMED_HR_ID);
  const already = new Set(
    input.alreadyNotifiedHrIds
      .map((hrId) => normalizeHrIdForAccess(hrId))
      .filter((key): key is string => Boolean(key)),
  );
  if (informedKey && already.has(informedKey)) return null;
  return VACATION_INFORMED_HR_ID;
}
