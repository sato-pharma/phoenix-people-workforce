// The daily reminder to open WhatsApp Business on the HR handset (owner, 2026-11-03: "Me only"). The
// rules are in whatsapp-handset-clock.ts. In-app, Telegram and push, never email, and only to the Super
// Admin, which is why this reads that role by name rather than a recruitment audience that could widen.
//
// A failed read or nobody to tell THROWS, so the job register reads the run as failed and the sweep
// alarms. A clock that cannot be read must never read as a quiet phone.

import type { PhoenixRole } from "@/lib/auth/permissions";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { fetchWebhookRouting, cairoDateKey } from "@/lib/recruitment/inbound/whatsapp-health";
import {
  HANDSET_ECHOES_OFF_MESSAGE,
  HANDSET_ECHOES_OFF_TITLE,
  handsetDaysSinceSend,
  handsetLimitAt,
  handsetReminderMessage,
  handsetReminderPlan,
  handsetReminderStage,
  handsetReminderTitle,
  type HandsetReminderStage,
} from "@/lib/recruitment/inbound/whatsapp-handset-clock";
import { hrIdsForRoles } from "@/lib/recruitment/inbound/recruitment-notify";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrHandsetInboxLine } from "@/lib/whatsapp-inbox/lines";

const REMINDER_ROLES: readonly PhoenixRole[] = ["Super Admin"];
const ACTION_URL = "/recruitment/whatsapp-inbox";

export type HandsetReminderResult = {
  dryRun: boolean;
  lastSendAt: string;
  daysSinceSend: number;
  limitAt: string;
  stage: HandsetReminderStage | null;
  /** False when Meta says the field is off, null when the check could not be answered. */
  echoesSubscribed: boolean | null;
  notified: boolean;
};

/**
 * The newest message sent from the phone. `historical` rows are the coexistence history replay, which
 * carries old sends delivered late and proves nothing about today.
 */
async function lastHandsetSendAt(): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("whatsapp_inbox_messages")
    .select("sent_at")
    .eq("origin", "handset")
    .eq("historical", false)
    .eq("phone_number_id", hrHandsetInboxLine().phoneNumberId)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not read the handset's last send: ${error.message}`);
  const sentAt = (data as { sent_at?: string | null } | null)?.sent_at ?? null;
  if (!sentAt) throw new Error("The inbox holds no send from the HR handset at all, so the 14-day clock cannot be read.");
  return sentAt;
}

export async function runWhatsAppHandsetReminder(options: { dryRun?: boolean; now?: Date } = {}): Promise<HandsetReminderResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? new Date();
  const lastSendAt = await lastHandsetSendAt();
  const days = handsetDaysSinceSend(lastSendAt, now.getTime());
  const stage = handsetReminderStage(days);
  // Read every day, not only once the phone is quiet: a lost subscription is what would make it LOOK quiet.
  const echoesSubscribed = (await fetchWebhookRouting()).echoesSubscribed;
  const result: HandsetReminderResult = {
    daysSinceSend: days,
    dryRun,
    echoesSubscribed,
    lastSendAt,
    limitAt: handsetLimitAt(lastSendAt),
    notified: false,
    stage,
  };
  if (dryRun || (stage === null && echoesSubscribed !== false)) return result;

  const recipients = await hrIdsForRoles(REMINDER_ROLES);
  if (recipients.length === 0) throw new Error("No Super Admin resolved for the handset reminder.");

  const cairoDay = cairoDateKey(now);
  if (echoesSubscribed === false) {
    // Said INSTEAD of the clock. With the field off the clock measures nothing, and telling him the
    // phone is quiet would send him to the wrong place.
    await createSystemNotificationForRecipients(
      {
        actionUrl: ACTION_URL,
        channels: ["in_app", "telegram", "push"],
        eventType: "whatsapp_handset_echoes_off",
        message: HANDSET_ECHOES_OFF_MESSAGE,
        metadata: { idempotencyKey: `whatsapp-handset-open:echoes-off:${cairoDay}` },
        module: "recruitment",
        priority: "high",
        title: HANDSET_ECHOES_OFF_TITLE,
      },
      recipients,
    );
    return { ...result, notified: true };
  }
  if (stage === null) return result;

  const plan = handsetReminderPlan(stage, lastSendAt, cairoDay);
  await createSystemNotificationForRecipients(
    {
      actionUrl: ACTION_URL,
      channels: plan.channels,
      eventType: "whatsapp_handset_open_reminder",
      message: handsetReminderMessage(stage, days, lastSendAt),
      metadata: { daysSinceSend: days, idempotencyKey: plan.idempotencyKey, lastSendAt, stage },
      module: "recruitment",
      priority: plan.priority,
      title: handsetReminderTitle(stage, days),
    },
    recipients,
  );
  return { ...result, notified: true };
}
