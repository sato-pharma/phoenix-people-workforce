/**
 * What this browser last reported to push_subscriptions for one person — the pure half of the
 * OneSignal provider's memo (src/components/notifications/onesignal-provider.tsx).
 *
 * WHY (1 Nov 2026). The provider upserted the browser's subscription state into push_subscriptions
 * on EVERY page load, for every role: a request and a session read per page view to write a row that
 * had not changed since the last one. The memo remembers what was reported, for whom, and when; the
 * mount report is skipped while the memo says the same thing and is under a week old. A "change"
 * event never consults it — a changed subscription is always reported — and the memo's key names the
 * person (ownerScopedStorageKey), so a shared tablet registers again for whoever signs in next.
 */
export type PushRegistrationMemo = { id: string; optedIn: boolean; at: number };

/** A memo older than this is reported again, so push_subscriptions never goes stale for more than a week. */
export const PUSH_REGISTRATION_MEMO_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The stored memo, or null for anything that is not exactly one: a blocked read, old JSON, a hand edit. */
export function parsePushRegistrationMemo(raw: string | null | undefined): PushRegistrationMemo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PushRegistrationMemo> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    if (typeof parsed.optedIn !== "boolean" || typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    return { id: parsed.id, optedIn: parsed.optedIn, at: parsed.at };
  } catch {
    return null;
  }
}

/**
 * True when the mount report can be skipped: this browser already reported this exact state for this
 * person inside the last week. No memo, no subscription id, a different id or opt-in, a memo from the
 * future (a clock put back) or one older than the week all answer false — report.
 */
export function pushRegistrationAlreadyReported(
  memo: PushRegistrationMemo | null,
  current: { id: string | null; optedIn: boolean },
  now: number,
): boolean {
  if (!memo || !current.id) return false;
  if (memo.id !== current.id || memo.optedIn !== current.optedIn) return false;
  const age = now - memo.at;
  return age >= 0 && age < PUSH_REGISTRATION_MEMO_MAX_AGE_MS;
}
