// Recruitment / ATS — interview notifications (Rule 7).
//
// When an interview is scheduled / rescheduled / cancelled, notify all parties:
//   - the CANDIDATE by email (candidates have no login),
//   - the INTERVIEWER by in-app + email,
//   - the RECRUITMENT OWNER by in-app.
// Kept in its own module (no import of interviews.ts) to avoid a cycle.

import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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
  return type.replace(/_/g, " ");
}

async function interviewerName(hrId: string | null): Promise<string | null> {
  if (!hrId) return null;
  try {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("full_name")
      .eq("hr_id", hrId)
      .maybeSingle();
    return (data as { full_name?: string } | null)?.full_name ?? hrId;
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
    channels: ["email"],
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
    channels: ["in_app"],
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

  // --- Candidate (email only) -------------------------------------------
  if (ctx.candidateEmail) {
    await safeSendNotificationEmail({
      notificationType: "general",
      recipientMode: "candidate",
      candidateEmail: ctx.candidateEmail,
      subject: `Interview ${verb} — ${ctx.jobTitle || "Phoenix Workforce"}`,
      title: `Interview ${verb}`,
      summary:
        kind === "cancelled"
          ? `Your ${label.toLowerCase()} interview has been cancelled. We'll be in touch about next steps.`
          : `Your ${label.toLowerCase()} interview for ${ctx.jobTitle} has been ${verb}. Details are below.`,
      metrics: kind === "cancelled" ? [{ label: "Interview", value: `${label} interview` }] : detailMetrics,
      tone: kind === "cancelled" ? "warning" : "neutral",
    });
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
