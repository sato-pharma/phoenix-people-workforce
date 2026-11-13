// Recruitment / ATS — interviews service (thin in Phase 1; scheduling +
// scorecards land in Phase 2). Scope is enforced via the parent application.

import type { AccessContext } from "@/lib/auth/permissions";
import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";
import { cairoTodayIso } from "@/lib/attendance/working-days";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { afterResponse } from "@/lib/http/after-response";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { findInterviewClash, interviewClashMessage } from "@/lib/recruitment/interview-clash";
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
import { fetchAllRows } from "@/lib/supabase/paginated";
import { logError } from "@/lib/observability/log";

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
  } catch (error) {
    // Notifications are best-effort; scheduling must still succeed. But a failure is RECORDED, never
    // swallowed (REC-048): the candidate's invitation is already in the outbox and is retried by the
    // drain ("Queued for retry: …"); anything else that failed is named here.
    logError("Interview notification failed", {
      error,
      labels: { event: "interview_notification_failed", interview_id: interview.id, kind },
    });
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

  // One interviewer cannot be in two interviews at once. Checked only when there is both a person
  // and a time: a scorecard record written by recordScreeningOutcome has no scheduled_at, and
  // treating one as an occupied slot would refuse a real interview because somebody was screened
  // that day.
  const interviewerHrId = textOrNull(input.interviewerHrId);
  const scheduledAt = textOrNull(input.scheduledAt);
  if (interviewerHrId && scheduledAt) {
    // Casing-blind: hr ids are mixed case here, and a plain .eq would return nothing, which reads
    // as "this interviewer is free" - the direction that books them twice.
    const keys = hrIdLookupKeys(interviewerHrId);
    // Every interview this person has, paged to a short page by the unique `id`: a booking a response
    // cap dropped would read as a free slot, the direction that books them twice. A failed read still
    // answers "no bookings", exactly as it did before.
    let booked: Array<{ id: string; interviewer_hr_id: string | null; scheduled_at: string | null }> = [];
    try {
      booked = await fetchAllRows<{ id: string; interviewer_hr_id: string | null; scheduled_at: string | null }>(
        () =>
          supabase
            .from("ats_interviews")
            .select("id, interviewer_hr_id, scheduled_at")
            .in("interviewer_hr_id", keys.length > 0 ? keys : [interviewerHrId])
            .not("scheduled_at", "is", null),
        "id",
      );
    } catch {
      booked = [];
    }

    const clash = findInterviewClash(
      { interviewerHrId, scheduledAt },
      booked.map((row) => ({ id: String(row.id), interviewerHrId: row.interviewer_hr_id, scheduledAt: row.scheduled_at })),
    );
    if (clash) {
      // Named, not coded: the owner's standing rule is human-readable names in every message. The
      // directory read is best-effort - a clash must still be refused if the lookup fails, so the
      // hr id is the fallback rather than a reason to let the double-booking through.
      let who = interviewerHrId;
      try {
        const key = canonicalHrIdKey(interviewerHrId);
        const rows = await getEmployeeDirectoryRows();
        const match = rows.find((row) => canonicalHrIdKey(row.hrId) === key);
        if (match?.fullName) who = match.fullName;
      } catch {
        // Fall through with the hr id.
      }
      throw new Error(interviewClashMessage(clash, who));
    }
  }

  const { data, error } = await supabase
    .from("ats_interviews")
    .insert({
      application_id: applicationId,
      interview_type: input.interviewType,
      interviewer_hr_id: interviewerHrId,
      scheduled_at: scheduledAt,
      location: textOrNull(input.location),
      meeting_link: textOrNull(input.meetingLink),
      outcome: textOrNull(input.outcome),
      score: input.score ?? {},
      notes: textOrNull(input.notes),
      // Canonicalised: access.hrId is the LOWERCASE comparison key, and this is a THIRD shape of
      // the write repaired across 92 sites on 2026-09-05 - one the repo-wide sweep could not see,
      // because it makes no resolveEmployeeIdentityId call and the column is not named *_hr_id.
      // Only the hr id is canonicalised; the login id fallback is not an hr id.
      created_by: hrIdForStorage(access.hrId) ?? access.loginId ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  const interview = mapInterview(data as InterviewDbRow);
  // Rule 7 — a real scheduled interview (has a date) notifies all parties. The
  // cv/phone/hm scorecard records created via recordScreeningOutcome have no
  // scheduledAt, so they do not trigger a "scheduled" notification.
  // After the reply (afterResponse): the interview is saved, and notifyInterview swallows its own failures.
  if (interview.scheduledAt) {
    await afterResponse("interview_notice:scheduled", () => notifyInterview(application, interview, "scheduled"));
  }
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
  // Both notices go out after the reply (afterResponse): the write is saved, and each swallows its failures.
  if (input.scheduledAt !== undefined && updated.scheduledAt) {
    await afterResponse("interview_notice:rescheduled", () => notifyInterview(application, updated, "rescheduled"));
  }
  // When an outcome is recorded, send interview feedback to the hiring team
  // (best-effort; never block the write on a notification failure).
  const recordedOutcome = updated.outcome;
  if (input.outcome !== undefined && recordedOutcome) {
    await afterResponse("interview_notice:feedback", async () => {
      try {
        await notifyInterviewFeedback({
          candidateName: application.candidate?.fullName ?? "Candidate",
          feedback: updated.notes ?? null,
          interviewId: updated.id,
          interviewerHrId: updated.interviewerHrId,
          jobTitle: application.requisition?.jobTitle ?? "",
          outcome: recordedOutcome,
        });
      } catch (error) {
        // Best-effort, but recorded (REC-048): the email itself is in the outbox and retried.
        logError("Interview feedback notification failed", {
          error,
          labels: { event: "interview_feedback_notification_failed", interview_id: updated.id },
        });
      }
    });
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
  // Every interview in the window, paged to a short page by the unique `id`: a reminder a response
  // cap dropped is an interviewer who is never told.
  const data = await fetchAllRows<InterviewDbRow>(
    () =>
      supabase
        .from("ats_interviews")
        .select("id,application_id,interview_type,interviewer_hr_id,scheduled_at,outcome")
        .gte("scheduled_at", fromIso)
        .lt("scheduled_at", toIso)
        .is("outcome", null),
    "id",
  );
  return data.map((row) => ({
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
  let data: Array<Record<string, unknown>>;
  try {
    // Every interview today, paged to a short page by the unique `id`.
    data = await fetchAllRows<Record<string, unknown>>(
      () => supabase.from("ats_interviews").select("application_id").gte("scheduled_at", from).lt("scheduled_at", to),
      "id",
    );
  } catch {
    return new Set();
  }

  const applicationIds = Array.from(
    new Set(data.map((row) => String(row.application_id ?? "")).filter(Boolean)),
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
