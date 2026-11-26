/**
 * Phoenix CRM — the Add visit picker's search, with no I/O, so the browser runs it on every keystroke and
 * a test can call it.
 *
 * 26 Nov 2026 (owner, on محمد علي عبدالسلام, Pedia Cairo East 2): on 24 Nov he was on Hagar Abu zeid's
 * approved plan for that very day. "Out of plan" is her list WITHOUT today's plan (owner, 2026-09-29), so
 * searching it for him found nothing, and she saved him a second time to log the visit. The picker's
 * search was also a bare `toLowerCase().includes`, so علي / على and عبدالسلام / عبد السلام missed each
 * other. Two answers, both chosen by the owner the same day ("Point to Planned + fold spelling"):
 *
 *   1. The search folds the spelling — `foldedWordsMatch`, the module's one rule for a name typed two ways.
 *   2. Out of plan, a search that names somebody on TODAY's plan shows him above the list under
 *      "On today's plan", one tap from the planned visit. Out of plan itself still never offers him: the
 *      list keeps the owner's 2026-09-29 rule, and the tap is the planned door, not a new one. No step is
 *      added — Golden Rule #1's easy half — and nothing here judges him.
 */

import { foldedWordsMatch } from "@/lib/phoenix-crm/name-fold";
import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";

type SearchableCustomer = {
  name: string;
  speciality?: string | null;
  listType: string;
  outside?: boolean;
  plannedToday?: boolean;
};

/** Whether a picker row answers what he typed — its name or its speciality, spelling folded. Empty matches all. */
export function pickerSearchMatches(query: string, customer: Pick<SearchableCustomer, "name" | "speciality">): boolean {
  return foldedWordsMatch(query, [customer.name]) || foldedWordsMatch(query, [customer.speciality ?? null]);
}

/**
 * Out of plan: the customers on TODAY's plan whose name or speciality he typed — shown above the list so
 * the one he is looking for is not missing. Nothing until he types: the plan has its own screen, and
 * repeating it under every Out of plan would be noise. Never a pharmacy (its own list) and never a
 * customer waiting outside the list, exactly the planned picker's set.
 */
export function plannedTodayMatches<T extends SearchableCustomer>(customers: ReadonlyArray<T>, query: string): T[] {
  if (query.trim().length === 0) return [];
  return customers.filter(
    (customer) =>
      !customer.outside &&
      !isPharmacyListType(customer.listType) &&
      customer.plannedToday === true &&
      pickerSearchMatches(query, customer),
  );
}
