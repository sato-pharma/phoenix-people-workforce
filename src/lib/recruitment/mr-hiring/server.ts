// Recruitment / Medical Rep hiring — the reads the screens make.
//
// SERVER ONLY. Each read is gated here before anything is loaded or returned:
//   * the board — the HR Manager, Talent Acquisition and the CEO (the read-all seats);
//   * one candidate's journey (§10) — the read-all seats and everyone involved (access.ts);
//   * one candidate's CV and application — exactly the people who may read the journey, at every
//     step (owner, 7 Nov 2026: "the cv and application must appear ... in all steps for every one");
//   * a manager's own Medical Rep interviews — only the interviews that person is on.
// The Talent Acquisition fence is asked by the page or route that hands the rows on (the fence's own
// test walks those files), never inside these readers.

import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { forbiddenError, notFoundError } from "@/lib/http/api-errors";
import { listCandidateStatusEvents } from "@/lib/recruitment/candidates";
import type { CandidateTimelineEvent } from "@/lib/recruitment/candidate-timeline";
import { recruitmentDb } from "@/lib/recruitment/db";
import { getFileForDownload, listCandidateFiles, type FileDownload } from "@/lib/recruitment/files";
import { loadPeople, personName } from "@/lib/recruitment/interview-calendar";
import { listSendsForCandidate } from "@/lib/recruitment/manager-sends";
import { isOnBooking, mayReadMrJourney, mrViewer, redactFactsFor } from "@/lib/recruitment/mr-hiring/access";
import {
  loadMrCandidate,
  loadMrCandidates,
  MR_ROLE_FAMILY,
  MR_ROLE_TAB,
  mrCandidateIdsInterviewedBy,
  type MrCandidateRecord,
} from "@/lib/recruitment/mr-hiring/facts-db";
import { loadMrAreaChoices } from "@/lib/recruitment/mr-hiring/areas";
import { buildMrJourneyTimeline } from "@/lib/recruitment/mr-hiring/journey";
import { buildMrRow, type MrInterviewRow, type MrRow } from "@/lib/recruitment/mr-hiring/rows";
import type { MrAreaChoice } from "@/lib/recruitment/mr-hiring/vocabulary";
import type { RecruitmentFile } from "@/lib/recruitment/types";
import { answerChipsFor, answerMarkHrIds, loadAnswerChipContext } from "@/lib/recruitment/workspace/answer-chips";
import type { WorkspaceAnswerChip } from "@/lib/recruitment/workspace/types";

/** Every Medical Rep candidate, for the read-all seats. Refuses anyone else. */
export async function loadMrBoardRecords(access: AccessContext): Promise<MrCandidateRecord[]> {
  if (!mrViewer(access).readsAll) throw forbiddenError("The Medical Rep hiring page is for the HR Manager, Talent Acquisition and the CEO.");
  return loadMrCandidates();
}

/** The rows for records the caller already loaded (and fenced). */
export function mrRowsFor(access: AccessContext, records: readonly MrCandidateRecord[], now: Date = new Date()): MrRow[] {
  const viewer = mrViewer(access);
  return records.map((record) => buildMrRow(viewer, record, now));
}

export type MrJourney = {
  row: MrRow;
  timeline: CandidateTimelineEvent[];
  /** The areas HR may confirm — sent only while this viewer may record the 1st interview's result. */
  areaChoices: MrAreaChoice[];
};

/** The candidate, when this viewer may read their journey; anyone else is told they are not there. */
async function readableMrRecord(access: AccessContext, candidateId: string): Promise<MrCandidateRecord> {
  const record = await loadMrCandidate(candidateId);
  // Someone not involved is told the candidate is not there, never that a candidate exists.
  if (!record || !(await mayReadMrJourney(access, record))) throw notFoundError("This candidate is not in the Medical Rep hiring list.");
  return record;
}

/**
 * Whether this person may have spoken words rewritten for a comment on this candidate: someone who reads the
 * journey and can write on it — the CEO reads every journey but records nothing, so he is refused. The words
 * themselves never reach the model with the candidate's name; this only keeps a paid call to the people who
 * have a comment box open on this candidate.
 */
export async function assertMayPolishMrWords(access: AccessContext, candidateId: string): Promise<void> {
  const viewer = mrViewer(access);
  if (viewer.isCeo && !viewer.canWork) throw forbiddenError("The CEO reads the Medical Rep hiring journey and records nothing on it.");
  await readableMrRecord(access, candidateId);
}

/** One candidate's whole journey (§10), salary removed for anyone who may not see it. */
export async function loadMrJourney(access: AccessContext, candidateId: string): Promise<MrJourney> {
  const record = await readableMrRecord(access, candidateId);
  const viewer = mrViewer(access);
  const [statusEvents, sends] = await Promise.all([
    listCandidateStatusEvents(candidateId).catch(() => []),
    listSendsForCandidate(candidateId).catch(() => []),
  ]);
  const timeline = buildMrJourneyTimeline(
    { ...record, facts: redactFactsFor(viewer, record.facts) },
    { sends: sends.map((send) => ({ managerName: send.managerName, position: send.position, sentAt: send.sentAt })), statusEvents },
  );
  const row = buildMrRow(viewer, record);
  const areaChoices = row.can.record === "hr_first" ? await loadMrAreaChoices().catch(() => []) : [];
  return { areaChoices, row, timeline };
}

export type MrCvAndApplication = {
  /** Every question the candidate was asked and their answer, as the workspace's Medical Rep tab labels it. */
  application: WorkspaceAnswerChip[];
  /** The candidate's files, newest first. */
  files: RecruitmentFile[];
  /**
   * The managers' rule everywhere in the portal: a manager reads the CV with its phone numbers masked
   * and cannot download it — HR books every Medical Rep interview, so no manager needs the number.
   */
  phonesHidden: boolean;
};

/** The reply columns the application reads — the applicant's own answers, never a CV-reading column. */
const APPLICATION_COLUMNS =
  "declared_role_family,applied_for_job_title,preferences_declared_at,declared_background,declared_experience,declared_expected_salary,preferred_region_code,preferred_region_name,preferred_area_name,screening_extra_answers,answer_marks,missing_answer_keys";

type ApplicationRow = {
  declared_role_family: string | null;
  applied_for_job_title: string | null;
  preferences_declared_at: string | null;
  declared_background: string | null;
  declared_experience: string | null;
  declared_expected_salary: string | null;
  preferred_region_code: string | null;
  preferred_region_name: string | null;
  preferred_area_name: string | null;
  screening_extra_answers: Record<string, unknown> | null;
  answer_marks: Record<string, unknown> | null;
  missing_answer_keys: string[] | null;
};

/** The candidate's application: every question and answer, under the labels the workspace's Medical Rep tab uses. */
async function loadMrApplication(candidateId: string): Promise<WorkspaceAnswerChip[]> {
  const [{ data, error }, context] = await Promise.all([
    recruitmentDb().from("ats_candidates").select(APPLICATION_COLUMNS).eq("id", candidateId).maybeSingle(),
    loadAnswerChipContext(),
  ]);
  if (error) throw new Error(error.message);
  if (!data) return [];
  const row = data as unknown as ApplicationRow;
  const people = await loadPeople(answerMarkHrIds(row.answer_marks));
  return answerChipsFor(
    {
      answerMarks: row.answer_marks,
      appliedForJobTitle: row.applied_for_job_title,
      declaredBackground: row.declared_background,
      declaredExpectedSalary: row.declared_expected_salary,
      declaredExperience: row.declared_experience,
      declaredRoleFamily: row.declared_role_family,
      preferencesDeclaredAt: row.preferences_declared_at,
      preferredAreaName: row.preferred_area_name,
      preferredRegionCode: row.preferred_region_code,
      preferredRegionName: row.preferred_region_name,
      screeningExtraAnswers: row.screening_extra_answers,
    },
    {
      context,
      missingKeys: Array.isArray(row.missing_answer_keys) ? row.missing_answer_keys : null,
      nameOf: (hrId) => personName(people, hrId),
      roleFamily: MR_ROLE_FAMILY,
      tab: MR_ROLE_TAB,
    },
  );
}

/**
 * One candidate's CV and application, for exactly the people who may read the journey — the HR
 * Manager, Talent Acquisition, the CEO and every manager involved — whatever step the candidate is on.
 */
export async function loadMrCvAndApplication(access: AccessContext, candidateId: string): Promise<MrCvAndApplication> {
  await readableMrRecord(access, candidateId);
  const [files, application] = await Promise.all([listCandidateFiles(candidateId), loadMrApplication(candidateId)]);
  return { application, files, phonesHidden: !mrViewer(access).readsAll };
}

/** One of THIS candidate's files, for the same people; null when the file is not one of theirs. */
export async function loadMrCvFile(access: AccessContext, candidateId: string, fileId: string): Promise<FileDownload | null> {
  await readableMrRecord(access, candidateId);
  const files = await listCandidateFiles(candidateId);
  if (!files.some((file) => file.id === fileId)) return null;
  return getFileForDownload(fileId);
}

/** The Medical Rep interviews this person is on — the manager portal's "My Medical Rep interviews". */
export async function loadMyMrInterviews(access: AccessContext, now: Date = new Date()): Promise<MrInterviewRow[]> {
  const viewer = mrViewer(access);
  if (!viewer.hrIdKey) return [];
  const ids = await mrCandidateIdsInterviewedBy(hrIdLookupKeys(access.hrId));
  if (ids.length === 0) return [];
  const records = await loadMrCandidates({ candidateIds: ids });
  const rows: MrInterviewRow[] = [];
  for (const record of records) {
    const mine = record.facts.bookings
      .filter((booking) => booking.round !== null && isOnBooking(viewer, booking))
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
    if (mine.length === 0) continue;
    rows.push({ ...buildMrRow(viewer, record, now), mine });
  }
  // The newest interview first — the one a manager is about to hold or has just held.
  return rows.sort((left, right) => (right.mine.at(-1)?.startsAt ?? "").localeCompare(left.mine.at(-1)?.startsAt ?? ""));
}
