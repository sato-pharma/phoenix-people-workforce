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
import {
  dailyCvDigestMessage,
  dailyCvDigestTitle,
  shouldAlertImmediatelyForInboundCv,
  type DailyCvDigest,
} from "@/lib/recruitment/inbound/daily-cv-digest";
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
  // Fields the AI read that intake could NOT auto-apply — low confidence, jsonb storage, or the
  // identity triple cv-auto-apply.ts deliberately never touches. Those are the ones still needing
  // a human, and nothing else tells anyone they exist. Deliberately NOT the raw finding count:
  // auto-apply has usually already written several of those, so reporting them would announce work
  // that is already done.
  fieldsAwaitingReview?: number;
}): Promise<void> {
  // The routine arrival is reported once a day by notifyDailyCvDigest instead of once per CV.
  // Checked BEFORE the recipient lookup so the ordinary path costs no database round trip at all —
  // this runs on every single inbound CV.
  if (!shouldAlertImmediatelyForInboundCv(input)) return;

  const recipientHrIds = await hrIdsForRoles(recruitmentManageRoles);
  if (recipientHrIds.length === 0) return;

  const channelLabel = input.channel === "whatsapp" ? "WhatsApp" : "email";
  const matchLabel = input.matchReason
    ? ` (matched by ${input.matchReason === "national_id" ? "National ID" : input.matchReason})`
    : "";
  const awaiting = input.fieldsAwaitingReview ?? 0;
  // Only the no-file case reaches this line, so the message says exactly that instead of branching
  // on fileAttached — a ternary whose other half can never run reads like a live path and is how a
  // later change quietly resurrects the per-CV flood.
  const message = `${input.fullName} reached out via ${channelLabel}${matchLabel}, but their CV file could not be attached — check the candidate record.`;

  await createSystemNotificationForRecipients(
    {
      // Deep-links to this candidate's profile (the workspace reads ?candidate=) rather than the
      // module landing page — the fields to review are on the profile, not findable from a list.
      actionUrl: `/recruitment?candidate=${encodeURIComponent(input.candidateId)}`,
      eventType: "recruitment_inbound_cv",
      message,
      metadata: {
        candidateId: input.candidateId,
        channel: input.channel,
        created: input.created,
        fieldsAwaitingReview: awaiting,
        fileAttached: input.fileAttached,
        matchReason: input.matchReason ?? null,
      },
      module: "recruitment",
      priority: "normal",
      title: "Inbound CV arrived with no file",
    },
    recipientHrIds,
  );
}

/**
 * ONE notification a day naming how many CVs arrived, what they applied for and which channel
 * brought them — the replacement for the 628 per-CV deliveries measured over 30 days.
 *
 * Throttled by the SAME mechanism as the alerts above, and it is worth being precise about how that
 * works because the caller fires this six times inside the digest hour: the Cairo-dated
 * idempotencyKey is suffixed per recipient by createSystemNotificationForRecipients, and each
 * per-recipient delivery row is claimed by an atomic INSERT against a unique constraint. The first
 * tick of the hour claims and sends; the other five lose the claim and send nothing. There is no
 * "have I already sent today" read anywhere, and therefore no window in which two ticks both decide
 * they are first.
 *
 * A day with no arrivals sends nothing at all. Silence already means "nothing came in", and a daily
 * "0 CVs" push is precisely the kind of message that teaches people to ignore the channel.
 *
 * Channels are in-app + Telegram + push and NEVER email — the owner's rule for the "new CV received"
 * notice, live in production since 2026-08-15. That is enforced twice over, here and in
 * recruitment-cv-channel-guard.ts, which knows this eventType.
 */
export async function notifyDailyCvDigest(digest: DailyCvDigest): Promise<void> {
  if (digest.total === 0) return;

  const recipientHrIds = await hrIdsForRoles(recruitmentManageRoles);
  if (recipientHrIds.length === 0) return;

  await createSystemNotificationForRecipients(
    {
      // The pool itself, not a candidate — the digest is about a day, and the day's arrivals are
      // what the Candidates tab opens on, sorted newest first.
      actionUrl: "/recruitment",
      channels: ["in_app", "telegram", "push"],
      eventType: "recruitment_daily_cv_digest",
      message: dailyCvDigestMessage(digest),
      metadata: {
        awaitingReview: digest.awaitingReview,
        dayKey: digest.dayKey,
        idempotencyKey: `recruitment-daily-cv-digest:${digest.dayKey}`,
        total: digest.total,
      },
      module: "recruitment",
      priority: "normal",
      title: dailyCvDigestTitle(digest),
    },
    recipientHrIds,
  );
}

/**
 * Pushes a WhatsApp-intake-down alert to the Talent Acquisition reviewers via Telegram + push (and
 * in-app) — so a Meta-side block on the number reaches a phone the way it never
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
 * (Telegram + push). A message dead-letters exactly once, and the idempotencyKey
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

/**
 * Alerts on a SURGE of errors/dead-letters over a short window — the "something is systematically
 * wrong" signal a per-message dead-letter alert can't give (each of those is a single CV).
 * Throttled to once per Cairo day so a persistent problem reminds without spamming.
 */
export async function notifyInboundIntakeSpike(
  input: { errors: number; deadLettered: number; windowLabel: string },
  now: Date = new Date(),
): Promise<void> {
  const recipientHrIds = await hrIdsForRoles(recruitmentManageRoles);
  if (recipientHrIds.length === 0) return;

  await createSystemNotificationForRecipients(
    {
      actionUrl: "/recruitment",
      channels: ["in_app", "telegram", "push"],
      eventType: "recruitment_inbound_intake_spike",
      message: `${input.errors} error(s) and ${input.deadLettered} dead-letter(s) in the last ${input.windowLabel} — inbound CV processing may be systematically failing.`,
      metadata: {
        deadLettered: input.deadLettered,
        errors: input.errors,
        idempotencyKey: `inbound-intake-spike:${cairoDateKey(now)}`,
      },
      module: "recruitment",
      priority: "high",
      title: "Inbound CV intake error spike",
    },
    recipientHrIds,
  );
}
