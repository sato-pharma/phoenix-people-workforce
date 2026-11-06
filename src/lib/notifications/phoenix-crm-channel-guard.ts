import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-09-16, restated 2026-10-13): Phoenix CRM tells people IN-APP and by TELEGRAM only —
// and, since 2026-10-02, on the phone. It NEVER sends email. Email is blocked for the whole module, with no
// exception: "make phoenix crm send notifications through telegram and in app only, stop any email firing
// from phoenix crm" (owner, 2026-10-13).
//
// That ends every email exception the module ever had, in the order he gave them: the plan-edit steps
// (2026-10-01), a rep's first visit and his day start (2026-10-03), a place held for the Super Admin
// (2026-10-05), and every person-to-person step plus the reminders and nudges (2026-10-08). The list
// below is empty ON PURPOSE and stays an exported, pinned constant so that a future exception is a visible
// one-line change with a test to update, never a quiet new branch.
//
// Same shape, and for the same reason, as early-birds-channel-guard.ts: the policy row is the
// intent, this post-filter is the enforcement. Email re-enters the pipeline from an explicit
// call-site `channels`, from the code defaults in resolveBasePolicyChannels, and from the
// Telegram-failure fallback (`["email","in_app"]`) — and Telegram failing is the EXPECTED case for
// every rep and manager who has not linked it.
//
// Keyed on MODULE, so a notice added to the module later is covered the day it is written.

const PHOENIX_CRM_MODULE = "phoenix_crm";

/**
 * Event types that may email: NONE, and it stays empty (owner, 2026-11-06, his rule: "cut all phoenix crm
 * emails never sent a single email once again it only sends telegram and push and in app"). That ended the
 * module's last exception, the Administrator's decision on a recorded visit (given its email 2026-10-17),
 * which now reaches the rep and his managers in-app, by Telegram and on the phone like every other notice.
 *
 * Kept as an exported, pinned EMPTY constant so that any future email is a visible change with a red test
 * (`tests/phoenix-crm-email-block.test.ts`) — never a quiet new branch. Do not add to it.
 */
export const PHOENIX_CRM_EMAIL_EVENT_TYPES: readonly string[] = [];

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
export const PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES: readonly string[] = [
  "crm_daily_digest",
  "plan_edit_expired",
  // The district manager's ask to edit his week, ended unanswered with the week (owner, 2026-10-16): the
  // same daily expiry pass as the rep's, so the same two channels.
  "manager_plan_edit_expired",
  // His ask for another day of single visits, ended undecided with its day (owner, 2026-10-20): the same
  // daily expiry pass, so the same two channels.
  "manager_single_visit_day_expired",
  // The SFE Manager's copy of a rep's day start (owner, 2026-10-03): in-app and Telegram, nothing
  // else. It is on THIS list rather than merely absent from the email list because the
  // Telegram-failure fallback re-sends as `["email", "in_app"]` and an unlinked Telegram is the
  // EXPECTED case — so "off the email list" alone would mail him once per rep on exactly the days
  // Telegram fails. Here `phoenixCrmChannels` answers `["in_app", "telegram"]` and neither axis widens.
  "day_start_seen",
  // The activity mirror (owner, 2026-10-05): every Phoenix CRM action, to the national sales manager
  // and the SFE Managers — "in nsm and sfe i want every single action … sent to telegram to them". It
  // is a high-volume feed to the two widest-scope readers, so it is in-app and Telegram only, exactly
  // like the 06:55 digest: no phone, and the Telegram-failure fallback (email + in-app) is shut for it
  // too, which for an as-yet-unlinked manager is the expected case rather than an edge one.
  "activity_mirror",
  // The hourly routine-visit rollup (owner, 2026-10-05): the batched half of the same instruction —
  // routine planned visits (~600 a working day) gathered into one message an hour to the NSM and the
  // SFE Managers, rather than one notice each. In-app and Telegram only, exactly like the mirror and
  // the digest: no phone, and the Telegram-failure fallback shut so an unlinked manager is not mailed.
  "crm_visit_rollup",
  // The weekly visit-fraud scan (owner, 2026-10-07): the integrity board's flags for the completed
  // Sat–Wed week, to the Super Admin and the SFE Managers only. Like the digest and the rollup it
  // calls the notifier directly and is in-app and Telegram ONLY — the evidence is Golden Rule #1
  // material and must never reach a phone lock screen or an inbox, and the Telegram-failure fallback
  // is shut so an admin whose Telegram is not linked yet is not mailed the week's flags instead.
  "crm_fraud_scan",
  // The SFE Manager's own copy of a re-send, on the week HE returned (2026-10-08): he asked for the
  // change, and nothing told him it had come back — the plan's actionable notice is the reviewing
  // manager's, because the SFE returns a week and approves none. It is informational, so no phone; and
  // on THIS list rather than merely off the email list, because the Telegram-failure fallback would
  // mail him one per re-send and the module's emails are the four person-taken plan-edit steps plus a
  // rep's first visit, nothing else.
  "plan_resent",
];

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
 * The channels a Phoenix CRM notice asks for: in-app, Telegram and the phone — never email (the list
 * above is empty). Push since 2026-10-02 (owner): 16 of 74 reps had allowed Phoenix on their phone, and
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
