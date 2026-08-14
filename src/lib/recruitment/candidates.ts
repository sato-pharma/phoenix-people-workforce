// Recruitment / ATS — candidates service (pool, hybrid dedup, bulk import).

import type { AccessContext } from "@/lib/auth/permissions";
import {
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { assertCanDeleteRecruitment } from "@/lib/recruitment/access";
import { describeCandidateSource, type SourceContextRow } from "@/lib/recruitment/candidate-source-context";
import { chunkIds } from "@/lib/recruitment/db-batch";
import type { CvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import {
  candidateMatchKeys,
  findDuplicateFlags,
  findMatchingCandidate,
  normalizeEmail,
  normalizeNationalId,
  normalizePhone,
  type MatchableCandidate,
} from "@/lib/recruitment/candidate-matching";
import {
  boolOrNull,
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
  CandidateSourceContext,
  CreateCandidateInput,
  Interview,
  RecruitmentFile,
  UpdateCandidateInput,
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
    address: textOrNull(input.address),
    governorate: textOrNull(input.governorate),
    current_employer: textOrNull(input.currentEmployer),
    years_experience: numberOrNull(input.yearsExperience),
    expected_salary: numberOrNull(input.expectedSalary),
    notice_period: textOrNull(input.noticePeriod),
    source: textOrNull(input.source),
    cv_reference_name: textOrNull(input.cvReferenceName),
    cv_external_url: textOrNull(input.cvExternalUrl),
    notes: textOrNull(input.notes),
    faculty: textOrNull(input.faculty),
    university: textOrNull(input.university),
    has_prior_work_experience: boolOrNull(input.hasPriorWorkExperience),
    has_medical_rep_experience: boolOrNull(input.hasMedicalRepExperience),
    medical_rep_employer: textOrNull(input.medicalRepEmployer),
    medical_rep_experience_from: textOrNull(input.medicalRepExperienceFrom),
    medical_rep_experience_to: textOrNull(input.medicalRepExperienceTo),
    position_specific_fields: input.positionSpecificFields ?? {},
    created_by: access.hrId ?? access.loginId ?? null,
  };
}

// Merges a position's "jsonb"-storage field values into whatever's already stored on the
// candidate, leaving other keys untouched. Unexercised today — Medical Rep's fields are all
// storage:"column" — this is the write path a future position's schema (cv-field-schemas.ts)
// would use instead.
export function applyPositionSpecificFields(
  schema: CvPositionSchema,
  existing: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const field of schema.fields) {
    if (field.storage !== "jsonb") continue;
    if (field.key in values) merged[field.key] = values[field.key];
  }
  return merged;
}

async function loadMatchKeys(): Promise<MatchableCandidate[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .select("id,national_id_norm,email_norm,phone_norm");
  if (error) throw error;
  return ((data ?? []) as CandidateDbRow[]).map((row) => ({
    id: String(row.id),
    nationalIdNorm: textOrNull(row.national_id_norm),
    emailNorm: textOrNull(row.email_norm),
    phoneNorm: textOrNull(row.phone_norm),
  }));
}

// Loads each candidate's most-recent intake event (from the ats_candidate_source_context view)
// and reduces it to the display shape, keyed by candidate id. Best-effort: if the view is missing
// (migration not yet applied) or the query fails, returns an empty map so candidates still list —
// the source column simply shows nothing rather than breaking the page.
async function loadSourceContextByCandidate(ids: string[]): Promise<Map<string, CandidateSourceContext>> {
  const map = new Map<string, CandidateSourceContext>();
  if (ids.length === 0) return map;
  const supabase = recruitmentDb();
  // listCandidates passes the WHOLE pool through here, so the id list is unbounded and must be
  // batched (see db-batch.ts). chunkIds rather than fetchRowsInBatches because this stays
  // best-effort: one failed batch drops its own enrichment, it does not break the candidate list.
  const rows: SourceContextRow[] = [];
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from("ats_candidate_source_context")
      .select("candidate_id,channel,subject,raw_metadata")
      .in("candidate_id", batch);
    if (error || !data) continue;
    rows.push(...(data as SourceContextRow[]));
  }
  for (const row of rows) {
    const candidateId = textOrNull((row as { candidate_id?: unknown }).candidate_id);
    if (!candidateId) continue;
    map.set(candidateId, describeCandidateSource(row));
  }
  return map;
}

export async function listCandidates(): Promise<Candidate[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const candidates = ((data ?? []) as CandidateDbRow[]).map(mapCandidate);
  const sourceContext = await loadSourceContextByCandidate(candidates.map((candidate) => candidate.id));
  // Advisory soft-duplicate flags across the whole pool (same phone-tail / normalized name). Purely
  // a "worth a look" marker for Talent Acquisition — never merges anything.
  const dupFlags = findDuplicateFlags(
    candidates.map((candidate) => ({ fullName: candidate.fullName, id: candidate.id, phoneNorm: normalizePhone(candidate.phone) })),
  );
  for (const candidate of candidates) {
    const context = sourceContext.get(candidate.id);
    if (context) candidate.sourceContext = context;
    const flag = dupFlags.get(candidate.id);
    candidate.possibleDuplicate = flag ? { candidateId: flag.id, reason: flag.reason } : null;
  }
  return candidates;
}

export async function getCandidate(id: string): Promise<Candidate | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
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
  let query = supabase.from("ats_candidates").select("*").order("created_at", { ascending: false });
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
    .from("ats_candidates")
    .update({ status: clean, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapCandidate(data as CandidateDbRow);
}

// Partial edit of a candidate's own fields (not status — see updateCandidateStatus).
// An omitted key leaves that column untouched; an explicit `null` clears it. The
// identity-match columns (national_id_norm/email_norm/phone_norm) are only recomputed
// for whichever of nationalId/email/phone is actually present in this call, so editing
// one identity field never wipes the norm of an untouched one.
function updateCandidatePayload(input: UpdateCandidateInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.fullName !== undefined) payload.full_name = String(input.fullName ?? "").trim();
  if (input.nationalId !== undefined) {
    payload.national_id = textOrNull(input.nationalId);
    payload.national_id_norm = normalizeNationalId(input.nationalId);
  }
  if (input.email !== undefined) {
    payload.email = textOrNull(input.email);
    payload.email_norm = normalizeEmail(input.email);
  }
  if (input.phone !== undefined) {
    payload.phone = textOrNull(input.phone);
    payload.phone_norm = normalizePhone(input.phone);
  }
  if (input.address !== undefined) payload.address = textOrNull(input.address);
  if (input.governorate !== undefined) payload.governorate = textOrNull(input.governorate);
  if (input.currentEmployer !== undefined) payload.current_employer = textOrNull(input.currentEmployer);
  if (input.yearsExperience !== undefined) payload.years_experience = numberOrNull(input.yearsExperience);
  if (input.expectedSalary !== undefined) payload.expected_salary = numberOrNull(input.expectedSalary);
  if (input.noticePeriod !== undefined) payload.notice_period = textOrNull(input.noticePeriod);
  if (input.source !== undefined) payload.source = textOrNull(input.source);
  if (input.cvReferenceName !== undefined) payload.cv_reference_name = textOrNull(input.cvReferenceName);
  if (input.cvExternalUrl !== undefined) payload.cv_external_url = textOrNull(input.cvExternalUrl);
  if (input.notes !== undefined) payload.notes = textOrNull(input.notes);
  if (input.faculty !== undefined) payload.faculty = textOrNull(input.faculty);
  if (input.university !== undefined) payload.university = textOrNull(input.university);
  if (input.hasPriorWorkExperience !== undefined) {
    payload.has_prior_work_experience = boolOrNull(input.hasPriorWorkExperience);
  }
  if (input.hasMedicalRepExperience !== undefined) {
    payload.has_medical_rep_experience = boolOrNull(input.hasMedicalRepExperience);
  }
  if (input.medicalRepEmployer !== undefined) payload.medical_rep_employer = textOrNull(input.medicalRepEmployer);
  if (input.medicalRepExperienceFrom !== undefined) {
    payload.medical_rep_experience_from = textOrNull(input.medicalRepExperienceFrom);
  }
  if (input.medicalRepExperienceTo !== undefined) {
    payload.medical_rep_experience_to = textOrNull(input.medicalRepExperienceTo);
  }
  if (input.positionSpecificFields !== undefined) {
    payload.position_specific_fields = input.positionSpecificFields ?? {};
  }
  return payload;
}

export async function updateCandidate(id: string, input: UpdateCandidateInput): Promise<Candidate> {
  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");
  if (input.fullName !== undefined && !String(input.fullName ?? "").trim()) {
    throw new Error("Candidate full name is required.");
  }
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update(updateCandidatePayload(input))
    .eq("id", id)
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new Error("Another candidate already has that National ID, email, or phone.");
    }
    throw error;
  }
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
  const context = (await loadSourceContextByCandidate([id])).get(id);
  if (context) candidate.sourceContext = context;
  const supabase = recruitmentDb();

  const [{ data: appRows, error: appError }, { data: fileRows, error: fileError }] = await Promise.all([
    supabase.from("ats_applications").select("*").eq("candidate_id", id).order("created_at", { ascending: false }),
    supabase.from("ats_files").select("*").eq("candidate_id", id).order("created_at", { ascending: false }),
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
      .from("ats_requisitions")
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
      supabase.from("ats_interviews").select("*").in("application_id", appIds).order("created_at", { ascending: false }),
      supabase.from("ats_application_events").select("*").in("application_id", appIds).order("created_at", { ascending: false }),
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
  const { error } = await supabase.from("ats_candidates").delete().eq("id", id);
  if (error) throw error;
}

// Create-or-attach: dedupes on National ID, else email, else phone.
// Shared by createCandidate (single-row API, always loads a fresh key list) and the bulk import
// loop (loads the key list ONCE up front and keeps it updated in-memory as rows are processed —
// see importCandidatesWorkbook). existingKeys is mutated in place so a later row in the same
// batch can match a candidate created by an earlier row in that same batch. The DB partial-unique
// index remains the race-safety net for true concurrent requests (e.g. two overlapping uploads);
// that fallback re-queries fresh on a 23505 conflict regardless of caller.
async function matchOrInsertCandidate(
  input: CreateCandidateInput,
  access: AccessContext,
  existingKeys: MatchableCandidate[],
): Promise<CandidateUpsertResult> {
  const keys = candidateMatchKeys(input);
  const match = findMatchingCandidate(existingKeys, keys);
  if (match) {
    return { candidate: await fetchById(match.id), created: false, matchReason: match.reason };
  }

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
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

  const candidate = mapCandidate(data as CandidateDbRow);
  existingKeys.push({ id: candidate.id, ...keys });
  return { candidate, created: true };
}

export async function createCandidate(
  input: CreateCandidateInput,
  access: AccessContext,
): Promise<CandidateUpsertResult> {
  if (!String(input.fullName ?? "").trim()) {
    throw new Error("Candidate full name is required.");
  }

  const existingKeys = await loadMatchKeys();
  return matchOrInsertCandidate(input, access, existingKeys);
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

  // Load the dedup key list ONCE for the whole batch (was previously reloaded — a full
  // ats_candidates scan — inside createCandidate on every single row). Mutated in place
  // by matchOrInsertCandidate as rows are created, so a later row in this same file can still
  // match an earlier row in the same file.
  const existingKeys = await loadMatchKeys();

  let rowNumber = 1; // header is row 1
  for (const row of rows) {
    rowNumber += 1;
    const input = rowToCandidateInput(row);
    if (!String(input.fullName ?? "").trim()) continue; // skip blank lines
    summary.total += 1;
    try {
      const result = await matchOrInsertCandidate(input, access, existingKeys);
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
