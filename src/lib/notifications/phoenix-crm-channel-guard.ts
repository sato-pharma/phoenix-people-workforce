import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-09-16): Phoenix CRM tells people IN-APP and by TELEGRAM only — a grade or drop
// request waiting for the district manager, a request decided, a weekly plan sent for review, a
// plan approved or returned. Email is blocked for the whole module.
//
// TWO exceptions, each by the owner's own order. Those event types — and only those — keep their
// email. Every other Phoenix CRM notice, the 06:55 digest included, stays email-free.
//
// (1) 2026-10-01: a rep's request to edit a week he already sent runs the district manager → SFE → HR,
// and "every step" goes by email, in-app and Telegram to the next person to act, the rep, the district
// manager and SFE.
//
// (2) 2026-10-03: the FIRST visit a rep ever submits on Phoenix CRM emails his district manager, his
// national sales manager and the SFE Manager, with the owner on the BCC — and the BCC needs nothing
// here, because `sendPhoenixEmail` puts the standing admin on every email the system sends. It is an
// adoption notice, not a decision: ONE per rep, ever, and nothing waits on anybody who gets it.
//
// 🔴 IT IS FOUR, NOT FIVE, SINCE 2026-10-02: the owner was asked directly whether the daily expiry
// pass should email when it closes a request whose week has passed, and chose "in-app and Telegram
// only, no email". An expiry is not a step anybody took, so there is no decision to send out — and
// the pass closes them in a batch, which is exactly the unprompted-bulk shape he has ruled out
// standing. `plan_edit_expired` therefore moved to the push-blocked list below, where "only" is
// enforced on both axes, the way his 06:55 digest ruling already is.
//
// Same shape, and for the same reason, as early-birds-channel-guard.ts: the policy row is the
// intent, this post-filter is the enforcement. Email re-enters the pipeline from an explicit
// call-site `channels`, from the code defaults in resolveBasePolicyChannels, and from the
// Telegram-failure fallback (`["email","in_app"]`) — and Telegram failing is the EXPECTED case for
// every rep and manager who has not linked it.
//
// Keyed on MODULE, so a notice added to the module later is covered the day it is written — and the
// exception on the exact event type, so it cannot widen by accident.

const PHOENIX_CRM_MODULE = "phoenix_crm";

/**
 * The request to edit a sent week, at each step a PERSON takes (owner, 2026-10-01) — the expiry, which
 * no person takes, is not among them (owner, 2026-10-02) — and a rep's first visit ever on the module
 * (owner, 2026-10-03). Nothing else emails.
 */
export const PHOENIX_CRM_EMAIL_EVENT_TYPES: readonly string[] = [
  "plan_edit_waiting",
  "plan_edit_moved_on",
  "plan_edit_refused",
  "plan_edit_reopened",
  "first_visit_submitted",
];

/**
 * The notices the owner has said are "in-app and Telegram ONLY", which on this module means they are
 * barred from email (above) AND from the phone. Everything else in the module gained push on
 * 2026-10-02, when 16 of 74 reps had allowed Phoenix on their phone and Telegram reached none of them.
 *
 *   crm_daily_digest   — owner, 2026-09-28: "i want it in app or telegram only".
 *   plan_edit_expired  — owner, 2026-10-02, asked directly about the daily expiry pass.
 *
 * 🔴 ASKING FOR THE RIGHT CHANNELS AT THE CALL SITE IS NOT ENOUGH, which is why this list exists.
 * `daily-digest.ts` asks for `["in_app", "telegram"]` — and when Telegram fails PERMANENTLY, which
 * for an unlinked manager is the expected case, `system.ts` re-sends the same notice as
 * `["email", "in_app", "push"]`. Email was filtered out by the block below; push was not, so the
 * digest arrived on the phone by the back door. Same shape as the email ban, one axis over.
 */
export const PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES: readonly string[] = ["crm_daily_digest", "plan_edit_expired"];

export function isPhoenixCrmModule(module: string | null | undefined): boolean {
  return String(module ?? "").trim().toLowerCase() === PHOENIX_CRM_MODULE;
}

function emailAllowed(eventType: string | null | undefined): boolean {
  return PHOENIX_CRM_EMAIL_EVENT_TYPES.includes(String(eventType ?? "").trim().toLowerCase());
}

function pushBlocked(eventType: string | null | undefined): boolean {
  return PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES.includes(String(eventType ?? "").trim().toLowerCase());
}

/**
 * The channels a Phoenix CRM notice asks for: in-app, Telegram and the phone, and email only for the
 * five above. Push since 2026-10-02 (owner): 16 of 74 reps had allowed Phoenix on their phone, and
 * Telegram reached none of them.
 *
 * A notice on the push-blocked list asks for in-app and Telegram and nothing else, so his "only" is
 * true at the CALL SITE as well as in the enforcement below. The 06:55 digest does not come through
 * here at all — it names its own two channels — and the enforcement covers it either way.
 */
export function phoenixCrmChannels(eventType: string, inAppOnly = false): SystemNotificationChannel[] {
  if (inAppOnly) return ["in_app"];
  if (pushBlocked(eventType)) return ["in_app", "telegram"];
  return emailAllowed(eventType) ? ["in_app", "email", "telegram", "push"] : ["in_app", "telegram", "push"];
}

export function enforcePhoenixCrmEmailBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType?: string | null,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  if (!isPhoenixCrmModule(module) || emailAllowed(eventType)) return deduped;
  return deduped.filter((channel) => channel !== "email");
}

/**
 * The same hard guarantee on the PUSH axis, for the notices in the list above — chained after the
 * email block rather than folded into it, the way every other guard in `basePolicyChannels` is: the
 * two cover disjoint sets, and collapsing them would silently restore whichever one lost.
 */
export function enforcePhoenixCrmPushBlock(
  channels: readonly SystemNotificationChannel[],
  module: string | null | undefined,
  eventType?: string | null,
): SystemNotificationChannel[] {
  const deduped = Array.from(new Set(channels));
  if (!isPhoenixCrmModule(module) || !pushBlocked(eventType)) return deduped;
  return deduped.filter((channel) => channel !== "push");
}

/**
 * Whether a FAILED Telegram delivery may be covered by the email/in-app/push re-send.
 *
 * False for an "in-app and Telegram only" notice, and for that one reason: BOTH channels the re-send
 * adds are banned for it, so the whole fallback can only re-deliver the in-app copy the first send
 * already made — a second bell row every time Telegram fails, which for an unlinked recipient is
 * every time. Stripping the channels without stopping the re-send fixes the leak and leaves the noise.
 */
export function phoenixCrmBlocksTelegramFallback(module: string | null | undefined, eventType?: string | null): boolean {
  return isPhoenixCrmModule(module) && pushBlocked(eventType);
}
