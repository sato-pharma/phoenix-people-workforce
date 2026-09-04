// Recruitment / ATS — interviews service (thin in Phase 1; scheduling +
// scorecards land in Phase 2). Scope is enforced via the parent application.

import type { AccessContext } from "@/lib/auth/permissions";
import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";
import { cairoTodayIso } from "@/lib/attendance/working-days";
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
    .from("ats_interviews")
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
    .from("ats_interviews")
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
    .from("ats_interviews")
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
    .from("ats_interviews")
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
  const { error } = await supabase.from("ats_interviews").delete().eq("id", id);
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
    .from("ats_interviews")
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

/**
 * The candidates with an interview scheduled for TODAY, Cairo — for the screening work-queue rail.
 *
 * CAIRO, NEVER THE SERVER'S DAY. Railway runs in UTC and Cairo is UTC+2/+3, so a 09:00 interview
 * would fall into "yesterday" for the first hours of every working morning if this asked the
 * process for the date. `cairoMidnightUtcIso` derives the real offset for the day rather than
 * assuming one, which is what keeps this correct across the DST change.
 *
 * TWO HOPS, because an interview hangs off an APPLICATION and only the application knows the
 * candidate. Production carries very few applications, so this pile is usually empty — and an
 * honestly empty pile is the answer, not a reason to loosen the join to something that would
 * report interviews nobody scheduled.
 *
 * Fails soft to an empty set: the rail is one line on a screen whose job is showing CVs.
 */
export async function listCandidateIdsWithInterviewToday(): Promise<Set<string>> {
  const today = cairoTodayIso();
  const from = cairoMidnightUtcIso(today);
  const to = cairoMidnightUtcIso(today, 1);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_interviews")
    .select("application_id")
    .gte("scheduled_at", from)
    .lt("scheduled_at", to);
  if (error) return new Set();

  const applicationIds = Array.from(
    new Set(((data ?? []) as Array<Record<string, unknown>>).map((row) => String(row.application_id ?? "")).filter(Boolean)),
  );
  if (applicationIds.length === 0) return new Set();

  const candidateIds = new Set<string>();
  // Chunked at 50 — a PostgREST `.in()` carrying several hundred ids returns zero rows and no
  // error, and "nobody is being interviewed today" is exactly the wrong thing to report silently.
  for (let index = 0; index < applicationIds.length; index += 50) {
    const { data: rows, error: joinError } = await supabase
      .from("ats_applications")
      .select("candidate_id")
      .in("id", applicationIds.slice(index, index + 50));
    if (joinError) return candidateIds;
    for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.candidate_id ?? "");
      if (id) candidateIds.add(id);
    }
  }
  return candidateIds;
}
