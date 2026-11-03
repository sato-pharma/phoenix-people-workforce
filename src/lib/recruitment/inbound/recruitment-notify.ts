// Recruitment / ATS — Talent Acquisition notification for automated CV intake.
//
// No shared "HR IDs by role" export exists in this codebase today — the nearest precedent is a
// private, unexported hrIdsForRole() in src/lib/direct-orders/service.ts. This is the same idea,
// scoped to recruitment's own alert lists: a NEW CV reaches recruitmentAlertRoles (the Super Admin and
// the Talent Acquisition seat) so it reaches whoever can actually review and assign it, and every
// other alert in this file reads recruitmentDeskAlertRoles, which leaves the Talent Acquisition seat
// out (owner, 2026-10-16: her notification center holds a new CV, an interview request and an
// accepted offer).

import type { PhoenixRole } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { recruitmentAlertRoles, recruitmentDeskAlertRoles } from "@/lib/recruitment/access";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import type { CandidateMatchReason } from "@/lib/recruitment/candidate-matching";
import type { InboundCvChannel } from "@/lib/recruitment/inbound/cv-intake-service";
import {
  dailyCvDigestMessage,
  dailyCvDigestTitle,
  inboundCvAlertReason,
  type DailyCvDigest,
} from "@/lib/recruitment/inbound/daily-cv-digest";
import { cairoDateKey, type WhatsAppIntakeHealth } from "@/lib/recruitment/inbound/whatsapp-health";
import { candidateHiddenFrom } from "@/lib/recruitment/workspace/fence";
import { workspaceCandidateHref, workspaceHref } from "@/lib/recruitment/workspace/links";

export async function hrIdsForRoles(roles: readonly PhoenixRole[]): Promise<string[]> {
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

// What matched, in words a recruiter reads — never the stored code. Keyed by CandidateMatchReason
// so a value added to that union is a compile error here rather than a raw `cv_content` appearing in
// somebody's notification, which is how "matched by phone" would have read had this been a template.
export const MATCH_REASON_LABEL: Record<CandidateMatchReason, string> = {
  cv_content: "an identical CV already on file",
  email: "email address",
  national_id: "National ID",
  phone: "phone number",
};

export async function notifyTalentAcquisitionOfInboundCv(input: {
  candidateId: string;
  fullName: string;
  channel: InboundCvChannel;
  created: boolean;
  matchReason?: CandidateMatchReason;
  fileAttached: boolean;
  // Fields the AI read that intake could NOT auto-apply — low confidence, jsonb storage, or the
  // identity triple cv-auto-apply.ts deliberately never touches. Those are the ones still needing
  // a human, and nothing else tells anyone they exist. Deliberately NOT the raw finding count:
  // auto-apply has usually already written several of those, so reporting them would announce work
  // that is already done.
  fieldsAwaitingReview?: number;
  // A forwarding handset or a coexistence history replay rather than the applicant themselves.
  // Counted by the daily digest like any other arrival; it just never interrupts anyone.
  bulkArrival?: boolean;
}): Promise<void> {
  // A bulk forward is reported once a day by notifyDailyCvDigest instead of once per CV. Checked
  // BEFORE the recipient lookup so that path costs no database round trip at all — it runs on every
  // single inbound CV, and 427 of the last 437 WhatsApp arrivals were exactly that.
  const reason = inboundCvAlertReason(input);
  if (!reason) return;

  // The Talent Acquisition fence is by PERSON and reaches her notifications too: an HR applicant (her
  // manager's seat or her own) is never named to her, here or anywhere. Asked of the fence itself, so
  // the rule is the one every screen uses; a check that cannot answer leaves her off (fail closed) —
  // the Super Admin still hears of the CV either way.
  const hiddenFromTalentAcquisition = await candidateHiddenFrom(
    { role: "HR Resourcing", scope: "company" },
    input.candidateId,
  ).catch(() => true);
  // The desk list IS the alert list without her, so a hidden person goes to the desk alone.
  const recipientHrIds = hiddenFromTalentAcquisition
    ? await hrIdsForRoles(recruitmentDeskAlertRoles)
    : await hrIdsForRoles(recruitmentAlertRoles);
  if (recipientHrIds.length === 0) return;

  const channelLabel = input.channel === "whatsapp" ? "WhatsApp" : "email";
  const matchLabel = input.matchReason ? ` (matched by ${MATCH_REASON_LABEL[input.matchReason]})` : "";
  const awaiting = input.fieldsAwaitingReview ?? 0;
  // Two genuinely different events share this notification, so each says its own thing. The applicant
  // wording leads with the CV being ON FILE, because the whole point of the alert is that somebody
  // applied and can be opened right now — not that something needs repairing.
  const reviewNote = awaiting > 0 ? ` ${awaiting} field${awaiting === 1 ? "" : "s"} need a quick review.` : "";
  const message =
    reason === "no_file"
      ? `${input.fullName} reached out via ${channelLabel}${matchLabel}, but their CV file could not be attached — check the candidate record.`
      : `${input.fullName} sent a CV on ${channelLabel}${matchLabel}. It is on their candidate record now.${reviewNote}`;

  await createSystemNotificationForRecipients(
    {
      // Deep-links to this candidate's opened CV in the workspace rather than the module landing
      // page — the fields to review are on the CV, not findable from a list.
      actionUrl: workspaceCandidateHref(input.candidateId),
      eventType: "recruitment_inbound_cv",
      message,
      metadata: {
        alertReason: reason,
        bulkArrival: input.bulkArrival === true,
        candidateId: input.candidateId,
        channel: input.channel,
        created: input.created,
        fieldsAwaitingReview: awaiting,
        fileAttached: input.fileAttached,
        matchReason: input.matchReason ?? null,
      },
      module: "recruitment",
      priority: "normal",
      title: reason === "no_file" ? "Inbound CV arrived with no file" : "New CV received",
    },
    recipientHrIds,
  );
}

/**
 * ONE notification a day naming how many CVs arrived, which tab and place their own replies filed
 * them in, and which channel brought them — the replacement for the 628 per-CV deliveries measured
 * over 30 days.
 *
 * It goes to `recruitmentDeskAlertRoles` (the Super Admin) only, so it is built unfenced; the Talent
 * Acquisition seat reads the same figures on her own panel, fenced (`buildTodaysCvDigest`'s
 * `hideHrPeople`).
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

  const recipientHrIds = await hrIdsForRoles(recruitmentDeskAlertRoles);
  if (recipientHrIds.length === 0) return;

  await createSystemNotificationForRecipients(
    {
      // The workspace filtered to today's arrivals (Cairo), not a candidate — the digest is about a
      // day, and the place lines in the message say which tabs to open from there.
      actionUrl: workspaceHref({ datePick: "today" }),
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
  // Four statuses reach a phone. "silent" was briefly removed on 2026-08-23 (PR #2327) on the
  // reasoning that a 333h gap was normal quiet - reversed hours later, because on a channel fed by
  // manual forwarding a long gap means applicants' CVs sitting unread on a handset, which is
  // exactly what someone needs woken for. Throttling still holds it to one push per status per
  // Cairo day, so a persistent fault reminds rather than spams.
  const PUSHABLE = ["api_unreachable", "webhook_misrouted", "public_channel_dead", "silent"] as const;
  if (!(PUSHABLE as readonly string[]).includes(health.status)) return;

  const recipientHrIds = await hrIdsForRoles(recruitmentDeskAlertRoles);
  if (recipientHrIds.length === 0) return;

  // Each title names the fault, not the symptom, so the phone notification alone is enough to know
  // what to go and do.
  const title =
    health.status === "api_unreachable"
      ? "WhatsApp CV intake is DOWN"
      : health.status === "webhook_misrouted"
        ? "WhatsApp CV intake is not being delivered here"
        : health.status === "public_channel_dead"
          ? "Applicants cannot reach you on WhatsApp"
          : "No CVs have come through WhatsApp";
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
        emailSendersInWindow: health.reach?.emailSenders ?? null,
        numbersDown,
        outsideSendersInWindow: health.reach?.outsideSenders ?? null,
        routingProblems: health.routing?.problems ?? [],
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
  const recipientHrIds = await hrIdsForRoles(recruitmentDeskAlertRoles);
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
  const recipientHrIds = await hrIdsForRoles(recruitmentDeskAlertRoles);
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

/**
 * Tells Talent Acquisition that a real person messaged the advertised WhatsApp line and did NOT
 * attach a CV — the arrival that produced no signal at all until 2026-08-29.
 *
 * This is the notification the owner asked for in his own words: "I must be able to know when I
 * receive a message." Before this, a text-only message reached the buffer, the buffer was swept
 * after 24 hours, and no human was ever told — so an advertised line looked quiet when it was
 * merely deaf.
 *
 * ONE per sender per day, not one per message. The throttle is the caller's, not a key here: the
 * decision function only sets `notify` on a sender's FIRST text-only message inside the window
 * (see decideTextOnlyAction), so a chatty applicant sending eight lines is one notification. The
 * idempotencyKey below is the second belt — it collapses a Meta redelivery of the same wamid.
 *
 * Channels are in-app + Telegram + push and NEVER email, matching the owner's standing rule for
 * every "someone applied" notice. Enforced twice, here and in recruitment-cv-channel-guard.ts,
 * for the reason that guard documents: an explicit call-site list is not the last word, because the
 * Telegram-failure fallback can re-enter the pipeline carrying email.
 */
export async function notifyInboundWhatsAppTextOnly(input: {
  senderLabel: string;
  preview: string;
  wamid: string;
  asked: boolean;
  alreadyApplied: boolean;
  askedAboutTheJob?: boolean;
}): Promise<void> {
  const recipientHrIds = await hrIdsForRoles(recruitmentDeskAlertRoles);
  if (recipientHrIds.length === 0) return;

  // Three genuinely different situations, and the phone alert has to distinguish them without being
  // opened: someone who has never applied and needs a CV, someone chasing a CV they already sent,
  // and someone who asked us a question. Answering the second as though it were the first is how an
  // applicant gets told to send a document they already sent.
  //
  // The third earns its own title because the reply Phoenix sends to a question CREATES AN
  // OBLIGATION — it says the recruitment team will send the details for their area. That promise is
  // kept by a human or not at all, so an alert rendering it as an ordinary "no CV attached" is how it
  // goes silently unkept. Deliberately NOT a higher `priority`: this channel already pages on every
  // arrival, and raising one class above the rest trains the others to be ignored.
  const askedAboutTheJob = input.askedAboutTheJob === true && !input.alreadyApplied;
  const title = input.alreadyApplied
    ? "Applicant followed up on WhatsApp"
    : askedAboutTheJob
      ? "Someone asked about the job on WhatsApp"
      : "New WhatsApp message — no CV attached";
  const trailer = input.alreadyApplied
    ? "They already sent a CV in the last 24 hours, so Phoenix did not ask again."
    : input.asked
      ? askedAboutTheJob
        ? "Phoenix answered that we are hiring Medical Representatives and asked for their CV as a file. They were told the team sends the details for their area — that part needs a human."
        : "Phoenix has asked them to send it as a file."
      : "Phoenix did NOT reply — the automatic reply is switched off.";

  await createSystemNotificationForRecipients(
    {
      actionUrl: "/recruitment",
      channels: ["in_app", "telegram", "push"],
      eventType: "recruitment_whatsapp_text_only",
      message: `${input.senderLabel} wrote: "${input.preview}" — ${trailer}`,
      metadata: {
        alreadyApplied: input.alreadyApplied,
        asked: input.asked,
        askedAboutTheJob,
        idempotencyKey: `whatsapp-text-only:${input.wamid}`,
        wamid: input.wamid,
      },
      module: "recruitment",
      priority: "normal",
      title,
    },
    recipientHrIds,
  );
}

/**
 * A real person sent an attachment and it never became a candidate.
 *
 * Paged rather than digested, and that is the whole point: the daily digest deliberately absorbs
 * the ROUTINE arrival, and this is the opposite of routine — it is the one case where a human has
 * to open the original message by eye, because the system has already admitted it cannot read it.
 * Same reasoning shouldAlertImmediatelyForInboundCv applies to a CV whose file would not attach.
 *
 * It reports what happened and never what it means. "Could not be read" is the honest ceiling: the
 * picture may be a certificate, or a photographed CV the model called wrong, and only the person
 * opening it can tell. Saying "not a CV" here would launder a machine guess into a fact and, at the
 * measured accuracy of that check, would eventually throw away a real applicant.
 */
export async function notifyInboundWhatsAppUnreadableCv(input: {
  senderLabel: string;
  filename: string | null;
  cause: "not_recognised" | "too_large";
  wamid: string;
  asked: boolean;
  /** A WhatsApp username sender who shared no phone number: never answered, by owner decision. */
  noPhoneNumber?: boolean;
}): Promise<void> {
  const recipientHrIds = await hrIdsForRoles(recruitmentDeskAlertRoles);
  if (recipientHrIds.length === 0) return;

  const what = input.cause === "too_large" ? "sent a file too large to open" : "sent something we could not read as a CV";
  const named = String(input.filename ?? "").trim();
  const trailer = input.asked
    ? "Phoenix has asked them to resend it as a PDF or Word file."
    : input.noPhoneNumber
      ? "Phoenix did NOT reply — they use a WhatsApp username and shared no phone number, and such a sender is never messaged."
      : "Phoenix did NOT reply — the automatic reply is switched off.";

  await createSystemNotificationForRecipients(
    {
      actionUrl: "/recruitment",
      channels: ["in_app", "telegram", "push"],
      eventType: "recruitment_whatsapp_unreadable_cv",
      message: `${input.senderLabel} ${what}${named ? ` (${named})` : ""} — ${trailer} The original is still on WhatsApp, so it can be opened by eye.`,
      metadata: {
        asked: input.asked,
        cause: input.cause,
        idempotencyKey: `whatsapp-unreadable-cv:${input.wamid}`,
        wamid: input.wamid,
      },
      module: "recruitment",
      priority: "normal",
      title: "WhatsApp CV could not be read",
    },
    recipientHrIds,
  );
}
