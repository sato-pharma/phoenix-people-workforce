// Read-receipts on digest notifications: has the employee actually opened
// the digest they were sent, before the 48h auto-confirm fires or before an
// admin decides to nudge them? Reuses the existing notification-engine
// tables rather than inventing a parallel tracking mechanism:
//   - notification_deliveries: one row per channel attempted for the send.
//   - notification_user_states.read_at: the in-app "mark as read" signal.
//   - email_delivery_events (event_type='email.opened'): the Resend
//     webhook-fed open-tracking signal, matched by provider_message_id.
// Telegram has no delivery-provider read signal today — those digests are
// reported "not tracked" for read status rather than a false negative.

import { getSupabaseAdmin } from "@/lib/supabase/server";

export async function recordDigestNotificationEvent(digestId: number, eventId: string | null): Promise<void> {
  if (!eventId) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("attendance_weekly_digests")
    .update({ notification_event_id: eventId })
    .eq("id", digestId);
  if (error) throw new Error(`Failed to record digest notification event: ${error.message}`);
}

export type DigestReadReceipt = {
  tracked: boolean;
  hasBeenRead: boolean;
  firstReadAt: string | null;
};

const NOT_TRACKED: DigestReadReceipt = { firstReadAt: null, hasBeenRead: false, tracked: false };

/**
 * Batched lookup keyed by notification_event_id — the settlement dashboard
 * calls this once for every pending digest rather than once per digest, so
 * the query count stays bounded regardless of how many digests are pending.
 */
export async function getReadReceiptsForEvents(eventIds: string[]): Promise<Map<string, DigestReadReceipt>> {
  const receipts = new Map<string, DigestReadReceipt>();
  const uniqueEventIds = Array.from(new Set(eventIds.filter(Boolean)));
  if (uniqueEventIds.length === 0) return receipts;

  const supabase = getSupabaseAdmin();

  const { data: deliveryRows, error: deliveryError } = await supabase
    .from("notification_deliveries")
    .select("notification_event_id,channel,provider_message_id")
    .in("notification_event_id", uniqueEventIds)
    .in("channel", ["in_app", "email"]);
  if (deliveryError) throw new Error(`Read-receipt delivery lookup failed: ${deliveryError.message}`);

  const emailMessageIdToEventId = new Map<string, string>();
  const hasInAppDelivery = new Set<string>();
  for (const row of (deliveryRows ?? []) as Array<{ notification_event_id: string; channel: string; provider_message_id: string | null }>) {
    if (row.channel === "in_app") hasInAppDelivery.add(row.notification_event_id);
    if (row.channel === "email" && row.provider_message_id) emailMessageIdToEventId.set(row.provider_message_id, row.notification_event_id);
  }

  const firstReadAtByEventId = new Map<string, string>();

  if (hasInAppDelivery.size > 0) {
    const { data: stateRows, error: stateError } = await supabase
      .from("notification_user_states")
      .select("notification_event_id,read_at")
      .in("notification_event_id", Array.from(hasInAppDelivery))
      .not("read_at", "is", null);
    if (stateError) throw new Error(`Read-receipt in-app state lookup failed: ${stateError.message}`);
    for (const row of (stateRows ?? []) as Array<{ notification_event_id: string; read_at: string }>) {
      const current = firstReadAtByEventId.get(row.notification_event_id);
      if (!current || row.read_at < current) firstReadAtByEventId.set(row.notification_event_id, row.read_at);
    }
  }

  if (emailMessageIdToEventId.size > 0) {
    const { data: openRows, error: openError } = await supabase
      .from("email_delivery_events")
      .select("provider_message_id,occurred_at")
      .eq("event_type", "email.opened")
      .in("provider_message_id", Array.from(emailMessageIdToEventId.keys()));
    if (openError) throw new Error(`Read-receipt email-open lookup failed: ${openError.message}`);
    for (const row of (openRows ?? []) as Array<{ provider_message_id: string; occurred_at: string }>) {
      const eventId = emailMessageIdToEventId.get(row.provider_message_id);
      if (!eventId) continue;
      const current = firstReadAtByEventId.get(eventId);
      if (!current || row.occurred_at < current) firstReadAtByEventId.set(eventId, row.occurred_at);
    }
  }

  for (const eventId of uniqueEventIds) {
    const firstReadAt = firstReadAtByEventId.get(eventId) ?? null;
    receipts.set(eventId, { firstReadAt, hasBeenRead: firstReadAt != null, tracked: true });
  }
  return receipts;
}

export async function getDigestReadReceipt(notificationEventId: string | null): Promise<DigestReadReceipt> {
  if (!notificationEventId) return NOT_TRACKED;
  const receipts = await getReadReceiptsForEvents([notificationEventId]);
  return receipts.get(notificationEventId) ?? NOT_TRACKED;
}
