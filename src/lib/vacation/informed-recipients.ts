/**
 * Who is INFORMED of a vacation request without being asked to decide it.
 *
 * OWNER INSTRUCTION, 2026-09-29: "in any av request on phx make yasmeena informed." AV is the
 * Annual Vacation, and "informed" is the whole of it — the person is told, and is not an approver.
 *
 * A SEAT, NOT A PERSON (owner, 2026-10-20). She moved that day from the HR Generalist seat to a seat
 * of her own, and asked where these notices go now, the owner answered "Both to you until the
 * hire": they belong to whoever holds the HR Generalist seat, and while nobody does, to the Super
 * Admin standing in for it (src/lib/notifications/vacant-seat.ts). So this module names the seat and
 * no HR id at all — a named person strands the notice the day the chair changes hands, which is
 * exactly what happened here.
 *
 * INFORMED IS NOT AN APPROVAL STEP, and keeping the two apart is the point of this module existing
 * at all. The approval chain is built in `approval-flow.ts` and every name in it gets a step, a
 * clock, an SLA escalation and Approve/Reject buttons. Adding the informed party there would have
 * made every annual vacation in the company wait on a third signature — the opposite of what he
 * asked for. So this resolves extra notification recipients, and nothing reads them but the
 * notification dispatch.
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
 * IT NEVER DOUBLES UP. When an informed person is already a recipient of the same request — they
 * raised it, or they sit in its approval chain — they are dropped and get their real notification
 * only. That matters more now: the Super Admin standing in for an empty seat is often in the chain.
 * Matching folds one person's accounts together (the console login is the same human as B-10) and
 * then compares on `normalizeHrIdForAccess`, which strips the hyphen as well as the case, so "B-10"
 * and "B10" are one person. `canonicalHrIdKey` alone only lowercases, and both spellings occur in
 * this data.
 */

import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { HR_GENERALIST_SEAT } from "@/lib/notifications/vacant-seat";
import type { VacationType } from "@/lib/vacation/types";

/**
 * The seat informed of every annual vacation — the HR Generalist's. Resolved to people at send time
 * by `resolveSeatOrStandInHrIds`, so the notice follows the seat, and reaches the Super Admin while
 * it is empty.
 */
export const VACATION_INFORMED_SEAT = HR_GENERALIST_SEAT;

/** The types whose requests the seat is informed of. Annual only — the owner named the AV. */
export const VACATION_INFORMED_TYPES: readonly VacationType[] = ["annual"];

export function isVacationInformedType(vacationType: string | null | undefined): boolean {
  const normalized = String(vacationType ?? "").trim().toLowerCase();
  return VACATION_INFORMED_TYPES.some((type) => type === normalized);
}

function personKey(hrId: string | null | undefined): string | null {
  return normalizeHrIdForAccess(canonicalPersonHrId(hrId) ?? hrId) || null;
}

/**
 * The HR ids to inform for this request: the informed seat's people, minus anyone this request
 * already notifies, each person once. Empty when the type is not an annual vacation. Pure — the
 * seat is resolved by the caller.
 */
export function resolveVacationInformedHrIds(input: {
  alreadyNotifiedHrIds: readonly (string | null | undefined)[];
  informedHrIds: readonly (string | null | undefined)[];
  vacationType: string | null | undefined;
}): string[] {
  if (!isVacationInformedType(input.vacationType)) return [];
  const taken = new Set(
    input.alreadyNotifiedHrIds.map((hrId) => personKey(hrId)).filter((key): key is string => Boolean(key)),
  );
  const informed: string[] = [];
  for (const hrId of input.informedHrIds) {
    const key = personKey(hrId);
    if (!hrId || !key || taken.has(key)) continue;
    taken.add(key);
    informed.push(hrId);
  }
  return informed;
}
