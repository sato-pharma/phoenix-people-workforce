// People the owner has asked not to be emailed about SALES, regardless of their employment status.
//
// This is deliberately NOT an employment-status change and NOT a seat change: the person's HR
// record, organogram seat and vacancy all stay exactly as they are. They are simply away, and the
// owner does not want the sales announcements reaching them while they are.
//
// WHY THIS IS ONE MODULE RATHER THAN A CONSTANT IN EACH SENDER
// The decision is about a PERSON, not about one email. It was made for the Monthly Closing publish
// on 2026-08-08 and extended to the weekly upload notification on 2026-09-09, and the two senders
// resolve their recipients from the same organogram seats — so the same person reappears in both
// lists for the same reason. Two hand-maintained copies drift, and the copy nobody remembers is the
// one that keeps mailing somebody the owner asked to leave alone. There is one list, and removing a
// person from it when they return is therefore one edit rather than a hunt.
//
// This does NOT reach outside sales announcements. Payroll, HR lifecycle and anything the person
// themselves initiates are untouched — being on long vacation must never withhold a payslip or an
// answer to a request they made.

import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * Excluded from sales announcement emails. Remove a person's HR_ID here once they are back, and
 * both senders start including them again with no other change.
 */
const EXCLUDED_HR_IDS = [
  "B-156", // Sara Samir Jacoub Yohana — long vacation, expected back. Owner, 2026-08-08 (monthly
  //          closing publish) and 2026-09-09 (weekly upload notification).
] as const;

const EXCLUDED_KEYS: ReadonlySet<string> = new Set(
  EXCLUDED_HR_IDS.map((hrId) => canonicalHrIdKey(hrId)).filter((key): key is string => Boolean(key)),
);

/**
 * Should this person be left out of a sales announcement email?
 *
 * Compares on the CANONICAL key, never the literal string. HR ids are stored in mixed case across
 * tables, so a raw `Set.has(hrId)` answers false for `b-156` while answering true for `B-156` — and
 * the failure direction is the bad one: the exclusion silently stops applying and the mail goes out.
 */
export function isSalesNotificationExcluded(hrId: string | null | undefined): boolean {
  const key = canonicalHrIdKey(hrId);
  return key != null && EXCLUDED_KEYS.has(key);
}

/** The raw list, for tests and for any screen that needs to explain why somebody is missing. */
export function salesNotificationExclusions(): string[] {
  return [...EXCLUDED_HR_IDS];
}
