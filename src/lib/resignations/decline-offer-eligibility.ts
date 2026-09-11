import { daysBetweenDateOnly, parseDateOnly } from "@/lib/date-only";

/**
 * Owner rule: the "declined offer / did not join" shortcut is only usable in the
 * first 30 days after hire. Past that, HR must use the normal resignation/termination
 * workflow instead.
 */
export const DECLINE_OFFER_WINDOW_DAYS = 30;

/** Pure and isomorphic on purpose — called from both the browser form and the server
 * service, each supplying "today" from its own Cairo-safe source (`todayInCairo` from
 * `@/lib/date-only` on the client, `currentCairoDateOnlyIso` from `@/lib/i18n/format`
 * on the server) rather than a bare `new Date()`. */
export function daysSinceHire(hireDate: string | null | undefined, todayCairoIso: string): number | null {
  const today = parseDateOnly(todayCairoIso);
  if (!today) return null;
  return daysBetweenDateOnly(hireDate, today);
}

export function isDeclineOfferEligible(
  employee: { employmentStatus: string | null | undefined; hireDate: string | null | undefined },
  todayCairoIso: string,
): boolean {
  const status = String(employee.employmentStatus ?? "").toLowerCase();
  if (status !== "active" && status !== "on_leave") return false;

  const days = daysSinceHire(employee.hireDate, todayCairoIso);
  if (days === null) return false;

  return days >= 0 && days <= DECLINE_OFFER_WINDOW_DAYS;
}
