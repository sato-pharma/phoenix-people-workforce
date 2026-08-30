// Recruitment / ATS — candidates service (pool, hybrid dedup, bulk import).

import type { AccessContext } from "@/lib/auth/permissions";
import {
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { assertCanDeleteRecruitment } from "@/lib/recruitment/access";
import { candidateAppliedFor, freeAppliedForEvidence } from "@/lib/recruitment/applied-for";
import {
  candidateFolderRefusal,
  cleanFolderKey,
  isCandidateFolderKind,
} from "@/lib/recruitment/candidate-folder";
import { describeCandidateSource, type SourceContextRow } from "@/lib/recruitment/candidate-source-context";
import type { CandidateUnconfirmedCvFacts } from "@/lib/recruitment/candidate-screening-facts";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { listSendsForManager, managerSendStamp, type ManagerSend } from "@/lib/recruitment/manager-sends";
import { hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id";
import {
  listHiringManagerOptions,
  pushCandidatesToManager,
} from "@/lib/recruitment/hiring-manager-notify";
import { cvPositionSchemas, defaultCvPositionKey, type CvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
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
  mapCandidateStatusEvent,
  mapInterview,
  mapRecruitmentFile,
  numberOrNull,
  recruitmentDb,
  textOrNull,
  type ApplicationDbRow,
  type ApplicationEventDbRow,
  type CandidateDbRow,
  type CandidateStatusEventDbRow,
  type InterviewDbRow,
  type RecruitmentFileDbRow,
} from "@/lib/recruitment/db";
import { logError } from "@/lib/observability/log";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import { resolveSentForPosition } from "@/lib/recruitment/vacancy-options";
import {
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  normalizeCandidateStatus,
  type CandidateStatus,
} from "@/lib/recruitment/candidate-status";
import { summarizeScorecard, type ScorecardSummary } from "@/lib/recruitment/scorecards";
import type {
  Application,
  ApplicationEvent,
  Candidate,
  CandidateSourceContext,
  CandidateStatusEvent,
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
    whatsapp: textOrNull(input.whatsapp),
    linkedin_url: textOrNull(input.linkedinUrl),
    nationality: textOrNull(input.nationality),
    date_of_birth: textOrNull(input.dateOfBirth),
    place_of_birth: textOrNull(input.placeOfBirth),
    gender: textOrNull(input.gender),
    marital_status: textOrNull(input.maritalStatus),
    military_status: textOrNull(input.militaryStatus),
    address: textOrNull(input.address),
    governorate: textOrNull(input.governorate),
    current_job_title: textOrNull(input.currentJobTitle),
    applied_for_job_title: textOrNull(input.appliedForJobTitle),
    applied_for_evidence: textOrNull(input.appliedForEvidence),
    professional_summary: textOrNull(input.professionalSummary),
    current_employer: textOrNull(input.currentEmployer),
    current_role_responsibilities: textOrNull(input.currentRoleResponsibilities),
    years_experience: numberOrNull(input.yearsExperience),
    expected_salary: numberOrNull(input.expectedSalary),
    notice_period: textOrNull(input.noticePeriod),
    source: textOrNull(input.source),
    cv_reference_name: textOrNull(input.cvReferenceName),
    cv_external_url: textOrNull(input.cvExternalUrl),
    notes: textOrNull(input.notes),
    faculty: textOrNull(input.faculty),
    university: textOrNull(input.university),
    degree: textOrNull(input.degree),
    graduation_year: numberOrNull(input.graduationYear),
    grade: textOrNull(input.grade),
    has_prior_work_experience: boolOrNull(input.hasPriorWorkExperience),
    has_medical_rep_experience: boolOrNull(input.hasMedicalRepExperience),
    medical_rep_employer: textOrNull(input.medicalRepEmployer),
    medical_rep_experience_from: textOrNull(input.medicalRepExperienceFrom),
    medical_rep_experience_to: textOrNull(input.medicalRepExperienceTo),
    position_specific_fields: input.positionSpecificFields ?? {},
    created_by: access.hrId ?? access.loginId ?? null,
  };
}

// The schema applyPositionSpecificFields merges through. A candidate row carries no position key,
// and since the schema rewrite there is only one field list anyway — `medical_rep` and
// `district_manager` are aliases onto the universal schema (cv-field-schemas.ts) — so resolving it
// once here is exact, not a fallback.
const universalCvSchema: CvPositionSchema = cvPositionSchemas[defaultCvPositionKey];

// Merges the schema's "jsonb"-storage field values into whatever's already stored on the
// candidate, leaving other keys untouched. Used by updateCandidate: all five repeating blocks
// (workHistory, educationHistory, certifications, skills, languages) share the single
// position_specific_fields column, and a caller normally submits only the block it edited — so a
// wholesale assignment would silently wipe the blocks it did not send (editing work history would
// clear skills). Keys the schema does not declare `storage: "jsonb"` are ignored, which keeps a
// scalar out of the jsonb column even when a caller passes one.
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

/**
 * What the CV reader last read off a candidate's CV, keyed by candidate id: the job they said they
 * were applying for, and — separately — the job they hold today.
 *
 * Both come off the same jsonb blob, so they cost one query between them rather than two. That
 * matters: `extracted_fields` is 1.1 MB across 370 production rows and every round trip from here
 * crosses the Atlantic, which is why this is called with only the candidates the free evidence
 * could not answer.
 *
 * `appliedForJobTitle` is filled on 23 CVs. `currentJobTitle` is filled on 131 — because a CV is
 * written to say what someone has done, and only a covering note says what they want. The two are
 * kept apart all the way to the screen for exactly that reason.
 */
type CvJobTitles = { appliedFor: Map<string, string>; current: Map<string, string> };

async function loadCvJobTitlesByCandidate(ids: string[]): Promise<CvJobTitles> {
  const titles: CvJobTitles = { appliedFor: new Map(), current: new Map() };
  if (ids.length === 0) return titles;
  const supabase = recruitmentDb();
  const readField = (fields: Record<string, unknown> | null, key: string): string | null =>
    textOrNull((fields?.[key] as { value?: unknown } | null | undefined)?.value);
  const seen = new Set<string>();
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from("ats_candidate_cv_extractions")
      .select("candidate_id,created_at,extracted_fields")
      .in("candidate_id", batch)
      .order("created_at", { ascending: false });
    if (error || !data) continue;
    for (const row of data as Array<{ candidate_id?: unknown; extracted_fields?: unknown }>) {
      const candidateId = textOrNull(row.candidate_id);
      // Newest first, so the first row seen for a candidate is the one that counts — and both
      // fields must be taken from that SAME extraction, never mixed across two readings.
      if (!candidateId || seen.has(candidateId)) continue;
      seen.add(candidateId);
      const fields = row.extracted_fields as Record<string, unknown> | null;
      const appliedFor = readField(fields, "appliedForJobTitle");
      const current = readField(fields, "currentJobTitle");
      if (appliedFor) titles.appliedFor.set(candidateId, appliedFor);
      if (current) titles.current.set(candidateId, current);
    }
  }
  return titles;
}

/**
 * The CV reader's LOW-confidence answers, keyed by candidate id — the values the auto-apply gate
 * correctly refused to write onto the columns.
 *
 * Measured on production 2026-08-24 there are 250 of them: 117 years of experience, 73 employers,
 * 44 job titles, 14 medical-rep flags and 2 governorates. Every single one carries
 * `confidence: "low"`, which is the whole reason `selectAutoApplyFields` declined it — a hedged
 * value in a column the rest of the system reads as fact is worse than a gap. Nothing here changes
 * that; the values are carried BESIDE the columns, never merged into them, and every screen that
 * shows one marks it as unconfirmed.
 *
 * Deliberately selects the five jsonb PATHS rather than `extracted_fields` whole. The blob is
 * 1.1 MB across the table and every round trip from here crosses the Atlantic, which is the reason
 * the loader above only reads it for candidates it has to; five scalar keys cost a fraction of that,
 * so this can afford to run for every candidate that is missing anything.
 *
 * Best-effort by design, exactly like its two siblings: a failure here leaves the cells reading
 * "Not on file", which is what they read today, and never breaks the pool.
 */
type UnconfirmedCvFactRow = {
  candidate_id?: unknown;
  employer?: unknown;
  governorate?: unknown;
  pharma?: unknown;
  title?: unknown;
  years?: unknown;
};

/** One `{ value, confidence }` proposal, accepted only when the reader hedged it. */
function lowConfidenceValue(cell: unknown): unknown {
  if (!cell || typeof cell !== "object") return null;
  const proposal = cell as { confidence?: unknown; value?: unknown };
  // "high" values are already on the column — intake applied them. Reading one here would mean
  // showing the same fact twice, once as settled and once as a guess.
  return proposal.confidence === "low" ? (proposal.value ?? null) : null;
}

async function loadUnconfirmedCvFactsByCandidate(ids: string[]): Promise<Map<string, CandidateUnconfirmedCvFacts>> {
  const facts = new Map<string, CandidateUnconfirmedCvFacts>();
  if (ids.length === 0) return facts;
  const supabase = recruitmentDb();
  const seen = new Set<string>();
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from("ats_candidate_cv_extractions")
      .select(
        "candidate_id,created_at," +
          "title:extracted_fields->currentJobTitle," +
          "employer:extracted_fields->currentEmployer," +
          "years:extracted_fields->yearsExperience," +
          "governorate:extracted_fields->governorate," +
          "pharma:extracted_fields->hasMedicalRepExperience",
      )
      .in("candidate_id", batch)
      .order("created_at", { ascending: false });
    if (error || !data) continue;
    for (const row of data as UnconfirmedCvFactRow[]) {
      const candidateId = textOrNull(row.candidate_id);
      // Newest first, so the first row seen for a candidate wins and every fact on it comes from
      // that ONE reading — never mixed across two, which would pair a title from July with an
      // employer from August.
      if (!candidateId || seen.has(candidateId)) continue;
      seen.add(candidateId);
      const years = lowConfidenceValue(row.years);
      const pharma = lowConfidenceValue(row.pharma);
      facts.set(candidateId, {
        currentEmployer: textOrNull(lowConfidenceValue(row.employer)),
        currentJobTitle: textOrNull(lowConfidenceValue(row.title)),
        governorate: textOrNull(lowConfidenceValue(row.governorate)),
        hasMedicalRepExperience: typeof pharma === "boolean" ? pharma : null,
        yearsExperience: typeof years === "number" ? years : null,
      });
    }
  }
  return facts;
}

/**
 * Attaches the hedged CV answers to the candidates that still have a hole one of them could fill.
 *
 * Scoped to those candidates rather than the whole pool because there is nothing to show for
 * somebody whose five columns are already filled — 176 of the 426 production rows need no read at
 * all — and an unconfirmed value must never appear beside a confirmed one for the same fact.
 */
async function attachUnconfirmedCvFacts(candidates: Candidate[]): Promise<void> {
  const needing = candidates.filter(
    (candidate) =>
      !candidate.currentJobTitle ||
      !candidate.currentEmployer ||
      !candidate.governorate ||
      candidate.yearsExperience === null ||
      candidate.hasMedicalRepExperience === null,
  );
  if (needing.length === 0) return;
  const facts = await loadUnconfirmedCvFactsByCandidate(needing.map((candidate) => candidate.id));
  for (const candidate of needing) {
    const found = facts.get(candidate.id);
    if (found) candidate.cvUnconfirmed = found;
  }
}

/**
 * The job title of the vacancy a candidate was formally put forward for, keyed by candidate id.
 *
 * Last rung of the ladder and the smallest — 7 applications against 2 requisitions in production —
 * but it is the one piece of evidence a recruiter created on purpose, so it is worth reading when
 * nothing the applicant wrote answered the question. Best-effort, same as the loaders above.
 */
async function loadRequisitionJobTitleByCandidate(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const supabase = recruitmentDb();
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from("ats_applications")
      .select("candidate_id,created_at,ats_requisitions(job_title)")
      .in("candidate_id", batch)
      .order("created_at", { ascending: false });
    if (error || !data) continue;
    for (const row of data as Array<{ candidate_id?: unknown; ats_requisitions?: unknown }>) {
      const candidateId = textOrNull(row.candidate_id);
      if (!candidateId || map.has(candidateId)) continue;
      const requisition = Array.isArray(row.ats_requisitions) ? row.ats_requisitions[0] : row.ats_requisitions;
      const title = textOrNull((requisition as { job_title?: unknown } | null | undefined)?.job_title);
      if (title) map.set(candidateId, title);
    }
  }
  return map;
}

/**
 * Fills in `sourceContext` and the resolved `appliedFor` on a list of candidates, in place.
 *
 * Two phases on purpose. The free evidence — the stored title, the intake subject, the WhatsApp
 * messages, the `Subject( … )` in the envelope — answers 400 of the 555 production rows and costs
 * exactly one query, the one that loads the intake context. Only what is STILL unanswered goes back
 * to the database for the CV extraction and the requisition, so those two run against ~120 ids
 * rather than all 555. That ordering is what makes reading `extracted_fields` affordable at all:
 * it is 1.1 MB across the table, and every round trip from here crosses the Atlantic.
 */
async function attachAppliedFor(candidates: Candidate[]): Promise<void> {
  if (candidates.length === 0) return;
  const sourceContext = await loadSourceContextByCandidate(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    const context = sourceContext.get(candidate.id);
    if (context) candidate.sourceContext = context;
    candidate.appliedFor = candidateAppliedFor(freeAppliedForEvidence(candidate));
  }

  const unresolved = candidates.filter((candidate) => !candidate.appliedFor?.text);
  if (unresolved.length === 0) return;
  const unresolvedIds = unresolved.map((candidate) => candidate.id);
  const [cvTitles, requisitionTitles] = await Promise.all([
    loadCvJobTitlesByCandidate(unresolvedIds),
    loadRequisitionJobTitleByCandidate(unresolvedIds),
  ]);
  for (const candidate of unresolved) {
    candidate.appliedFor = candidateAppliedFor({
      ...freeAppliedForEvidence(candidate),
      cvCurrentJobTitle: cvTitles.current.get(candidate.id) ?? null,
      cvExtractionJobTitle: cvTitles.appliedFor.get(candidate.id) ?? null,
      requisitionJobTitle: requisitionTitles.get(candidate.id) ?? null,
    });
  }
}

/**
 * The candidates whose most recent CV read judged the file explicitly NOT to be a CV.
 *
 * Three columns, one query, newest row per candidate wins — deliberately NOT a join on
 * `extracted_fields`, which is 1.1 MB across the table and crosses the Atlantic on every read.
 *
 * Only an explicit `false` lands in the set. NULL is "no judgement recorded" — every row written
 * before the column existed reads that way — and calling those not-a-CV would hide real applicants,
 * which is far worse than the confusion this fixes. Same fail-open shape as the intake gate.
 */
async function loadNotACvCandidates(ids: string[]): Promise<Set<string>> {
  const notACv = new Set<string>();
  if (ids.length === 0) return notACv;
  const supabase = recruitmentDb();
  const seen = new Set<string>();
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase
      .from("ats_candidate_cv_extractions")
      .select("candidate_id,created_at,is_cv")
      .in("candidate_id", batch)
      .order("created_at", { ascending: false });
    if (error || !data) continue;
    for (const row of data as Array<{ candidate_id?: unknown; is_cv?: unknown }>) {
      const candidateId = textOrNull(row.candidate_id);
      // Newest first, so the first row seen for a candidate is the verdict that stands. A later
      // re-read that DID find a CV must overrule an older "no", not be overruled by it.
      if (!candidateId || seen.has(candidateId)) continue;
      seen.add(candidateId);
      if (row.is_cv === false) notACv.add(candidateId);
    }
  }
  return notACv;
}

export async function listCandidates(): Promise<Candidate[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const candidates = ((data ?? []) as CandidateDbRow[]).map(mapCandidate);
  // Concurrently: the two enrichments touch different fields on the same objects and neither reads
  // the other's output, so serialising them would only add a second Atlantic round trip to a page
  // that already waits on one.
  await Promise.all([attachAppliedFor(candidates), attachUnconfirmedCvFacts(candidates)]);
  // Advisory soft-duplicate flags across the whole pool (same phone-tail / normalized name). A
  // "worth a look" marker for Talent Acquisition — nothing here merges anything by itself; the flag
  // is what the merge button in the pool reads, and a person presses it (candidate-merge.ts).
  const dupFlags = findDuplicateFlags(
    candidates.map((candidate) => ({ fullName: candidate.fullName, id: candidate.id, phoneNorm: normalizePhone(candidate.phone) })),
  );
  for (const candidate of candidates) {
    const flag = dupFlags.get(candidate.id);
    candidate.possibleDuplicate = flag ? { candidateId: flag.id, reason: flag.reason } : null;
  }
  const notACv = await loadNotACvCandidates(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    if (notACv.has(candidate.id)) candidate.notACv = true;
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

/**
 * Everyone a recruiter pushed STRAIGHT to this manager, newest send first.
 *
 * This is the other half of "send to manager" and the reason it was worth building. The push writes
 * manager_notified_hr_id on the candidate and creates NO application — so until this function
 * existed, the manager's alert arrived and there was no screen anywhere that could answer "which
 * CVs were sent to me?". Measured in production 2026-08-15: 7 applications ever, against 226
 * candidates. The manager-facing page read applications only, so a directly-pushed candidate was
 * invisible on it.
 *
 * The HR_ID goes through hrIdLookupKeys rather than a bare .eq, because the stored value is
 * whatever the dropdown carried and the caller's is whatever their session carries — PostgREST eq
 * is case-sensitive, and a filter matching nothing is indistinguishable from "nothing was sent to
 * you". That exact mistake made the manager dropdown empty earlier today.
 */
export async function listCandidatesSentToManager(managerHrId: string | null | undefined): Promise<Candidate[]> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0) return [];
  const supabase = recruitmentDb();

  // TWO SOURCES, UNIONED — and the union is the safety, not indecision.
  //
  //   • ats_candidate_manager_sends — one row per (candidate, manager). Since 2026-08-30 this is
  //     the real record: a CV can be sent to several managers and every one of them keeps it.
  //   • manager_notified_hr_id on the candidate — the old single-manager column, still written by
  //     every send (last one wins) and still the only record for anything sent before the table
  //     existed or during a window where the write to it was skipped.
  //
  // Reading only the new table would empty this page in the minutes between the code shipping and
  // the migration being applied, and reading only the old column is the bug being fixed. Reading
  // BOTH means a send shows up if EITHER recorded it, which is the only combination with no window
  // where a manager is shown an empty page that means the opposite of what it says.
  const sends = await listSendsForManager(managerHrId);

  const legacy = await supabase
    .from("ats_candidates")
    .select("*")
    .in("manager_notified_hr_id", keys)
    .order("manager_notified_at", { ascending: false });
  if (legacy.error) {
    // 42703 = the column does not exist, which is the pre-migration state and NOT a fault of this
    // caller: 20260815180000_candidate_manager_push adds it. Everything else is a real failure and
    // is thrown, because a manager silently shown an empty list is precisely the invisibility this
    // module has been fixing all day.
    if ((legacy.error as { code?: string }).code !== "42703") throw legacy.error;
  }

  const rowsById = new Map<string, CandidateDbRow>();
  for (const row of (legacy.data ?? []) as CandidateDbRow[]) rowsById.set(String(row.id), row);

  // Anything the fan-out knows about that the old column no longer points at — which is exactly the
  // set that used to be lost: every CV since re-sent to somebody else.
  const missingIds = (sends ?? []).map((send) => send.candidateId).filter((id) => !rowsById.has(id));
  for (const batch of chunkIds(missingIds)) {
    const extra = await supabase.from("ats_candidates").select("*").in("id", batch);
    if (extra.error) throw extra.error;
    for (const row of (extra.data ?? []) as CandidateDbRow[]) rowsById.set(String(row.id), row);
  }

  // Explicitly typed, and the entry is `as const`: without it the array literal widens to
  // (string | ManagerSend)[] and the Map constructor no longer accepts it.
  const sendsByCandidate = new Map<string, ManagerSend>(
    (sends ?? []).map((send) => [send.candidateId, send] as const),
  );
  const candidates: Candidate[] = [];
  for (const [id, row] of rowsById) {
    const candidate = mapCandidate(row);
    const send = sendsByCandidate.get(id);
    // THIS MANAGER'S OWN SEND, overlaid on top of the candidate's shared columns.
    //
    // Those columns hold whoever was sent it LAST. Rendering them here would show manager A the
    // date, the seat and — worse — the VACANCY that manager B was sent the CV for, filing it under
    // a folder A never chose. The per-send row is the only thing that is true for this reader.
    //
    // Only when a send row exists. Without one the candidate reached this list through the old
    // column, and that column IS this manager's send.
    if (send) {
      const stamp = managerSendStamp(send);
      candidate.managerNotified = stamp.managerNotified;
      candidate.sentFor = stamp.sentFor;
    }
    candidates.push(candidate);
  }

  // Newest send first — re-sorted here rather than trusted from either query, because the union can
  // interleave rows the two sources ordered separately.
  candidates.sort((left, right) =>
    (right.managerNotified?.sentAt ?? "").localeCompare(left.managerNotified?.sentAt ?? ""),
  );

  // The manager's own inbox needs the role more than any other screen — it is the whole question
  // they are answering. Without this the card read "No role stated on the application" for 540 of
  // the 555 rows, because `applied_for_job_title` is filled on 15 of them.
  //
  // The hedged CV facts come too, and for the same reason: a manager asked to say yes or no to a
  // stranger needs their years, their employer and where they live, and this list is far shorter
  // than the pool so the extra read is cheap.
  await Promise.all([attachAppliedFor(candidates), attachUnconfirmedCvFacts(candidates)]);
  return candidates;
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

/**
 * Records a candidate decision: the new status, optionally why, who decided, and when.
 *
 * The status is validated against the fixed vocabulary rather than accepted as typed. That is the
 * entire fix: this used to take any string a browser sent, which is how 225 of 226 candidates ended
 * up carrying the database default and the module lost the ability to say who had been looked at.
 *
 * The note is REFUSED when it is too long rather than trimmed — the owner's standing rule is that
 * text is never truncated, and silently storing half a reason is worse than asking for a shorter one.
 */
export async function updateCandidateStatus(
  access: AccessContext,
  id: string,
  status: string,
  note?: string | null,
): Promise<Candidate> {
  const next = normalizeCandidateStatus(status);
  if (!next) {
    throw new Error(`"${String(status ?? "").trim()}" is not a candidate status.`);
  }
  const cleanNote = textOrNull(note);
  if (cleanNote && cleanNote.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
    throw new Error(`Keep the note under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters.`);
  }

  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");

  const actorHrId = access.hrId ?? null;
  const changedAt = new Date().toISOString();
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      status: next,
      status_changed_at: changedAt,
      status_changed_by_hr_id: actorHrId,
      // An omitted note CLEARS the previous one. The note describes the status it was written for,
      // so carrying a July rejection reason forward onto an August shortlist would be a lie — and
      // the reason itself is not lost, it is on the event row below.
      status_note: cleanNote,
      updated_at: changedAt,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  await recordCandidateStatusEvent({
    actorHrId,
    candidateId: id,
    fromStatus: existing.status,
    note: cleanNote,
    toStatus: next,
  });

  return mapCandidate(data as CandidateDbRow);
}

/**
 * Put a CV on the shelf — "good, but not needed now".
 *
 * THE STATUS IS DELIBERATELY NOT TOUCHED. Filing answers a question about the queue, not about the
 * person, so a shortlisted candidate parked until a seat opens comes back out still shortlisted.
 * The whole design rests on that; see candidate-folder.ts.
 *
 * The refusal is asked through `candidateFolderRefusal` rather than restated here, so the button's
 * tooltip, this service and the route's 400 all say the same sentence instead of three wordings that
 * drift apart the first time the rule changes.
 */
export async function fileCandidateToFolder(
  access: AccessContext,
  id: string,
  kind: string,
  key: string,
): Promise<Candidate> {
  if (!isCandidateFolderKind(kind)) {
    throw new Error(`"${String(kind ?? "").trim()}" is not a folder kind.`);
  }
  const cleanKey = cleanFolderKey(key);
  if (!cleanKey) throw new Error("A folder needs a name.");

  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");
  const refusal = candidateFolderRefusal(existing);
  if (refusal) throw new Error(refusal);

  const filedAt = new Date().toISOString();
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      folder_filed_at: filedAt,
      folder_filed_by_hr_id: access.hrId ?? null,
      // `kind` is already narrowed to CandidateFolderKind by the guard above — no cast needed.
      folder_kind: kind,
      folder_key: cleanKey,
      updated_at: filedAt,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapCandidate(data as CandidateDbRow);
}

/**
 * Take a CV back off the shelf and return it to the live pool.
 *
 * All four columns are cleared TOGETHER — the table's `ats_candidates_folder_complete` constraint
 * refuses any half-cleared shape, which is the point: a row left carrying a kind with no timestamp
 * would read as unfiled to `mapCandidate` and as filed to a hand-written query, and a CV that two
 * screens disagree about is exactly how one gets lost.
 *
 * Returning an already-unfiled candidate is a no-op that succeeds rather than an error. The button
 * is one click on a screen two people can have open, and the honest answer to "put it back" when it
 * is already back is yes, not a failure the second person has to interpret.
 */
export async function returnCandidateToPool(id: string): Promise<Candidate> {
  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");
  if (!existing.folder) return existing;

  const clearedAt = new Date().toISOString();
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      folder_filed_at: null,
      folder_filed_by_hr_id: null,
      folder_kind: null,
      folder_key: null,
      updated_at: clearedAt,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapCandidate(data as CandidateDbRow);
}

/**
 * Appends one line to the candidate's decision history.
 *
 * Best effort ON PURPOSE, and the ordering matters: the candidate row is updated first, and a
 * failure here is logged rather than thrown. The decision has already happened by this point, so
 * throwing would report a successful status change back to Talent Acquisition as an error and
 * invite them to click it again. A missing history line is a gap; a status the screen says failed
 * but which actually applied is a lie.
 */
async function recordCandidateStatusEvent(input: {
  actorHrId: string | null;
  candidateId: string;
  fromStatus: string | null;
  note: string | null;
  toStatus: CandidateStatus;
}): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_candidate_status_events").insert({
    actor_hr_id: input.actorHrId,
    candidate_id: input.candidateId,
    from_status: input.fromStatus,
    note: input.note,
    to_status: input.toStatus,
  });
  if (error) {
    logError("Candidate status changed but the history line could not be written", {
      error,
      labels: {
        candidate_id: input.candidateId,
        event: "candidate_status_event_write_failed",
        to_status: input.toStatus,
      },
    });
  }
}

/** A candidate's decision history, newest first. Empty for anyone decided before 2026-08-15. */
export async function listCandidateStatusEvents(candidateId: string): Promise<CandidateStatusEvent[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidate_status_events")
    .select("*")
    .eq("candidate_id", candidateId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as CandidateStatusEventDbRow[]).map(mapCandidateStatusEvent);
}

// Partial edit of a candidate's own fields (not status — see updateCandidateStatus).
// An omitted key leaves that column untouched; an explicit `null` clears it. The
// identity-match columns (national_id_norm/email_norm/phone_norm) are only recomputed
// for whichever of nationalId/email/phone is actually present in this call, so editing
// one identity field never wipes the norm of an untouched one.
// `existing` is the candidate as currently stored; it is needed only for the repeating blocks in
// position_specific_fields, which merge over what is there rather than replacing it.
function updateCandidatePayload(input: UpdateCandidateInput, existing: Candidate): Record<string, unknown> {
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
  if (input.whatsapp !== undefined) payload.whatsapp = textOrNull(input.whatsapp);
  if (input.linkedinUrl !== undefined) payload.linkedin_url = textOrNull(input.linkedinUrl);
  if (input.nationality !== undefined) payload.nationality = textOrNull(input.nationality);
  if (input.dateOfBirth !== undefined) payload.date_of_birth = textOrNull(input.dateOfBirth);
  if (input.placeOfBirth !== undefined) payload.place_of_birth = textOrNull(input.placeOfBirth);
  if (input.gender !== undefined) payload.gender = textOrNull(input.gender);
  if (input.maritalStatus !== undefined) payload.marital_status = textOrNull(input.maritalStatus);
  if (input.militaryStatus !== undefined) payload.military_status = textOrNull(input.militaryStatus);
  if (input.address !== undefined) payload.address = textOrNull(input.address);
  if (input.governorate !== undefined) payload.governorate = textOrNull(input.governorate);
  if (input.currentJobTitle !== undefined) payload.current_job_title = textOrNull(input.currentJobTitle);
  if (input.appliedForJobTitle !== undefined) payload.applied_for_job_title = textOrNull(input.appliedForJobTitle);
  if (input.appliedForEvidence !== undefined) payload.applied_for_evidence = textOrNull(input.appliedForEvidence);
  if (input.professionalSummary !== undefined) payload.professional_summary = textOrNull(input.professionalSummary);
  if (input.currentEmployer !== undefined) payload.current_employer = textOrNull(input.currentEmployer);
  if (input.currentRoleResponsibilities !== undefined) {
    payload.current_role_responsibilities = textOrNull(input.currentRoleResponsibilities);
  }
  if (input.yearsExperience !== undefined) payload.years_experience = numberOrNull(input.yearsExperience);
  if (input.expectedSalary !== undefined) payload.expected_salary = numberOrNull(input.expectedSalary);
  if (input.noticePeriod !== undefined) payload.notice_period = textOrNull(input.noticePeriod);
  if (input.source !== undefined) payload.source = textOrNull(input.source);
  if (input.cvReferenceName !== undefined) payload.cv_reference_name = textOrNull(input.cvReferenceName);
  if (input.cvExternalUrl !== undefined) payload.cv_external_url = textOrNull(input.cvExternalUrl);
  if (input.notes !== undefined) payload.notes = textOrNull(input.notes);
  if (input.faculty !== undefined) payload.faculty = textOrNull(input.faculty);
  if (input.university !== undefined) payload.university = textOrNull(input.university);
  if (input.degree !== undefined) payload.degree = textOrNull(input.degree);
  if (input.graduationYear !== undefined) payload.graduation_year = numberOrNull(input.graduationYear);
  if (input.grade !== undefined) payload.grade = textOrNull(input.grade);
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
    // Merge the submitted blocks over the stored ones — see applyPositionSpecificFields. An
    // explicit `null` still means "clear the whole column", consistent with every other key here;
    // only an object is treated as a partial submission.
    payload.position_specific_fields =
      input.positionSpecificFields === null
        ? {}
        : applyPositionSpecificFields(universalCvSchema, existing.positionSpecificFields, input.positionSpecificFields);
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
    .update(updateCandidatePayload(input, existing))
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

// Hard-delete a candidate (admin cleanup). Measured against production 2026-08-21: four foreign
// keys reference ats_candidates, and they do NOT all cascade.
//   - ats_applications             CASCADE - and with it ats_application_events, ats_interviews,
//                                  and any ats_files hanging off the application
//   - ats_files                    CASCADE - the candidate-level CVs
//   - ats_candidate_cv_extractions CASCADE
//   - ats_cv_intake_events         SET NULL - the intake row SURVIVES with a null candidate_id,
//                                  so ats_candidate_source_context (a VIEW over that table, not
//                                  a table) keeps showing a detached row
// ats_candidate_status_events carries no foreign key at all, so the decision history is left
// untouched on purpose: an audit row that died with the record it describes could not testify
// about the deletion. Do not "fix" that with ON DELETE CASCADE - the table is append-only,
// enforced by a BEFORE UPDATE OR DELETE trigger, so the cascade would raise 23001 and this
// delete would fail outright. See 20260815210000_candidate_status_vocabulary.sql.
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

/**
 * Send a candidate to a manager directly — no requisition, no application, no job title.
 *
 * The manager is validated against listHiringManagerOptions rather than trusted from the request:
 * the route accepts an HR_ID from the browser, and without this check any employee could be made a
 * notification target by editing the posted value. Matching also means the caller gets a clear
 * refusal ("not a manager") instead of a notification quietly addressed to nobody.
 */
export async function sendCandidateToManager(
  access: AccessContext,
  candidateId: string,
  managerHrId: string,
  position?: SentForPositionInput | null,
): Promise<{ candidateName: string; managerHrId: string; managerName: string; sentAt: string }> {
  const sent = await sendCandidatesToManager(access, [candidateId], managerHrId, position);
  return { ...sent, candidateName: sent.candidateNames[0] ?? "" };
}

/**
 * The position as it arrives from a form — an id to look up, or words somebody typed.
 *
 * Deliberately NOT SentForPosition. What a route receives is a request, not a fact: the id may name
 * a vacancy that has since been filled, and the text may say anything at all. It becomes a
 * SentForPosition only after resolveSentForPosition has read the vacancy back or cleaned the words.
 */
export type SentForPositionInput = {
  vacancyId?: number | string | null;
  jobTitle?: string | null;
  areaName?: string | null;
  lineName?: string | null;
};

/**
 * Send SEVERAL candidates to one manager as a single message.
 *
 * The manager receives one notification naming everybody in it rather than one alert per person —
 * see pushCandidatesToManager for why that matters at 152 CVs a week. Everything else is identical
 * to the single-candidate path, which now delegates here so the two can never drift.
 */
export async function sendCandidatesToManager(
  access: AccessContext,
  candidateIds: string[],
  managerHrId: string,
  position?: SentForPositionInput | null,
): Promise<{ candidateNames: string[]; count: number; managerHrId: string; managerName: string; sentAt: string }> {
  const ids = Array.from(new Set(candidateIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) throw new Error("Choose at least one candidate to send.");

  const candidates = await getCandidatesByIds(ids);
  if (candidates.length === 0) throw new Error("Candidate not found.");
  // A partially-resolvable selection is refused rather than quietly sent for whoever survived: the
  // recruiter picked a set of people, and a manager receiving four of the five they were promised
  // with no indication which is missing is worse than being told to try again.
  if (candidates.length !== ids.length) {
    throw new Error("Some of those candidates no longer exist. Reload the page and try again.");
  }

  const manager = (await listHiringManagerOptions()).find((option) => hrIdsMatch(option.hrId, managerHrId));
  if (!manager) throw new Error("That person is not a manager who can be sent candidates.");

  // Resolved BEFORE the notification goes out, not after. If the picked vacancy has been filled
  // since the page loaded, this throws — and it must throw while the only cost is an error message,
  // not once a manager has already been alerted about a position that no longer exists.
  const sentForPosition = position ? await resolveSentForPosition(position) : null;

  const sent = await pushCandidatesToManager({
    actorHrId: access.hrId ?? null,
    candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.fullName })),
    managerHrId: manager.hrId,
    position: sentForPosition,
  });

  // Sending IS a decision, so it moves each candidate out of "nobody has looked at this yet" —
  // which is what the landing screen counts. Deliberately AFTER the push, never before: a status
  // claiming someone was sent to a manager who was never actually told is precisely the quiet lie
  // this module used to produce when the notification failed silently.
  //
  // `hired` is the one status a send does not overwrite. Sending a hired candidate's CV on to
  // another manager is a reference request, not a re-entry into the pipeline, and it must not take
  // the person back out of the hired count.
  // The note names the position as well as the person when there is one, because "Sent to Ahmed
  // Mohamed Nagy" is ambiguous where one manager holds five open seats — which is the ordinary case
  // here, not the edge one.
  const positionLabel = sentForPosition ? positionFolderLabel(sentForPosition) : "";
  const note = positionLabel ? `Sent to ${manager.name} for ${positionLabel}.` : `Sent to ${manager.name}.`;
  for (const candidate of candidates) {
    if (normalizeCandidateStatus(candidate.status) === "hired") continue;
    await updateCandidateStatus(access, candidate.id, "sent_to_manager", note);
  }

  return { ...sent, candidateNames: candidates.map((candidate) => candidate.fullName) };
}

/** Loads a specific set of candidates, batched because the id list comes from a multi-select. */
async function getCandidatesByIds(ids: string[]): Promise<Candidate[]> {
  const supabase = recruitmentDb();
  const rows: CandidateDbRow[] = [];
  for (const batch of chunkIds(ids)) {
    const { data, error } = await supabase.from("ats_candidates").select("*").in("id", batch);
    if (error) throw error;
    rows.push(...((data ?? []) as CandidateDbRow[]));
  }
  return rows.map(mapCandidate);
}
