// Recruitment / ATS — interviews service (thin in Phase 1; scheduling +
// scorecards land in Phase 2). Scope is enforced via the parent application.

import type { AccessContext } from "@/lib/auth/permissions";
import { getApplication, type ApplicationWithContext } from "@/lib/recruitment/applications";
import {
  mapInterview,
  recruitmentDb,
  textOrNull,
  type InterviewDbRow,
} from "@/lib/recruitment/db";
import { interviewTypes, type Interview, type InterviewType } from "@/lib/recruitment/types";
import { isInterviewOutcome, normalizeScorecard } from "@/lib/recruitment/scorecards";
import { notifyInterviewFeedback, sendInterviewScheduledNotifications } from "@/lib/recruitment/interview-notifications";

// Rule 7 — notify candidate + interviewer + owner; never block the action on a
// notification failure.
async function notifyInterview(
  application: ApplicationWithContext,
  interview: Interview,
  kind: "scheduled" | "rescheduled" | "cancelled",
): Promise<void> {
  try {
    await sendInterviewScheduledNotifications(
      {
        interview,
        candidateName: application.candidate?.fullName ?? "Candidate",
        candidateEmail: application.candidate?.email ?? null,
        jobTitle: application.requisition?.jobTitle ?? "",
        recruitmentOwnerHrId: application.requisition?.recruitmentOwnerHrId ?? null,
      },
      kind,
    );
  } catch {
    // Notifications are best-effort; scheduling must still succeed.
  }
}

export type CreateInterviewInput = {
  interviewType: InterviewType;
  interviewerHrId?: string | null;
  scheduledAt?: string | null;
  location?: string | null;
  meetingLink?: string | null;
  outcome?: string | null;
  notes?: string | null;
  score?: Record<string, unknown> | null;
};

export async function listInterviewsForApplication(
  access: AccessContext,
  applicationId: string,
): Promise<Interview[]> {
  const application = await getApplication(access, applicationId);
  if (!application) return [];
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_interviews")
    .select("*")
    .eq("application_id", applicationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as InterviewDbRow[]).map(mapInterview);
}

export async function createInterview(
  access: AccessContext,
  applicationId: string,
  input: CreateInterviewInput,
): Promise<Interview> {
  const application = await getApplication(access, applicationId);
  if (!application) throw new Error("Application not found.");
  if (!(interviewTypes as readonly string[]).includes(input.interviewType)) {
    throw new Error("Invalid interview type.");
  }

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_interviews")
    .insert({
      application_id: applicationId,
      interview_type: input.interviewType,
      interviewer_hr_id: textOrNull(input.interviewerHrId),
      scheduled_at: textOrNull(input.scheduledAt),
      location: textOrNull(input.location),
      meeting_link: textOrNull(input.meetingLink),
      outcome: textOrNull(input.outcome),
      score: input.score ?? {},
      notes: textOrNull(input.notes),
      created_by: access.hrId ?? access.loginId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  const interview = mapInterview(data as InterviewDbRow);
  // Rule 7 — a real scheduled interview (has a date) notifies all parties. The
  // cv/phone/hm scorecard records created via recordScreeningOutcome have no
  // scheduledAt, so they do not trigger a "scheduled" notification.
  if (interview.scheduledAt) await notifyInterview(application, interview, "scheduled");
  return interview;
}

export async function getInterviewRow(id: string): Promise<Interview> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_interviews")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Interview not found.");
  return mapInterview(data as InterviewDbRow);
}

export type RecordInterviewInput = {
  outcome?: string | null;
  score?: Record<string, unknown> | null;
  notes?: string | null;
  scheduledAt?: string | null;
  location?: string | null;
  meetingLink?: string | null;
};

export async function recordInterviewOutcome(
  access: AccessContext,
  interviewId: string,
  input: RecordInterviewInput,
): Promise<Interview> {
  const interview = await getInterviewRow(interviewId);
  // Scope via the parent application (throws Forbidden if out of scope).
  const application = await getApplication(access, interview.applicationId);
  if (!application) throw new Error("Application not found.");

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.outcome !== undefined) {
    const outcome = textOrNull(input.outcome);
    if (outcome && !isInterviewOutcome(outcome)) throw new Error("Invalid interview outcome.");
    patch.outcome = outcome;
  }
  if (input.score !== undefined && input.score !== null) {
    patch.score = normalizeScorecard(interview.interviewType, input.score);
  }
  if (input.notes !== undefined) patch.notes = textOrNull(input.notes);
  if (input.scheduledAt !== undefined) patch.scheduled_at = textOrNull(input.scheduledAt);
  if (input.location !== undefined) patch.location = textOrNull(input.location);
  if (input.meetingLink !== undefined) patch.meeting_link = textOrNull(input.meetingLink);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_interviews")
    .update(patch)
    .eq("id", interviewId)
    .select("*")
    .single();
  if (error) throw error;
  const updated = mapInterview(data as InterviewDbRow);
  // Rule 7 — a reschedule (new date/location/link) re-notifies all parties.
  if (input.scheduledAt !== undefined && updated.scheduledAt) {
    await notifyInterview(application, updated, "rescheduled");
  }
  // When an outcome is recorded, send interview feedback to the hiring team
  // (best-effort; never block the write on a notification failure).
  if (input.outcome !== undefined && updated.outcome) {
    try {
      await notifyInterviewFeedback({
        candidateName: application.candidate?.fullName ?? "Candidate",
        feedback: updated.notes ?? null,
        interviewerHrId: updated.interviewerHrId,
        jobTitle: application.requisition?.jobTitle ?? "",
        outcome: updated.outcome,
      });
    } catch {
      // Best-effort.
    }
  }
  return updated;
}

export async function deleteInterview(access: AccessContext, id: string): Promise<void> {
  const interview = await getInterviewRow(id);
  const application = await getApplication(access, interview.applicationId);
  if (!application) throw new Error("Application not found.");
  // Rule 7 — cancelling notifies all parties before the row is removed.
  await notifyInterview(application, interview, "cancelled");
  const supabase = recruitmentDb();
  const { error } = await supabase.from("recruitment_interviews").delete().eq("id", id);
  if (error) throw error;
}

export type InterviewReminder = {
  id: string;
  applicationId: string;
  interviewType: InterviewType;
  interviewerHrId: string | null;
  scheduledAt: string | null;
};

// Scheduled within [fromIso, toIso) and not yet recorded — for daily reminders.
export async function listInterviewsDueForReminder(fromIso: string, toIso: string): Promise<InterviewReminder[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_interviews")
    .select("id,application_id,interview_type,interviewer_hr_id,scheduled_at,outcome")
    .gte("scheduled_at", fromIso)
    .lt("scheduled_at", toIso)
    .is("outcome", null);
  if (error) throw error;
  return ((data ?? []) as InterviewDbRow[]).map((row) => ({
    id: String(row.id),
    applicationId: String(row.application_id),
    interviewType: (textOrNull(row.interview_type) ?? "hr") as InterviewType,
    interviewerHrId: textOrNull(row.interviewer_hr_id),
    scheduledAt: textOrNull(row.scheduled_at),
  }));
}
