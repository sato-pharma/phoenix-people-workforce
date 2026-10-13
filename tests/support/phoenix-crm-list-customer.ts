import type { ListCustomer } from "../../src/lib/phoenix-crm/server/list.ts";

/**
 * ONE complete `ListCustomer`, for every test that needs one.
 *
 * WHY THIS EXISTS. Two test files each built their own full `ListCustomer` literal, and the type is
 * ~30 fields and still growing. `tsc` went red three times on 2026-09-30 alone — `sharedWith` +
 * `observed`, then `planPattern`, then `referenceHistory` — and each round was a full CI run on a PR
 * whose actual change was fine. Both files carried the same pasted warning telling the next person to
 * remember two places; a warning that has been ignored three times is not a control.
 *
 * WHAT IT CANNOT DO, said plainly: TypeScript has no runtime reflection, so no helper can *invent* a
 * default for a field it has never heard of. A new field still has to be given a value by hand. What
 * changes is WHERE and HOW LOUDLY:
 *
 *   * ONE place instead of two, so the cost of widening `ListCustomer` is halved and the two copies
 *     can no longer drift apart from each other;
 *   * and the failure lands HERE, on an annotated literal, so `tsc` says
 *     `Property 'planPattern' is missing in type ... but required in type 'ListCustomer'` — naming
 *     the field. That is the whole gain over what it said before, at a call site in another file:
 *     `Type '{ customerId: string; ... 24 more ...; }' is not assignable to type 'ListCustomer'`,
 *     which names nothing and sent three sessions reading the diff to work out what was missing.
 *
 * So: widening `ListCustomer`? Add the field once, here, and every fixture in the repo keeps working.
 */
export const LIST_CUSTOMER_BASE: ListCustomer = {
  customerId: "c",
  listType: "PM",
  name: "Dr Test",
  speciality: null,
  grade: null,
  origin: "reference",
  referenceContactCrmId: null,
  status: "active",
  section: "your_list",
  potentialGrade: null,
  validatedAt: null,
  validatedByName: null,
  reference: null,
  intake: null,
  droppedReason: null,
  droppedNote: null,
  statusChangedAt: "2026-09-01T00:00:00Z",
  places: [],
  visitsThisMonth: 0,
  target: null,
  tier: 0,
  sharedWith: null,
  observed: null,
  planPattern: null,
  referenceHistory: null,
  pendingGradeRequestId: null,
  pendingGrade: null,
  pendingDropRequestId: null,
  waiting: [],
  locationCheck: null,
  reopenedAt: null,
  validateAgainReason: null,
  primaryPharmacyName: null,
  phone: null,
  pharmacies: [],
  // A pharmacy's own pin (owner, 2026-10-09) — null here because this base is a DOCTOR, and a doctor
  // can never hold one: the `pharmacy_pin_is_a_pharmacy` check refuses it in the database.
  pharmacyPin: null,
  // The comments his manager chose to let him read (owner, 2026-10-13). Empty here, and that is the
  // honest default: `loadRepVisiblePlaceNotes` filters `rep_visible` in the QUERY, so a customer
  // nobody has commented on — and one whose every comment was marked unseen — arrives with exactly
  // this.
  notes: [],
};

/**
 * A `ListCustomer` with `overrides` applied over the base.
 *
 * The spread order is what makes this work at all. A literal that ENDS in `...overrides` is not
 * assignable to `ListCustomer` unless it also lists every field, because `Partial<ListCustomer>`
 * carries `| undefined` on each property — which is exactly the trap both test files were written
 * around, and exactly why they had to restate the whole type. Spreading over a COMPLETE object
 * instead, TypeScript resolves each optional property back to the base's type, so the result is a
 * `ListCustomer` without anything being restated.
 */
export function listCustomer(overrides: Partial<ListCustomer> = {}): ListCustomer {
  return { ...LIST_CUSTOMER_BASE, ...overrides };
}
