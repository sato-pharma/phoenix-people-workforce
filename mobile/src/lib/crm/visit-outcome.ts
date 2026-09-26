/**
 * Phoenix CRM — the objection and the next step, on the phone.
 *
 * The transcription of `src/lib/phoenix-crm/visit-outcome.ts`. `mobile/tsconfig.json` maps `@/*` to
 * `mobile/src/*` only, so nothing here can import the web tree; every shared vocabulary in this app is
 * a second copy kept honest by a test. This one is pinned by `tests/phoenix-crm-visit-outcome.test.ts`,
 * which asserts the two lists are identical key for key and label for label — a drift here is silent,
 * and it would put a value into the database that the web's own screens cannot name.
 *
 * ONE DELIBERATE DIFFERENCE. The web offers an optional "by when" date beside a follow-up; the phone
 * does not. Expo has no date control in this app and adding one would mean a new native dependency to
 * make an already-optional field slightly more precise — against Golden Rule #1's EASY half, where the
 * phone is the simplest thing the rep touches. The column simply stays null from the phone.
 */

export const VISIT_NEXT_STEPS = [
  { key: "follow_up", label: "Follow up next visit" },
  { key: "send_data", label: "Send the data" },
  { key: "arrange_double", label: "Arrange a double visit" },
  { key: "invite_event", label: "Invite to an event" },
  { key: "pharmacy_stock", label: "Chase the pharmacy stock" },
  { key: "none", label: "Nothing to follow" },
] as const;

export const VISIT_OBJECTIONS = [
  { key: "price", label: "Price" },
  { key: "efficacy", label: "Not convinced it works" },
  { key: "safety", label: "Side effects or safety" },
  { key: "competitor", label: "Prescribes a competitor" },
  { key: "formulary", label: "Not on the hospital list" },
  { key: "no_time", label: "No time to listen" },
  { key: "none", label: "No objection" },
] as const;

export type VisitNextStep = (typeof VISIT_NEXT_STEPS)[number]["key"];
export type VisitObjection = (typeof VISIT_OBJECTIONS)[number]["key"];

export const OBJECTION_NOTE_MAX = 300;

/** `none` is an answer, so it is not something to do — the twin of the web's `isFollowUp`. */
export function isFollowUp(value: VisitNextStep | null): boolean {
  return value !== null && value !== "none";
}
