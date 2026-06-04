// Recruitment / ATS — interviews service (thin in Phase 1; scheduling +
// scorecards land in Phase 2). Scope is enforced via the parent application.

import type { AccessContext } from "@/lib/auth/permissions";
import { getApplication } from "@/lib/recruitment/applications";
import {
  mapInterview,
  recruitmentDb,
  textOrNull,
  type InterviewDbRow,
} from "@/lib/recruitment/db";
import { interviewTypes, type Interview, type InterviewType } from "@/lib/recruitment/types";

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
  return mapInterview(data as InterviewDbRow);
}
