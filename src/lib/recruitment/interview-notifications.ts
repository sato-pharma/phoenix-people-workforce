// Recruitment / ATS — interview notifications (Rule 7).
//
// When an interview is scheduled / rescheduled / cancelled, notify all parties:
//   - the CANDIDATE by email (candidates have no login),
//   - the INTERVIEWER by in-app + email,
//   - the RECRUITMENT OWNER by in-app.
// Kept in its own module (no import of interviews.ts) to avoid a cycle.

import { createSystemNotification } from "@/lib/notifications/system";
import { EMAIL_TEMPLATE_KEYS } from "@/lib/email-templates/service";
import { sendDurableEmail } from "@/lib/notifications/durable-email";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import type { Interview } from "@/lib/recruitment/types";

export type InterviewNotifyKind = "scheduled" | "rescheduled" | "cancelled";

export type InterviewNotifyContext = {
  interview: Interview;
  candidateName: string;
  candidateEmail: string | null;
  jobTitle: string;
  recruitmentOwnerHrId: string | null;
};

function formatWhen(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "To be confirmed", time: "To be confirmed" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "To be confirmed", time: "To be confirmed" };
  const date = d.toLocaleDateString("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
  return { date, time };
}

export function interviewTypeLabel(type: string): string {
  if (type === "hiring_manager") return "Hiring manager";
  if (type === "hr") return "HR";
  if (type === "phone") return "Phone";
  if (type === "rm_interview") return "Regional Manager";
  if (type === "nsm_interview") return "National Sales Manager";
  if (type === "ceo_interview") return "CEO";
  return type.replace(/_/g, " ");
}

/**
 * The interviewer's name for the notification, falling back to the id when nobody answers to it.
 *
 * 🔴 THIS READ WAS A BARE `.eq("hr_id", hrId)` UNTIL 2026-10-09 — the mixed-case miss itself.
 * Production stores `hr_id` mixed-case and PostgREST matches case-sensitively, so an id in the other
 * spelling returned NO row and NO error; with the id as the fallback, that shipped as "B-10" where
 * an interviewer's name belongs, in a notification a candidate's interviewer reads. `namesByHrId`
 * asks for every spelling, so the lookup only misses when the person genuinely is not there.
 */
async function interviewerName(hrId: string | null): Promise<string | null> {
  if (!hrId) return null;
  try {
    const names = await namesByHrId([hrId]);
    return names.get(hrId) ?? hrId;
  } catch {
    return hrId;
  }
}

async function safeSendNotificationEmail(input: {
  candidateEmail?: string | null;
  ctaHref?: string;
  ctaLabel?: string;
  employeeHrId?: string | null;
  metrics?: Array<{ label: string; value: string | number }>;
  notificationType?: "general";
  recipientMode?: "candidate" | "employee";
  subject: string;
  summary: string;
  title: string;
  tone?: "warning" | "neutral";
}) {
  return createSystemNotification({
    actionUrl: input.ctaHref ?? null,
    channels: ["email", "push"],
    email: input,
    eventType: "interview_email",
    message: input.summary,
    metadata: { candidateEmail: input.candidateEmail ?? null, idempotencyKey: `recruitment_email:${input.subject}:${input.employeeHrId ?? input.candidateEmail ?? ""}` },
    module: "recruitment",
    recipientHrId: input.employeeHrId,
    title: input.title,
  });
}

async function enqueueInAppNotification(input: {
  category: string;
  dedupeKey: string;
  href?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  recipientHrId: string;
  title: string;
}) {
  return createSystemNotification({
    actionUrl: input.href ?? null,
    category: input.category,
    channels: ["in_app", "push"],
    eventType: "interview_notification",
    message: input.message,
    metadata: { ...(input.metadata ?? {}), idempotencyKey: input.dedupeKey },
    module: "recruitment",
    recipientHrId: input.recipientHrId,
    title: input.title,
  });
}

export async function sendInterviewScheduledNotifications(
  ctx: InterviewNotifyContext,
  kind: InterviewNotifyKind,
): Promise<void> {
  const { interview } = ctx;
  const { date, time } = formatWhen(interview.scheduledAt);
  const verb = kind === "cancelled" ? "cancelled" : kind === "rescheduled" ? "rescheduled" : "scheduled";
  const label = interviewTypeLabel(interview.interviewType);
  const name = await interviewerName(interview.interviewerHrId);

  const detailMetrics = [
    { label: "Interview", value: `${label} interview` },
    { label: "Date", value: date },
    { label: "Time", value: time },
    { label: "Location", value: interview.location ?? "—" },
    { label: "Meeting link", value: interview.meetingLink ?? "—" },
    { label: "Interviewer", value: name ?? "—" },
    { label: "Role", value: ctx.jobTitle || "—" },
  ];

  // --- Candidate (email) ------------------------------------------------
  if (ctx.candidateEmail) {
    if (kind === "cancelled") {
      // No dedicated cancellation template — send the cancellation notice via the
      // generic path.
      await safeSendNotificationEmail({
        notificationType: "general",
        recipientMode: "candidate",
        candidateEmail: ctx.candidateEmail,
        subject: `Interview cancelled — ${ctx.jobTitle || "Phoenix Workforce"}`,
        title: "Interview cancelled",
        summary: `Your ${label.toLowerCase()} interview has been cancelled. We'll be in touch about next steps.`,
        metrics: [{ label: "Interview", value: `${label} interview` }],
        tone: "warning",
      });
    } else {
      // Scheduled / rescheduled → dedicated, admin-editable interview_invitation template.
      // Durable (REC-048): written to the outbox first, so a provider failure is retried by the drain
      // with this same input instead of being lost.
      await sendDurableEmail(
        {
          input: {
            templateKey: EMAIL_TEMPLATE_KEYS.INTERVIEW_INVITATION,
            candidateEmail: ctx.candidateEmail,
            fallbackTo: [ctx.candidateEmail],
            context: {
              candidateName: ctx.candidateName,
              interviewDate: date,
              interviewLocation: interview.location ?? "To be confirmed",
              interviewTime: time,
              interviewerName: name ?? "—",
              jobTitle: ctx.jobTitle,
              meetingUrl: interview.meetingLink ?? "",
              recipientName: ctx.candidateName,
            },
          },
          sender: "templated",
        },
        { dedupeKey: `recruitment:interview_invitation:${interview.id}:${kind}:${interview.updatedAt}` },
      );
    }
  }

  // --- Interviewer (in-app + email) -------------------------------------
  if (interview.interviewerHrId) {
    const summary =
      kind === "cancelled"
        ? `The ${label.toLowerCase()} interview with ${ctx.candidateName} was cancelled.`
        : `${label} interview with ${ctx.candidateName} for ${ctx.jobTitle} — ${date} ${time}.`;
    await enqueueInAppNotification({
      category: "recruitment",
      dedupeKey: `recruitment_interview_${kind}:${interview.id}:${interview.interviewerHrId}:${interview.updatedAt}`,
      href: "/recruitment",
      message: summary,
      metadata: { interviewId: interview.id, applicationId: interview.applicationId },
      recipientHrId: interview.interviewerHrId,
      title: `Interview ${verb}`,
    });
    await safeSendNotificationEmail({
      notificationType: "general",
      recipientMode: "employee",
      employeeHrId: interview.interviewerHrId,
      subject: `Interview ${verb} — ${ctx.candidateName}`,
      title: `Interview ${verb}`,
      summary,
      metrics: kind === "cancelled" ? [{ label: "Candidate", value: ctx.candidateName }] : [{ label: "Candidate", value: ctx.candidateName }, ...detailMetrics],
      ctaHref: "/recruitment",
      ctaLabel: "Open recruitment",
      tone: kind === "cancelled" ? "warning" : "neutral",
    });
  }

  // --- Recruitment owner (in-app) ---------------------------------------
  if (ctx.recruitmentOwnerHrId && ctx.recruitmentOwnerHrId !== interview.interviewerHrId) {
    await enqueueInAppNotification({
      category: "recruitment",
      dedupeKey: `recruitment_interview_${kind}_owner:${interview.id}:${ctx.recruitmentOwnerHrId}:${interview.updatedAt}`,
      href: "/recruitment",
      message: `${label} interview for ${ctx.candidateName} (${ctx.jobTitle}) ${verb} — ${date} ${time}.`,
      metadata: { interviewId: interview.id, applicationId: interview.applicationId },
      recipientHrId: ctx.recruitmentOwnerHrId,
      title: `Interview ${verb}`,
    });
  }
}

function interviewNextStep(outcome: string | null): string {
  const o = String(outcome ?? "").toLowerCase();
  if (o.includes("pass") || o === "advance" || o === "proceed") return "Proceed to the next round.";
  if (o.includes("fail") || o.includes("reject") || o === "no_hire") return "Close the candidate and notify them.";
  if (o.includes("hold")) return "Hold — revisit after the remaining interviews.";
  return "Review the feedback and decide the next recruiting step.";
}

/**
 * Notify the hiring team (HR / hiring manager / recruiter — resolved by the
 * interview_feedback template's recipient rules) when an interview outcome is recorded.
 * Renders the dedicated, admin-editable interview_feedback template. Best-effort.
 */
export async function notifyInterviewFeedback(input: {
  candidateName: string;
  feedback: string | null;
  /** Names the email's outbox row; optional so an older caller still compiles. */
  interviewId?: string | null;
  interviewerHrId: string | null;
  jobTitle: string;
  outcome: string | null;
}): Promise<void> {
  // Durable (REC-048): see the interview invitation above.
  await sendDurableEmail(
    {
      input: {
        templateKey: EMAIL_TEMPLATE_KEYS.INTERVIEW_FEEDBACK,
        employeeHrId: input.interviewerHrId,
        context: {
          candidateName: input.candidateName,
          feedback: input.feedback?.trim() || "No written feedback was provided.",
          jobTitle: input.jobTitle,
          nextStep: interviewNextStep(input.outcome),
          recipientName: "Team",
          status: input.outcome || "Recorded",
        },
      },
      sender: "templated",
    },
    { dedupeKey: `recruitment:interview_feedback:${input.interviewId ?? "no-interview"}:${input.interviewerHrId ?? "no-interviewer"}` },
  );
}
