// The job title an ACCOUNT is shown as, where its permission key is not the person's title.
//
// `displayTitleForRole` in hr-functions.ts answers that question for a SEAT: "HR Advisory" is a
// permission key and the person holding it is an HR Business Partner. This module answers it for
// an ACCOUNT, which is the case a seat map cannot serve — "Super Admin" is held by two logins and
// only one of them is a human being with a job title.
//
// The owner, 2026-09-04: "in B-10 account, make his title as HR Section Head, not Super Admin."
// B-10 is his own employee account, `employees.job_title` has read HR Section Head all along, and
// every screen showing SUPER ADMIN was printing the permission key at him instead.
//
// IT IS KEYED ON THE ACCOUNT — not on the role, and not on the person.
//   - Not the role: the same "Super Admin" key belongs to the shared system console (login
//     admin-HR), which is a console rather than someone with a title.
//   - Not the person: `identity-aliases.ts` declares B-10 and that console to be one human, and
//     the group could have been reused here. He named the ACCOUNT, and the console's `hr_id` is
//     NULL anyway (see the admin-HR canary), so it has nothing to key on. Signed in there he keeps
//     reading "Super Admin", which is what that login is.
//
// IT IS DISPLAY ONLY AND MUST STAY THAT WAY. Every gate reads `access.role`; this string never
// reaches one. `employees.job_title` is deliberately NOT read here even though it holds the same
// value — this runs on every authenticated page render, and a database round trip to print a label
// the owner can state in one line is not a trade worth making. If the two ever disagree, the
// employee record is the one to correct.

import { displayTitleForRole } from "@/lib/auth/hr-functions";
import { canonicalHrIdKey } from "@/lib/hr-id";

/** Keys are `canonicalHrIdKey` output — lowercase — because HR ids are stored mixed-case. */
const ACCOUNT_JOB_TITLES: Readonly<Record<string, string>> = {
  "b-10": "HR Section Head",
};

/** The declared title for this account, or null when it has none (almost every account). */
export function accountJobTitle(hrId: string | null | undefined): string | null {
  const key = canonicalHrIdKey(hrId);
  if (!key) return null;
  return ACCOUNT_JOB_TITLES[key] ?? null;
}

/**
 * The label to SHOW for a signed-in person: their account's declared job title when it has one,
 * otherwise whatever `displayTitleForRole` makes of the permission key. Callers pass both because
 * an account without a declared title must still read as its seat.
 */
export function displayTitleForAccount(
  hrId: string | null | undefined,
  role: string | null | undefined,
): string {
  return accountJobTitle(hrId) ?? displayTitleForRole(role);
}
