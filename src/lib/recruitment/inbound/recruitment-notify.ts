// Recruitment / ATS — Talent Acquisition notification for automated CV intake.
//
// No shared "HR IDs by role" export exists in this codebase today — the nearest precedent is a
// private, unexported hrIdsForRole() in src/lib/direct-orders/service.ts. This is the same idea,
// scoped to recruitment's own manage-roles list (Super Admin, Talent Acquisition), so an inbound
// CV from email or WhatsApp reaches whoever can actually review and assign it.

import type { PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recruitmentManageRoles } from "@/lib/recruitment/access";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import type { InboundCvChannel } from "@/lib/recruitment/inbound/cv-intake-service";
import { cairoDateKey, type WhatsAppIntakeHealth } from "@/lib/recruitment/inbound/whatsapp-health";

async function hrIdsForRoles(roles: readonly PhoenixRole[]): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("app_auth_users").select("hr_id").in("role", roles as string[]);
  if (error) return [];
  return Array.from(
    new Set(
      ((data ?? []) as Array<{ hr_id: unknown }>)
        .map((row) => String(row.hr_id ?? "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

export async function notifyTalentAcquisitionOfInboundCv(input: {
  candidateId: string;
  fullName: string;
  channel: InboundCvChannel;
  created: boolean;
  matchReason?: "national_id" | "email" | "phone";
  fileAttached: boolean;
}): Promise<void> {
  const recipientHrIds = await hrIdsForRoles(recruitmentManageRoles);
  if (recipientHrIds.length === 0) return;

  const channelLabel = input.channel === "whatsapp" ? "WhatsApp" : "email";
  const matchLabel = input.matchReason
    ? ` (matched by ${input.matchReason === "national_id" ? "National ID" : input.matchReason})`
    : "";
  const message = input.fileAttached
    ? `${input.fullName} sent a CV via ${channelLabel}${matchLabel}.`
    : `${input.fullName} reached out via ${channelLabel}${matchLabel}, but their CV file could not be attached — check the candidate record.`;

  await createSystemNotificationForRecipients(
    {
      actionUrl: "/recruitment",
      eventType: "recruitment_inbound_cv",
      message,
      metadata: {
        candidateId: input.candidateId,
        channel: input.channel,
        created: input.created,
        fileAttached: input.fileAttached,
        matchReason: input.matchReason ?? null,
      },
      module: "recruitment",
      priority: "normal",
      title: input.created ? "New candidate from inbound CV" : "New CV for existing candidate",
    },
    recipientHrIds,
  );
}

/**
 * Pushes a WhatsApp-intake-down alert to the Talent Acquisition reviewers via Telegram + push (and
 * in-app), not just Sentry — so a Meta-side block on the number reaches a phone the way it never
 * did on 2026-07-26, when the channel was silently dead for ~19 hours.
 *
 * Throttled to one alert per status per Cairo day via a stable idempotencyKey: the health check
 * runs every 10 minutes, and without this a persistent outage would fan out the same push every
 * run. The first detection each day still fires within ~10 minutes; it then stays quiet until the
 * status changes or the day rolls over (a daily reminder while it remains broken).
 *
 * A no-op for a healthy or not-configured channel, and best-effort — an alerting failure must
 * never itself break the cron that raised it.
 */
export async function notifyWhatsAppIntakeUnhealthy(health: WhatsAppIntakeHealth, now: Date = new Date()): Promise<void> {
  if (health.status !== "api_unreachable" && health.status !== "silent") return;

  const recipientHrIds = await hrIdsForRoles(recruitmentManageRoles);
  if (recipientHrIds.length === 0) return;

  const title = health.status === "api_unreachable" ? "WhatsApp CV intake is DOWN" : "WhatsApp CV intake has gone quiet";
  const numbersDown = health.probes.filter((probe) => !probe.ok).map((probe) => probe.displayNumber ?? probe.phoneNumberId);

  await createSystemNotificationForRecipients(
    {
      actionUrl: "/recruitment",
      // Explicit: this must reach a phone, so force Telegram + push alongside in-app regardless of
      // the module's default channel policy.
      channels: ["in_app", "telegram", "push"],
      eventType: "recruitment_whatsapp_intake_unhealthy",
      message: health.detail,
      metadata: {
        apiError: health.apiError,
        idempotencyKey: `whatsapp-intake-health:${health.status}:${cairoDateKey(now)}`,
        numbersDown,
        status: health.status,
      },
      module: "recruitment",
      priority: "high",
      title,
    },
    recipientHrIds,
  );
}

/**
 * Alerts Talent Acquisition that an inbound CV exhausted its retries and dead-lettered — a real
 * applicant the automated pipeline could not process, needing manual review. Reaches a phone
 * (Telegram + push), not just Sentry. A message dead-letters exactly once, and the idempotencyKey
 * is per (channel, providerMessageId), so this fires exactly once per lost CV — no throttle needed,
 * no risk of spamming. Best-effort; never let alerting failure affect the worker.
 */
export async function notifyInboundIntakeDeadLetter(input: {
  channel: string;
  providerMessageId: string;
  error: string;
}): Promise<void> {
  const recipientHrIds = await hrIdsForRoles(recruitmentManageRoles);
  if (recipientHrIds.length === 0) return;

  const channelLabel = input.channel === "whatsapp" ? "WhatsApp" : "email";
  await createSystemNotificationForRecipients(
    {
      actionUrl: "/recruitment",
      channels: ["in_app", "telegram", "push"],
      eventType: "recruitment_inbound_intake_dead_letter",
      message: `A ${channelLabel} CV could not be processed after several automatic retries and needs manual review.`,
      metadata: {
        error: input.error.slice(0, 500),
        idempotencyKey: `inbound-intake-dead:${input.channel}:${input.providerMessageId}`,
        providerMessageId: input.providerMessageId,
      },
      module: "recruitment",
      priority: "high",
      title: "Inbound CV needs manual review",
    },
    recipientHrIds,
  );
}
