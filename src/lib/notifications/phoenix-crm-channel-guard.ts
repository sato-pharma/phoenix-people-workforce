import type { SystemNotificationChannel } from "@/lib/notifications/system";

// Owner rule (2026-09-16): Phoenix CRM tells people IN-APP and by TELEGRAM only — a grade or drop
// request waiting for the district manager, a request decided, a weekly plan sent for review, a
// plan approved or returned. Email is blocked for the whole module.
//
// FIVE exceptions, each by the owner's own order. Those event types — and only those — keep their
// email. Every other Phoenix CRM notice, the 06:55 digest included, stays email-free. The fifth
// (2026-10-08) is every person-to-person step of a plan, a request, an off-plan visit and a visit ask;
// see the note at the end of the list below.
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
// (3) 2026-10-03: a rep's "Show your manager you started working", to his DISTRICT MANAGER only — see
// the note on `day_start_confirmed` below for why the SFE Manager's copy is a second event type.
//
// (4) 2026-10-05: a place the Google Maps check could not confirm, waiting on the Super Admin's own
// page — the owner, naming that page: "when an update here /admin/field-crm/validation-reviews I must
// be notified by email, in app and telegram". He is the module's ONE decider and its only recipient
// here, so this is the narrowest email in the module: one address, and only when something is actually
// waiting on his decision. Nothing about it reaches a rep.
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
 * no person takes, is not among them (owner, 2026-10-02) — a rep's first visit ever on the module and
 * his daily start to his district manager (owner, 2026-10-03), and a place held for the Super Admin's
 * decision (owner, 2026-10-05). Nothing else emails.
 */
export const PHOENIX_CRM_EMAIL_EVENT_TYPES: readonly string[] = [
  "plan_edit_waiting",
  "plan_edit_moved_on",
  "plan_edit_refused",
  "plan_edit_reopened",
  "first_visit_submitted",
  // (3) 2026-10-03: a rep presses "Show your manager you started working" before his first AM visit.
  // 🔴 THE ONLY REPEATING NOTICE ON THIS LIST, AND THE ONLY ONE WHOSE EMAIL REACHES FEWER PEOPLE THAN
  // THE NOTICE ITSELF. It fires every working day, so the owner — shown that the SFE Manager would take
  // one per rep, about 74 a morning once the module is company-wide, against ~5 for a district
  // manager — chose "all three channels, email to the district manager only". Channels are decided per
  // EVENT TYPE and never per recipient, so the SFE's copy is a SECOND type (`day_start_seen`,
  // push-blocked below) rather than a second recipient here. Adding the SFE to this type is the one
  // change that silently buries him.
  "day_start_confirmed",
  // (4) 2026-10-05: a place the Google Maps check could not confirm, waiting on the Super Admin's own
  // page (`/admin/field-crm/validation-reviews`) — the owner asked for "email, in app and telegram"
  // there by name. It is the only notice in the module whose recipient is the owner HIMSELF and nobody
  // else (`resolveHrIdsForRole("Super Admin")`, test logins filtered out), so the volume question that
  // narrowed `day_start_confirmed` does not arise: one address, and only while a decision is waiting.
  // The rep's side is untouched — he still reads only "the system is checking" (Golden Rule #1).
  "validation_review_waiting",
  // (5) 2026-10-08: "I need Telegram, in app, email for every action on CRM to the person responsible".
  // Every notice that tells ONE named person something about his own work or a decision waiting on him
  // now emails too: a weekly or monthly plan sent for review and its approval or return, a grade / drop /
  // add / restore request waiting and its decision, an off-plan visit waiting and each time it moves, and
  // a rep's ask for a visit and its answer. They are all person-to-person steps, a handful a day each —
  // not feeds. What stays OFF this list is what he has ruled in-app (and Telegram) only, by name: the
  // daily forecast alert, the courtesy copy of a visit ask, the SFE's day-start and re-send copies, the
  // plan-edit expiry, the rep's validate-again notice, the activity mirror, the hourly rollup, the 06:55
  // digest, the fraud scan and the plan reminders. A feed to the widest readers is a burial, not a notice.
  "plan_waiting",
  "plan_approved",
  "plan_returned",
  "monthly_plan_waiting",
  "monthly_plan_approved",
  "monthly_plan_returned",
  "grade_request_waiting",
  "drop_request_waiting",
  "add_request_waiting",
  "restore_request_waiting",
  "request_approved",
  "request_refused",
  "unplanned_visit_waiting",
  "unplanned_visit_approved",
  "unplanned_visit_refused",
  "unplanned_visit_moved_on",
  "visit_ask_waiting",
  "visit_ask_accepted",
  "visit_ask_declined",
  // (6) 2026-10-08, same day, asked about by name and answered "both": the plan reminder (12:57 and 17:57),
  // the daily approval nudge, and the rep's "validate this customer again". The last REVERSES his own
  // ruling from earlier that day (in-app only, never email or phone) — he chose it knowingly. Its wording
  // is unchanged and still about the photo alone (validation-feedback.ts), and it still carries no decider.
  "plan_reminder",
  "approval_nudge",
  "validation_not_confirmed",
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
export const PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES: readonly string[] = [
  "crm_daily_digest",
  "plan_edit_expired",
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
