/**
 * Phoenix CRM — who was on a visit, said as the rep says it: Single, Double (ONE person), Chain (TWO OR MORE).
 *
 * Owner, 2026-10-06: "if he chooses double visit, his district manager appear, the product manager
 * appear, the national sales manager appear, and he can choose only one. And if applicable, the
 * regional manager. Also in the chain visit, all those appear, but he can choose two, not one."
 * Owner, 2026-10-27: "Everything is applicable" — a chain is two OR MORE, in any mix.
 *
 * So the rep faces ONE list — the managers above his territory (district, regional where his line has
 * one, national) and the product side of his line (product, group product, training) — and the choice
 * only sets how many to tick:
 *
 *   single   nobody                       →  kind `single`
 *   double   exactly one of the list      →  a manager: kind `double`      · the product side: kind `product_manager`
 *   chain    two or more of the list      →  a manager among them: kind `chain` (the nearest manager in
 *                                              `manager_hr_id`, the next one up in `senior_hr_id`, the first
 *                                              product-side person in his OWN column) · product side only:
 *                                              kind `product_manager`
 *
 * 🔴 EVERYONE WHO CAME IS IN `companions` — the rep with his District Sales Manager, the Regional Sales
 * Manager, the Product Manager, the Group Product Manager and the Training Manager is ONE visit with five
 * people on it. The three fixed places hold the first of each, so every reader that names "the manager"
 * keeps working; `phoenix_crm_visit_companions` holds them all, and `crm_visits_unified.companion_hr_ids`
 * is what a reader credits.
 *
 * 🔴 THE STORED SHAPE IS UNCHANGED WHERE IT MATTERED. A product manager is NEVER in `manager_hr_id`
 * (owner's pick, 2026-10-02): `double_visits` is counted from `kind = 'double'` on every board, a figure
 * district managers are judged on, so a double visit WITH a product manager is filed as the
 * `product_manager` kind it always was. The rep never sees that word: he ticked one person under
 * "Double visit", and the kind is derived here from who it was.
 *
 * A visit takes at most twelve people besides the rep (`MOST_ON_A_VISIT`), the database's own cap.
 *
 * Pure: no I/O. The server re-derives and re-checks all of it (scope.ts `resolveVisitParticipants`);
 * this is the shared arithmetic the form, the Super Admin's edit and the tests read.
 */

import { MOST_ON_A_VISIT, personKey } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";

export type VisitCompanyChoice = "single" | "double" | "chain";

/** The fewest people each choice takes. */
export const COMPANY_PICKS: Readonly<Record<VisitCompanyChoice, number>> = { single: 0, double: 1, chain: 2 };

/** The most people one visit carries besides the rep (scope.ts owns it; the server checks the same number). */
export { MOST_ON_A_VISIT };

/** The most people each choice takes. */
export const COMPANY_MOST: Readonly<Record<VisitCompanyChoice, number>> = { single: 0, double: 1, chain: MOST_ON_A_VISIT };

/** One person the list offers. `position` is a manager's place above the territory, nearest first; null for the product side. */
export type CompanyOffer = { hrId: string; role: "manager" | "product_manager"; position: number | null };

/** Which side of the company a person came from: the management line, or the product side (product, group product, training). */
export type CompanionSide = "manager" | "product";

/** One person on the visit besides the rep, in the order the visit lists them. */
export type VisitCompanion = { hrId: string; side: CompanionSide };

/** The slots a visit stores, and everyone on it. */
export type CompanyStorage = {
  kind: PhoenixCrmVisitKind;
  managerHrId: string | null;
  seniorHrId: string | null;
  productManagerHrId: string | null;
  /** Everyone besides the rep: managers nearest first, then the product side in the order ticked. */
  companions: VisitCompanion[];
};

export type CompanyResult = { ok: true; value: CompanyStorage } | { ok: false; error: string };

export const CHOOSE_ONE_FOR_DOUBLE = "Choose the one person who was on the double visit.";
export const CHOOSE_TWO_FOR_CHAIN = "Choose the two or more people who were on the chain visit.";
export const COMPANY_NOT_OFFERED = "Choose someone from the list. Reload the page.";
export const TOO_MANY_ON_A_VISIT = `A visit takes at most ${MOST_ON_A_VISIT} people besides the rep.`;

/** What the picker says under the choice: how many to tick. */
export function companyHint(choice: VisitCompanyChoice, picked: number): string {
  if (choice === "single") return "";
  return choice === "double" ? "Choose one." : `Choose two or more — ${picked} chosen.`;
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

/** The side a person the list offered comes from. */
function sideOf(person: CompanyOffer): CompanionSide {
  return person.role === "manager" ? "manager" : "product";
}

/**
 * The slots a choice and its picks fill, and everyone on the visit. Refuses the wrong number of people
 * and someone the list never offered.
 */
export function companyToStorage(input: {
  choice: VisitCompanyChoice;
  picked: ReadonlyArray<string>;
  offers: ReadonlyArray<CompanyOffer>;
}): CompanyResult {
  const picked = distinct(input.picked);
  const none: CompanyStorage = { kind: "single", managerHrId: null, seniorHrId: null, productManagerHrId: null, companions: [] };
  if (input.choice === "single") return picked.length === 0 ? { ok: true, value: none } : { ok: false, error: COMPANY_NOT_OFFERED };

  const people = picked.map((hrId) => offered(input.offers, hrId));
  if (people.some((person) => person === null)) return { ok: false, error: COMPANY_NOT_OFFERED };
  const chosen = people as CompanyOffer[];

  if (input.choice === "double") {
    if (chosen.length !== 1) return { ok: false, error: CHOOSE_ONE_FOR_DOUBLE };
    const [only] = chosen;
    const companions = [{ hrId: only.hrId, side: sideOf(only) }];
    return only.role === "product_manager"
      ? { ok: true, value: { kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: only.hrId, companions } }
      : { ok: true, value: { kind: "double", managerHrId: only.hrId, seniorHrId: null, productManagerHrId: null, companions } };
  }

  if (chosen.length < COMPANY_PICKS.chain) return { ok: false, error: CHOOSE_TWO_FOR_CHAIN };
  if (chosen.length > COMPANY_MOST.chain) return { ok: false, error: TOO_MANY_ON_A_VISIT };
  // Managers nearest the territory first — the senior sits ABOVE the manager, the shape every chain has
  // always had — then the product side in the order ticked.
  const managers = chosen.filter((person) => person.role === "manager").sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
  const productSide = chosen.filter((person) => person.role === "product_manager");
  const companions = [...managers, ...productSide].map((person) => ({ hrId: person.hrId, side: sideOf(person) }));
  if (managers.length === 0) {
    // The product side alone is the product-manager kind however many came: `double_visits` counts a
    // manager, and nobody from the management line was there.
    return { ok: true, value: { kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: productSide[0].hrId, companions } };
  }
  return {
    ok: true,
    value: {
      kind: "chain",
      managerHrId: managers[0].hrId,
      seniorHrId: managers[1]?.hrId ?? null,
      productManagerHrId: productSide[0]?.hrId ?? null,
      companions,
    },
  };
}

/** What a stored visit reads as: the choice and the people to tick, for a form that opens on it. */
export function companyFromStorage(visit: {
  kind: PhoenixCrmVisitKind;
  managerHrId: string | null;
  seniorHrId: string | null;
  productManagerHrId: string | null;
  /** Everyone on the visit (`phoenix_crm_visit_companion_ids`); absent on a visit read without it. */
  companionHrIds?: ReadonlyArray<string> | null;
}): { choice: VisitCompanyChoice; picked: string[] } {
  // The fixed places first, in their order, then everyone else who came — each person once.
  const picked = distinct(
    [visit.managerHrId, visit.seniorHrId, visit.productManagerHrId, ...(visit.companionHrIds ?? [])].filter((id): id is string => Boolean(id)),
  );
  if (visit.kind === "double") return { choice: "double", picked: picked.slice(0, 1) };
  // One product-side person is how the rep put it under "Double visit"; two or more is a chain.
  if (visit.kind === "product_manager") return picked.length > 1 ? { choice: "chain", picked } : { choice: "double", picked };
  if (visit.kind === "chain") return { choice: "chain", picked };
  return { choice: "single", picked: [] };
}

/**
 * The picks a toggle leaves: ticking a person who is ticked takes him off; ticking another when the
 * visit is full (`MOST_ON_A_VISIT`) changes nothing; a double has one place, so a new pick replaces the
 * old.
 */
export function togglePick(choice: VisitCompanyChoice, picked: ReadonlyArray<string>, hrId: string): string[] {
  if (choice === "single") return [];
  const key = personKey(hrId);
  if (!key) return [...picked];
  if (picked.some((entry) => personKey(entry) === key)) return picked.filter((entry) => personKey(entry) !== key);
  if (choice === "double") return [hrId];
  return picked.length >= COMPANY_MOST.chain ? [...picked] : [...picked, hrId];
}

/**
 * Whether this person can still be ticked: not when the visit is full. Any mix of the list may go
 * together (owner, 2026-10-27: "Everything is applicable"). A ticked person stays tickable so he can be
 * taken off.
 */
export function canPick(choice: VisitCompanyChoice, picked: ReadonlyArray<string>, person: { hrId: string }): boolean {
  const key = personKey(person.hrId);
  if (picked.some((entry) => personKey(entry) === key)) return true;
  if (choice === "single") return false;
  if (choice === "double") return true;
  return picked.length < COMPANY_MOST.chain;
}
