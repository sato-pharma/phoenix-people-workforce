import { isSamePerson } from "@/lib/auth/identity-aliases";
import type { SystemNotificationChannel } from "@/lib/notifications/system";

/**
 * "What needs you" is the owner's OWN board. Its email reaches exactly one person — B-10 — and
 * nobody else, ever.
 *
 * WHY A GUARD AND NOT JUST A POLICY ROW. The house pattern is two layers, and every sibling here
 * follows it: `phoenix-crm-channel-guard.ts`, `outstation-rejection-channel-guard.ts`,
 * `recruitment-candidate-assigned-channel-guard.ts`. The policy row states the INTENT; a post-filter
 * at the end of `basePolicyChannels` is the hard guarantee. Email re-enters the pipeline from more
 * than one place — an explicit `channels` argument at a call site, the code defaults inside
 * `resolveBasePolicyChannels`, and the Telegram-failure fallback, which is not exotic — so a rule
 * that lives only in the policy table is a rule with holes in it.
 *
 * What makes this one different from its siblings is the axis. They ask "may this MODULE send
 * email at all". This one keeps email and restricts WHO receives it, which is a sharper question:
 * the content is a list of the decisions waiting on the owner, and the failure it prevents is that
 * list landing in someone else's inbox. A sent email cannot be recalled.
 *
 * 🔴 IT FAILS CLOSED, AND THAT IS THE WHOLE DESIGN. Email survives only when the recipient is
 * PROVABLY B-10. An absent, empty or unresolved recipient strips email rather than allowing it,
 * because the two outcomes are not symmetric: a missing digest is noticed the next morning and
 * costs nothing, while a misdirected one has already happened and cannot be undone. Never rewrite
 * this as "strip email when the recipient is provably somebody else" — that reads more natural and
 * is exactly backwards.
 *
 * 🔴 `isSamePerson`, NOT STRING EQUALITY. B-10 also signs in as PHX-1 and admin-HR
 * (`src/lib/auth/identity-aliases.ts`). A raw `=== "B-10"` compare would strip email from the
 * owner's OWN digest whenever the console account resolved it — a guard that fails the one person
 * it exists to protect, silently, and only on some days.
 *
 * A hardcoded identity rather than an admin-editable audience, deliberately, and with precedent in
 * `src/lib/sales/closing-publish-recipients.ts` (`NAMED_BCC_HR_IDS`). Routing this through
 * `/admin/notification-recipients` would make "B-10 only" a SETTING — one that any admin screen
 * could widen later, quietly, with no test failing.
 */

export const NEEDS_YOU_MODULE = "needs_you";

/** The only person this module may ever email. */
export const NEEDS_YOU_EMAIL_HR_ID = "B-10";

export function isNeedsYouModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === NEEDS_YOU_MODULE;
}

/**
 * Drop `email` from a needs-you notification unless the recipient is provably the owner.
 *
 * Every other module is returned untouched — this guard owns one module and must never become a
 * general recipient filter, for the same reason its siblings each key on their own module string.
 */
export function enforceNeedsYouOwnerOnlyEmail(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  recipientHrId: string | null | undefined,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  if (!isNeedsYouModule(module)) return deduped;

  const resolved = String(recipientHrId ?? "").trim();
  // Fail closed: no recipient means not proven, and not proven means no email.
  if (resolved && isSamePerson(resolved, NEEDS_YOU_EMAIL_HR_ID)) return deduped;

  return deduped.filter((channel) => channel !== "email");
}
