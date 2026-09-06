/**
 * HOW LONG SOMEBODY SERVED, AND WHETHER HE STILL DOES — resolved once, for every paper that states it.
 *
 * Two certificates now describe the same period, one in Arabic and one in English, and they are
 * routinely printed minutes apart for the same person to carry to the same embassy. Two
 * implementations of this question would agree for most people and disagree for exactly the ones
 * where it matters — somebody whose departure is recorded but whose last working day is not — and a
 * pair of certificates contradicting each other is worse than either being wrong alone, because the
 * reader can see that the company does not know.
 *
 * So the FACT lives here and the WORDING lives in each document. That is the seam: this module never
 * returns a sentence, and neither renderer decides who has left.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 IT READS THE DEPARTURE FLAG, NEVER THE PRESENCE OF A DATE, and that is the whole safety
 * property. An absent `lastWorkingDate` means "nobody recorded one" — it does not mean "he is still
 * here". Reading it the other way round produces the one error on a certificate of experience that
 * costs somebody the job he is applying for: a paper telling a prospective employer that a man
 * currently at his desk left the company, or telling one that a leaver is still on the payroll.
 *
 * `employees.last_working_date` is also not the observation it looks like — the exit form copies a
 * single date into four columns — which is a further reason not to treat its absence as evidence of
 * anything. See `resolveContractTerms`.
 */

import type { HiringPackData } from "@/lib/hiring-pack/types";

export type ServicePeriod = {
  /** The day service began. Null when the employee record carries no hire date. */
  startsOn: string | null;
  /**
   * The day the period closes FOR COUNTING.
   *
   * The last working day for somebody who has left, today for somebody still serving, and null for
   * a leaver whose last working day was never recorded — which is a gap a human fills in, not a
   * date this module is entitled to invent.
   */
  endsOn: string | null;
  /** Whether he has left. The authority for which of the two sentences a certificate prints. */
  departed: boolean;
  /**
   * Whether the period can be stated at all.
   *
   * False when either end is missing, which is when a certificate rules the line rather than
   * printing a span it cannot stand behind.
   */
  countable: boolean;
};

/**
 * The period, from the pack and the day it is being printed.
 *
 * `today` is passed in rather than read here so that a caller which has already resolved Cairo's
 * date uses that same one — a document whose issue date and service span were taken from two
 * different reads of the clock can state a period ending the day after it was issued.
 */
export function resolveServicePeriod(data: HiringPackData, today: string): ServicePeriod {
  const departed = data.employee.departed;
  const startsOn = data.employee.hireDate ?? null;
  const endsOn = departed ? data.terms.lastWorkingDate ?? null : today;
  return {
    startsOn,
    endsOn,
    departed,
    countable: Boolean(startsOn && endsOn),
  };
}
