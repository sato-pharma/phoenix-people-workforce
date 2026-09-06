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

/** True once this person has dismissed the push opt-in nudge — permanently, per the owner's rule
 * that a nudge asked more than once becomes wallpaper. Never re-shown after this, on any device. */
export function isPushOptInNudgeDismissed(modulePreferences: Record<string, unknown> | null | undefined): boolean {
  return typeof modulePreferences?.[PUSH_OPT_IN_NUDGE_DISMISSED_KEY] === "string";
}

/**
 * Whether the nudge should be offered right now, given the same two facts the Notification
 * Settings panel already has: how many ACTIVE (`status = "subscribed"`) devices this person has,
 * and their own module preferences.
 *
 * `deviceCount > 0` is the whole "already enabled" check: `mapPushState` (settings.ts) only
 * counts rows whose status is `"subscribed"`, so a person who once enabled push and later revoked
 * it is NOT considered already-subscribed and can still be offered the nudge.
 */
export function shouldShowPushOptInNudge(input: {
  deviceCount: number;
  modulePreferences: Record<string, unknown> | null | undefined;
}): boolean {
  if (input.deviceCount > 0) return false;
  return !isPushOptInNudgeDismissed(input.modulePreferences);
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
