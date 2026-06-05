// Recruitment / ATS — candidates service (pool, hybrid dedup, bulk import).

import type { AccessContext } from "@/lib/auth/permissions";
import {
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { assertCanDeleteRecruitment } from "@/lib/recruitment/access";
import {
  candidateMatchKeys,
  findMatchingCandidate,
  type MatchableCandidate,
} from "@/lib/recruitment/candidate-matching";
import {
  mapApplication,
  mapApplicationEvent,
  mapCandidate,
  mapInterview,
  mapRecruitmentFile,
  numberOrNull,
  recruitmentDb,
  textOrNull,
  type ApplicationDbRow,
  type ApplicationEventDbRow,
  type CandidateDbRow,
  type InterviewDbRow,
  type RecruitmentFileDbRow,
} from "@/lib/recruitment/db";
import { summarizeScorecard, type ScorecardSummary } from "@/lib/recruitment/scorecards";
import type {
  Application,
  ApplicationEvent,
  Candidate,
  CreateCandidateInput,
  Interview,
  RecruitmentFile,
} from "@/lib/recruitment/types";

export type CandidateUpsertResult = {
  candidate: Candidate;
  created: boolean;
  matchReason?: "national_id" | "email" | "phone";
};

function candidatePayload(input: CreateCandidateInput, access: AccessContext) {
  const keys = candidateMatchKeys(input);
  return {
    full_name: String(input.fullName ?? "").trim(),
    national_id: textOrNull(input.nationalId),
    national_id_norm: keys.nationalIdNorm,
    email: textOrNull(input.email),
    email_norm: keys.emailNorm,
    phone: textOrNull(input.phone),
    phone_norm: keys.phoneNorm,
    governorate: textOrNull(input.governorate),
    current_employer: textOrNull(input.currentEmployer),
    years_experience: numberOrNull(input.yearsExperience),
    expected_salary: numberOrNull(input.expectedSalary),
    notice_period: textOrNull(input.noticePeriod),
    source: textOrNull(input.source),
    cv_reference_name: textOrNull(input.cvReferenceName),
    cv_external_url: textOrNull(input.cvExternalUrl),
    notes: textOrNull(input.notes),
    created_by: access.hrId ?? access.loginId ?? null,
  };
}

async function loadMatchKeys(): Promise<MatchableCandidate[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_candidates")
    .select("id,national_id_norm,email_norm,phone_norm");
  if (error) throw error;
  return ((data ?? []) as CandidateDbRow[]).map((row) => ({
    id: String(row.id),
    nationalIdNorm: textOrNull(row.national_id_norm),
    emailNorm: textOrNull(row.email_norm),
    phoneNorm: textOrNull(row.phone_norm),
  }));
}

export async function listCandidates(): Promise<Candidate[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_candidates")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as CandidateDbRow[]).map(mapCandidate);
}

export async function getCandidate(id: string): Promise<Candidate | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_candidates")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapCandidate(data as CandidateDbRow) : null;
}

async function fetchById(id: string): Promise<Candidate> {
  const candidate = await getCandidate(id);
  if (!candidate) throw new Error("Candidate not found after match.");
  return candidate;
}

// ---------------------------------------------------------------------------
// Rule 4 — Candidate Pool: search, status, and the aggregated profile.
// ---------------------------------------------------------------------------

export type CandidateSearchFilters = { q?: string | null; status?: string | null; source?: string | null };

export async function searchCandidates(filters: CandidateSearchFilters = {}): Promise<Candidate[]> {
  const supabase = recruitmentDb();
  let query = supabase.from("recruitment_candidates").select("*").order("created_at", { ascending: false });
  const status = textOrNull(filters.status);
  const source = textOrNull(filters.source);
  if (status) query = query.eq("status", status);
  if (source) query = query.eq("source", source);
  const q = textOrNull(filters.q);
  if (q) {
    const like = `%${q.replace(/[%_,()]/g, "")}%`;
    query = query.or(
      `full_name.ilike.${like},email.ilike.${like},phone.ilike.${like},national_id.ilike.${like}`,
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as CandidateDbRow[]).map(mapCandidate);
}

export async function updateCandidateStatus(id: string, status: string): Promise<Candidate> {
  const clean = String(status ?? "").trim();
  if (!clean) throw new Error("Candidate status is required.");
  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_candidates")
    .update({ status: clean, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapCandidate(data as CandidateDbRow);
}

export type CandidateProfile = {
  candidate: Candidate;
  files: RecruitmentFile[];
  applications: Array<{ application: Application; jobTitle: string | null }>;
  interviews: Array<{ interview: Interview; summary: ScorecardSummary }>;
  rejectionHistory: ApplicationEvent[];
  ratingAverage: number | null;
};

export async function getCandidateProfile(id: string): Promise<CandidateProfile | null> {
  const candidate = await getCandidate(id);
  if (!candidate) return null;
  const supabase = recruitmentDb();

  const [{ data: appRows, error: appError }, { data: fileRows, error: fileError }] = await Promise.all([
    supabase.from("recruitment_applications").select("*").eq("candidate_id", id).order("created_at", { ascending: false }),
    supabase.from("recruitment_files").select("*").eq("candidate_id", id).order("created_at", { ascending: false }),
  ]);
  if (appError) throw appError;
  if (fileError) throw fileError;

  const applications = ((appRows ?? []) as ApplicationDbRow[]).map(mapApplication);
  const files = ((fileRows ?? []) as RecruitmentFileDbRow[]).map(mapRecruitmentFile);
  const appIds = applications.map((a) => a.id);
  const reqIds = Array.from(new Set(applications.map((a) => a.requisitionId)));

  const jobTitleById = new Map<string, string>();
  if (reqIds.length > 0) {
    const { data: reqRows, error: reqError } = await supabase
      .from("recruitment_requisitions")
      .select("id,job_title")
      .in("id", reqIds);
    if (reqError) throw reqError;
    for (const row of (reqRows ?? []) as Array<{ id: string; job_title: string | null }>) {
      jobTitleById.set(String(row.id), String(row.job_title ?? ""));
    }
  }

  let interviews: Interview[] = [];
  let events: ApplicationEvent[] = [];
  if (appIds.length > 0) {
    const [{ data: intRows, error: intError }, { data: evtRows, error: evtError }] = await Promise.all([
      supabase.from("recruitment_interviews").select("*").in("application_id", appIds).order("created_at", { ascending: false }),
      supabase.from("recruitment_application_events").select("*").in("application_id", appIds).order("created_at", { ascending: false }),
    ]);
    if (intError) throw intError;
    if (evtError) throw evtError;
    interviews = ((intRows ?? []) as InterviewDbRow[]).map(mapInterview);
    events = ((evtRows ?? []) as ApplicationEventDbRow[]).map(mapApplicationEvent);
  }

  const interviewSummaries = interviews.map((interview) => ({
    interview,
    summary: summarizeScorecard(interview.interviewType, interview.score),
  }));
  const averages = interviewSummaries
    .map((entry) => entry.summary.average)
    .filter((value): value is number => value !== null);
  const ratingAverage =
    averages.length > 0 ? Math.round((averages.reduce((s, v) => s + v, 0) / averages.length) * 10) / 10 : null;

  return {
    candidate,
    files,
    applications: applications.map((application) => ({
      application,
      jobTitle: jobTitleById.get(application.requisitionId) ?? null,
    })),
    interviews: interviewSummaries,
    rejectionHistory: events.filter((event) => event.action === "app_reject" || event.action === "app_withdraw"),
    ratingAverage,
  };
}

// Hard-delete a candidate (admin cleanup). Database cascades remove their
// applications and any application children + files.
export async function deleteCandidate(access: AccessContext, id: string): Promise<void> {
  assertCanDeleteRecruitment(access);
  const candidate = await getCandidate(id);
  if (!candidate) throw new Error("Candidate not found.");
  const supabase = recruitmentDb();
  const { error } = await supabase.from("recruitment_candidates").delete().eq("id", id);
  if (error) throw error;
}

// Create-or-attach: dedupes on National ID, else email, else phone.
export async function createCandidate(
  input: CreateCandidateInput,
  access: AccessContext,
): Promise<CandidateUpsertResult> {
  if (!String(input.fullName ?? "").trim()) {
    throw new Error("Candidate full name is required.");
  }

  const keys = candidateMatchKeys(input);
  const existingKeys = await loadMatchKeys();
  const match = findMatchingCandidate(existingKeys, keys);
  if (match) {
    return { candidate: await fetchById(match.id), created: false, matchReason: match.reason };
  }

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("recruitment_candidates")
    .insert(candidatePayload(input, access))
    .select("*")
    .single();

  if (error) {
    // Lost a race to a partial-unique index — re-resolve the winner.
    if ((error as { code?: string }).code === "23505") {
      const rematch = findMatchingCandidate(await loadMatchKeys(), keys);
      if (rematch) {
        return { candidate: await fetchById(rematch.id), created: false, matchReason: rematch.reason };
      }
    }
    throw error;
  }

  return { candidate: mapCandidate(data as CandidateDbRow), created: true };
}

// ---------------------------------------------------------------------------
// Bulk spreadsheet import.
// ---------------------------------------------------------------------------

export const candidateImportHeaders = [
  "Full Name",
  "National ID",
  "Email",
  "Mobile Number",
  "Governorate",
  "Current Employer",
  "Years of Experience",
  "Expected Salary",
  "Notice Period",
  "Source",
  "CV Name",
] as const;

export type CandidateImportSummary = {
  total: number;
  created: number;
  matched: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
};

function rowToCandidateInput(row: Record<string, unknown>): CreateCandidateInput {
  const get = (key: string) => textOrNull(row[key]);
  return {
    fullName: get("Full Name") ?? "",
    nationalId: get("National ID"),
    email: get("Email"),
    phone: get("Mobile Number") ?? get("Phone"),
    governorate: get("Governorate"),
    currentEmployer: get("Current Employer"),
    yearsExperience: numberOrNull(row["Years of Experience"]),
    expectedSalary: numberOrNull(row["Expected Salary"]),
    noticePeriod: get("Notice Period"),
    source: get("Source"),
    cvReferenceName: get("CV Name"),
  };
}

export async function importCandidatesWorkbook(
  buffer: ArrayBuffer,
  access: AccessContext,
): Promise<CandidateImportSummary> {
  const workbook = await loadExcelWorkbook(buffer);
  const worksheet = firstExcelWorksheet(workbook);
  if (!worksheet) throw new Error("The uploaded workbook has no worksheet.");

  const rows = excelWorksheetToJsonRows(worksheet, 1);
  const summary: CandidateImportSummary = { total: 0, created: 0, matched: 0, failed: 0, errors: [] };

  let rowNumber = 1; // header is row 1
  for (const row of rows) {
    rowNumber += 1;
    const input = rowToCandidateInput(row);
    if (!String(input.fullName ?? "").trim()) continue; // skip blank lines
    summary.total += 1;
    try {
      const result = await createCandidate(input, access);
      if (result.created) summary.created += 1;
      else summary.matched += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({
        row: rowNumber,
        message: error instanceof Error ? error.message : "Unknown import error.",
      });
    }
  }

  return summary;
}
