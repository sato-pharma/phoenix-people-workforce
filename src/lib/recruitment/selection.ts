// Recruitment / ATS — Final Selection board (Rule 9).
//
// Side-by-side comparison of the candidates in play for one requisition:
// interview scores + rating average, salary expectation, notice period, and the
// "previously rejected" risk flag (the only risk indicator requested).

import type { AccessContext } from "@/lib/auth/permissions";
import { getRequisition } from "@/lib/recruitment/requisitions";
import {
  mapApplication,
  mapCandidate,
  mapInterview,
  recruitmentDb,
  type ApplicationDbRow,
  type CandidateDbRow,
  type InterviewDbRow,
} from "@/lib/recruitment/db";
import { summarizeScorecard } from "@/lib/recruitment/scorecards";
import type { Application, Candidate, InterviewType } from "@/lib/recruitment/types";

// The candidates worth comparing at the selection step.
const SELECTION_STAGES = ["manager_interview_completed", "final_selection", "backup_candidate"] as const;

export type SelectionBoardInterview = {
  id: string;
  type: InterviewType;
  average: number | null;
  outcome: string | null;
};

export type SelectionBoardEntry = {
  application: Application;
  candidate: Candidate | null;
  ratingAverage: number | null;
  interviews: SelectionBoardInterview[];
  priorRejections: number;
  riskPreviouslyRejected: boolean;
};

export async function getRequisitionSelectionBoard(
  access: AccessContext,
  requisitionId: string,
): Promise<SelectionBoardEntry[]> {
  const requisition = await getRequisition(access, requisitionId); // scope check (throws if out of scope)
  if (!requisition) throw new Error("Requisition not found.");

  const supabase = recruitmentDb();
  const { data: appRows, error: appError } = await supabase
    .from("recruitment_applications")
    .select("*")
    .eq("requisition_id", requisitionId)
    .in("stage", SELECTION_STAGES as readonly string[])
    .order("created_at", { ascending: true });
  if (appError) throw appError;
  const applications = ((appRows ?? []) as ApplicationDbRow[]).map(mapApplication);
  if (applications.length === 0) return [];

  const candidateIds = Array.from(new Set(applications.map((a) => a.candidateId)));
  const appIds = applications.map((a) => a.id);

  const [
    { data: candRows, error: candError },
    { data: intRows, error: intError },
    { data: rejRows, error: rejError },
  ] = await Promise.all([
    supabase.from("recruitment_candidates").select("*").in("id", candidateIds),
    supabase.from("recruitment_interviews").select("*").in("application_id", appIds),
    supabase
      .from("recruitment_applications")
      .select("candidate_id,stage")
      .in("candidate_id", candidateIds)
      .in("stage", ["application_rejected", "application_withdrawn"]),
  ]);
  if (candError) throw candError;
  if (intError) throw intError;
  if (rejError) throw rejError;

  const candidatesById = new Map<string, Candidate>();
  for (const row of (candRows ?? []) as CandidateDbRow[]) {
    const candidate = mapCandidate(row);
    candidatesById.set(candidate.id, candidate);
  }

  const interviewsByApp = new Map<string, SelectionBoardInterview[]>();
  for (const row of (intRows ?? []) as InterviewDbRow[]) {
    const interview = mapInterview(row);
    const summary = summarizeScorecard(interview.interviewType, interview.score);
    const list = interviewsByApp.get(interview.applicationId) ?? [];
    list.push({ id: interview.id, type: interview.interviewType, average: summary.average, outcome: interview.outcome });
    interviewsByApp.set(interview.applicationId, list);
  }

  const priorByCandidate = new Map<string, number>();
  for (const row of (rejRows ?? []) as Array<{ candidate_id: string }>) {
    const id = String(row.candidate_id);
    priorByCandidate.set(id, (priorByCandidate.get(id) ?? 0) + 1);
  }

  return applications.map((application) => {
    const interviews = interviewsByApp.get(application.id) ?? [];
    const rated = interviews.map((entry) => entry.average).filter((value): value is number => value !== null);
    const ratingAverage = rated.length
      ? Math.round((rated.reduce((sum, value) => sum + value, 0) / rated.length) * 10) / 10
      : null;
    const priorRejections = priorByCandidate.get(application.candidateId) ?? 0;
    return {
      application,
      candidate: candidatesById.get(application.candidateId) ?? null,
      ratingAverage,
      interviews,
      priorRejections,
      riskPreviouslyRejected: priorRejections > 0,
    };
  });
}
