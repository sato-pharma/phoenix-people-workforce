// Recruitment / ATS — the identity of ONE candidate alert.
//
// Split out of hiring-manager-notify.ts so it can be exercised without importing the notification
// stack, the Supabase client or the employee directory behind it. It is a pure function of its
// arguments and must stay that way: it reads no clock (the send instant is passed in) and touches
// no database, which is what lets tests/candidate-send-alert-identity.test.ts pin the behaviour
// this fixes in the required CI `validate` job rather than only in production.

import crypto from "node:crypto";

import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * The identity of ONE candidate alert, and the reason this function exists at all.
 *
 * WHAT WENT WRONG. createSystemNotification derives an event key from
 * {actionUrl, eventType, module, recipientHrId, recipientUserId, title} and upserts on it. Every
 * one of those is a CONSTANT for this flow — the title is literally "New candidate to review" — so
 * every send to the same manager hashed to the same key and OVERWROTE the previous alert in place.
 * Measured in production on 2026-08-30: 39 sends had produced 12 alerts. One National Sales Manager
 * received 17 candidates and one alert; two District Sales Managers received 7 each and one each.
 *
 * Three separate things follow from that one collision, and together they are exactly what the
 * owner reported — "not all the CVs reach the manager, and they take a long time to reach them":
 *
 *   • ONE LINE, NOT N. The bell shows a single item however many people were sent, and its message
 *     is rewritten to name only the newest — the earlier names are destroyed, not appended to.
 *   • FROZEN DATE. The upsert never touches created_at and the bell orders by created_at, so an
 *     alert first raised on 26 August still sorts as 26 August after being rewritten on the 30th —
 *     four days down the list, looking like nothing new. That is the "very late".
 *   • PERMANENTLY READ. Read state is keyed on the event id in notification_user_states, so once a
 *     manager opens the first alert, every later candidate quietly updates an already-read row. No
 *     badge and no unread count, ever again.
 *
 * THE CANDIDATES ARE THE IDENTITY. Hashing them in is what makes two different sends two different
 * alerts. Hashed rather than joined raw because the id list is unbounded (chunkIds exists for that
 * reason) and this key is concatenated into notification_deliveries.idempotency_key, which carries
 * a UNIQUE btree index — a large batch of raw UUIDs would exceed the index row limit and turn a
 * working send into a failed one.
 *
 * THE MINUTE BUCKET IS THE ONLY THING STILL DEDUPLICATED, and it is deliberate. A double-clicked
 * send repeats within the same minute and must not alert twice; a genuine re-send an hour later is
 * a recruiter deciding to nudge, and must. Keying on the candidates ALONE would have left a quieter
 * version of the same bug — the same CV re-sent to the same manager would go silent forever.
 */
export function candidateAlertIdempotencyKey(input: {
  candidateIds: readonly string[];
  eventType: string;
  managerHrId: string;
  /** The send instant, ISO. Passed in rather than read here so this stays a pure function. */
  sentAtIso: string;
}): string {
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        // Sorted, so the same batch picked in a different order is the same alert.
        candidateIds: [...input.candidateIds].sort(),
        eventType: input.eventType,
        managerHrId: canonicalHrIdKey(input.managerHrId) ?? String(input.managerHrId ?? "").trim().toLowerCase(),
        // "2026-08-30T09:01" — minute resolution.
        minute: String(input.sentAtIso ?? "").slice(0, 16),
      }),
    )
    .digest("hex");
  return `${input.eventType}:${fingerprint}`;
}
