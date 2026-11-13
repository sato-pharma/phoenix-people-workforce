// Pure decision rules for the push opt-in nudge — deliberately its own module with NO server-only
// imports (no Supabase client, no `crypto`, no audit log), because it is imported from BOTH sides:
//
//   * src/lib/notifications/settings.ts (server) — to build the module_preferences payload it
//     writes when a person dismisses the nudge.
//   * src/components/notifications/push-opt-in-nudge.tsx ("use client") — to decide, in the
//     browser, whether to render the card at all.
//
// Importing these functions straight from settings.ts on the client side is exactly the mistake
// this file exists to prevent: settings.ts pulls in getSupabaseAdmin, writeAuditLog and the
// `crypto` node built-in, and Next's webpack bundler tries to drag that whole graph into the
// client bundle the moment a "use client" component imports anything from that file — surfaced
// immediately as "UnhandledSchemeError: Reading from 'node:crypto' is not handled by plugins"
// while building the employee-portal bundle. Keeping the rules here, with no such imports, is what
// lets the client component depend on the RULE without depending on the SERVER.

/** Key inside `notification_preferences.module_preferences`. Own key, own module: nothing else
 * in that JSON blob means "this exact card was dismissed". */
export const PUSH_OPT_IN_NUDGE_DISMISSED_KEY = "pushOptInNudgeDismissedAt";

/** True once this person has answered the push opt-in nudge: closed it, or turned push on through it.
 * The answer stands until a device that was receiving push stops (`pushWasDroppedSinceAnswer`). */
export function isPushOptInNudgeDismissed(modulePreferences: Record<string, unknown> | null | undefined): boolean {
  return typeof modulePreferences?.[PUSH_OPT_IN_NUDGE_DISMISSED_KEY] === "string";
}

/** The answer and the device's own record are written by two requests seconds apart; either may land first. */
export const PUSH_RE_ASK_SLACK_MS = 2 * 60_000;

/**
 * Did a device that was receiving push stop, after this person last answered the card?
 *
 * Owner, 13 Nov 2026 (integration audit): "Ask again after a drop". Measured on production that day: 97
 * devices receiving push and 303 rows of devices that had stopped; 63 of the 130 people who ever turned
 * push on had no device left, and the card, answered once, never told any of them.
 *
 * `lastDroppedSubscribedAt` is when the most recent device that no longer receives push was last seen
 * receiving it (`mapPushState`, settings.ts). If that is at or after the answer, the device was working
 * since the person answered and has stopped since: ask again. Answering again moves the answer past it,
 * so one drop is asked about once.
 *
 * 🔴 NEVER READ `unsubscribed_at` FOR THIS. `upsertPushSubscription` stamps it again on EVERY page load of
 * a browser that is not receiving push, so it is always newer than any answer and the card would come
 * back on every visit, for ever. `subscribed_at` is stamped only while a device IS receiving, so on a
 * dropped device it stops moving.
 */
export function pushWasDroppedSinceAnswer(answeredAtIso: string, lastDroppedSubscribedAt: string | null | undefined): boolean {
  if (typeof lastDroppedSubscribedAt !== "string") return false;
  const answered = Date.parse(answeredAtIso);
  const lastReceiving = Date.parse(lastDroppedSubscribedAt);
  // A date nobody can read is never a reason to ask: silence, rather than a card that will not go away.
  if (!Number.isFinite(answered) || !Number.isFinite(lastReceiving)) return false;
  return lastReceiving >= answered - PUSH_RE_ASK_SLACK_MS;
}

/**
 * Whether the nudge should be offered right now, from three facts the settings read hands the card:
 * how many devices are receiving push now (`status = "subscribed"`), the person's own module
 * preferences, and when their most recently dropped device was last receiving.
 *
 *   - a device receiving now: never asked;
 *   - no device and never answered: asked;
 *   - no device and answered: asked again only when a device dropped since the answer.
 */
export function shouldShowPushOptInNudge(input: {
  deviceCount: number;
  modulePreferences: Record<string, unknown> | null | undefined;
  lastDroppedSubscribedAt?: string | null;
}): boolean {
  if (input.deviceCount > 0) return false;
  const answeredAt = input.modulePreferences?.[PUSH_OPT_IN_NUDGE_DISMISSED_KEY];
  if (typeof answeredAt !== "string") return true;
  return pushWasDroppedSinceAnswer(answeredAt, input.lastDroppedSubscribedAt);
}

/** Merges the dismissal timestamp into an existing `module_preferences` object without touching
 * any other key some other feature may have written there. Exported so the write path
 * (`dismissPushOptInNudge` in settings.ts) and its test use the exact same merge, never two
 * copies that can drift apart. */
export function withPushOptInNudgeDismissed(
  modulePreferences: Record<string, unknown> | null | undefined,
  dismissedAtIso: string,
): Record<string, unknown> {
  const current = modulePreferences && typeof modulePreferences === "object" ? modulePreferences : {};
  return { ...current, [PUSH_OPT_IN_NUDGE_DISMISSED_KEY]: dismissedAtIso };
}
