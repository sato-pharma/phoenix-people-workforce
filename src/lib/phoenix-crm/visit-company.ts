/**
 * Phoenix CRM — who was on a visit, said as the rep says it: Single, Double (ONE person), Chain (TWO).
 *
 * Owner, 2026-10-06: "if he chooses double visit, his district manager appear, the product manager
 * appear, the national sales manager appear, and he can choose only one. And if applicable, the
 * regional manager. Also in the chain visit, all those appear, but he can choose two, not one."
 *
 * So the rep faces ONE list — the managers above his territory (district, regional where his line has
 * one, national) and the product managers of his line — and the choice only sets how many to tick:
 *
 *   single   nobody                       →  kind `single`
 *   double   exactly one of the list      →  a manager: kind `double`      · a product manager: kind `product_manager`
 *   chain    exactly two of the list      →  two managers: kind `chain` (the nearer one in `manager_hr_id`, the one
 *                                              above him in `senior_hr_id`) · a manager and a product manager: kind
 *                                              `chain` with the product manager in his OWN column
 *
 * 🔴 THE STORED SHAPE IS UNCHANGED WHERE IT MATTERED. A product manager is NEVER in `manager_hr_id`
 * (owner's pick, 2026-10-02): `double_visits` is counted from `kind = 'double'` on every board, a figure
 * district managers are judged on, so a double visit WITH a product manager is filed as the
 * `product_manager` kind it always was. The rep never sees that word: he ticked one person under
 * "Double visit", and the kind is derived here from who it was.
 *
 * 🔴 AT MOST ONE PRODUCT MANAGER ON A CHAIN. The table has one product-manager column, and a chain is
 * the management line anyway — two product managers is not a chain. The picker disables the second.
 *
 * Pure: no I/O. The server re-derives and re-checks all of it (scope.ts `resolveVisitParticipants`);
 * this is the shared arithmetic the form, the Super Admin's edit and the tests read.
 */

import { personKey } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";

export type VisitCompanyChoice = "single" | "double" | "chain";

/** How many people each choice takes. */
export const COMPANY_PICKS: Readonly<Record<VisitCompanyChoice, number>> = { single: 0, double: 1, chain: 2 };

/** One person the list offers. `position` is a manager's place above the territory, nearest first; null for a product manager. */
export type CompanyOffer = { hrId: string; role: "manager" | "product_manager"; position: number | null };

/** The slots a visit stores. */
export type CompanyStorage = {
  kind: PhoenixCrmVisitKind;
  managerHrId: string | null;
  seniorHrId: string | null;
  productManagerHrId: string | null;
};

export type CompanyResult = { ok: true; value: CompanyStorage } | { ok: false; error: string };

export const CHOOSE_ONE_FOR_DOUBLE = "Choose the one person who was on the double visit.";
export const CHOOSE_TWO_FOR_CHAIN = "Choose the two people who were on the chain visit.";
export const COMPANY_NOT_OFFERED = "Choose someone from the list. Reload the page.";
export const ONE_PRODUCT_MANAGER_ON_A_CHAIN = "A chain visit takes one product manager at most. Choose a manager for the other place.";

/** What the picker says under the choice: how many to tick. */
export function companyHint(choice: VisitCompanyChoice, picked: number): string {
  if (choice === "single") return "";
  const want = COMPANY_PICKS[choice];
  return choice === "double" ? "Choose one." : `Choose two — ${picked} of ${want} chosen.`;
}

/** The ids picked, de-duplicated and in the order picked; anything blank is dropped. */
function distinct(picked: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hrId of picked) {
    const key = personKey(hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(hrId);
  }
  return out;
}

/** A pick, as the list offered him — never as the phone spelled it. */
function offered(offers: ReadonlyArray<CompanyOffer>, hrId: string): CompanyOffer | null {
  const key = personKey(hrId);
  return key ? (offers.find((offer) => personKey(offer.hrId) === key) ?? null) : null;
}

/**
 * The slots a choice and its picks fill. Refuses the wrong number of people, someone the list never
 * offered, and two product managers on a chain.
 */
export function companyToStorage(input: {
  choice: VisitCompanyChoice;
  picked: ReadonlyArray<string>;
  offers: ReadonlyArray<CompanyOffer>;
}): CompanyResult {
  const picked = distinct(input.picked);
  const none: CompanyStorage = { kind: "single", managerHrId: null, seniorHrId: null, productManagerHrId: null };
  if (input.choice === "single") return picked.length === 0 ? { ok: true, value: none } : { ok: false, error: COMPANY_NOT_OFFERED };

  const people = picked.map((hrId) => offered(input.offers, hrId));
  if (people.some((person) => person === null)) return { ok: false, error: COMPANY_NOT_OFFERED };
  const chosen = people as CompanyOffer[];

  if (input.choice === "double") {
    if (chosen.length !== 1) return { ok: false, error: CHOOSE_ONE_FOR_DOUBLE };
    const [only] = chosen;
    return only.role === "product_manager"
      ? { ok: true, value: { kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: only.hrId } }
      : { ok: true, value: { kind: "double", managerHrId: only.hrId, seniorHrId: null, productManagerHrId: null } };
  }

  if (chosen.length !== 2) return { ok: false, error: CHOOSE_TWO_FOR_CHAIN };
  const managers = chosen.filter((person) => person.role === "manager");
  const productManagers = chosen.filter((person) => person.role === "product_manager");
  if (productManagers.length > 1) return { ok: false, error: ONE_PRODUCT_MANAGER_ON_A_CHAIN };
  if (productManagers.length === 1) {
    return { ok: true, value: { kind: "chain", managerHrId: managers[0].hrId, seniorHrId: null, productManagerHrId: productManagers[0].hrId } };
  }
  // Two managers: the nearer one is the visit's manager and the one above him its senior, the shape
  // every chain visit has always had (the senior sits ABOVE the manager).
  const [nearer, farther] = [...managers].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  return { ok: true, value: { kind: "chain", managerHrId: nearer.hrId, seniorHrId: farther.hrId, productManagerHrId: null } };
}

/** What a stored visit reads as: the choice and the people to tick, for a form that opens on it. */
export function companyFromStorage(visit: {
  kind: PhoenixCrmVisitKind;
  managerHrId: string | null;
  seniorHrId: string | null;
  productManagerHrId: string | null;
}): { choice: VisitCompanyChoice; picked: string[] } {
  const filled = (...ids: Array<string | null>) => ids.filter((id): id is string => Boolean(id));
  if (visit.kind === "double") return { choice: "double", picked: filled(visit.managerHrId) };
  // The same one-person choice: a product manager under "Double visit" is how the rep put it.
  if (visit.kind === "product_manager") return { choice: "double", picked: filled(visit.productManagerHrId) };
  if (visit.kind === "chain") return { choice: "chain", picked: filled(visit.managerHrId, visit.seniorHrId, visit.productManagerHrId) };
  return { choice: "single", picked: [] };
}

/**
 * The picks a toggle leaves: ticking a person who is ticked takes him off; ticking another when the
 * choice is full changes nothing (the picker disables them, this is the same rule for a stray press);
 * a double has one place, so a new pick replaces the old.
 */
export function togglePick(choice: VisitCompanyChoice, picked: ReadonlyArray<string>, hrId: string): string[] {
  if (choice === "single") return [];
  const key = personKey(hrId);
  if (!key) return [...picked];
  if (picked.some((entry) => personKey(entry) === key)) return picked.filter((entry) => personKey(entry) !== key);
  if (choice === "double") return [hrId];
  return picked.length >= COMPANY_PICKS.chain ? [...picked] : [...picked, hrId];
}

/**
 * Whether this person can still be ticked: not when the choice is full, and not a second product
 * manager on a chain. A ticked person stays tickable so he can be taken off.
 */
export function canPick(
  choice: VisitCompanyChoice,
  picked: ReadonlyArray<string>,
  person: { hrId: string; role: "manager" | "product_manager" },
  offers: ReadonlyArray<CompanyOffer>,
): boolean {
  const key = personKey(person.hrId);
  if (picked.some((entry) => personKey(entry) === key)) return true;
  if (choice === "single") return false;
  if (choice === "double") return true;
  if (picked.length >= COMPANY_PICKS.chain) return false;
  if (person.role === "product_manager") {
    return !picked.some((entry) => offered(offers, entry)?.role === "product_manager");
  }
  return true;
}
