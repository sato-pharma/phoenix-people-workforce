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
  backgroundFolderFilingRefusal,
  isBackgroundConfirmationOutcome,
} from "@/lib/recruitment/background-review";
import {
  candidateFolderRefusal,
  DUPLICATE_FOLDER_KEY,
  DUPLICATE_FOLDER_KIND,
  isStorableFolderKind,
  cleanFolderKey,
  PARAMEDICAL_FOLDER_KEY,
  resolveCandidateRegionFolderCode,
  resolveCanonicalMedicalRepArea,
} from "@/lib/recruitment/candidate-folder";
import { listCanonicalMedicalRepAreaNames } from "@/lib/recruitment/candidate-folder-options";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";
import {
  candidateManagerSeatTier,
  managerMayBeSentApplication,
} from "@/lib/recruitment/candidate-seat-rank";
import { describeCandidateSource, type SourceContextRow } from "@/lib/recruitment/candidate-source-context";
import type { CandidateUnconfirmedCvFacts } from "@/lib/recruitment/candidate-screening-facts";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { readAllFolderItemsOnce } from "@/lib/recruitment/cv-folder-tree-db";
import { managerHoldsFolders } from "@/lib/recruitment/folder-holders";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { fetchAllRows, fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { managerHoldCutoffIso } from "@/lib/recruitment/manager-hold-window";
import { notACvCandidateIds, type ExtractionVerdictRow } from "@/lib/recruitment/pool-enrichment";
import {
  isAfter,
  listLatestSendByCandidate,
  listSendsForManager,
  managerSendStamp,
  type ManagerSend,
} from "@/lib/recruitment/manager-sends";
import { candidateRatings, parseCandidateRating } from "@/lib/recruitment/candidate-rating";
import { hrIdForStorage, hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { ROW_FINDING_KEYS } from "@/lib/recruitment/cv-findings";
import { isBatchActor } from "@/lib/recruitment/batch-actor";
import type {
  ExtractedCandidateFields,
  ExtractedCvValue,
} from "@/lib/recruitment/cv-extraction-fields";
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
  type CandidateMatchReason,
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
import { readCandidateStoragePaths, removeCandidateStorageObjects } from "@/lib/recruitment/candidate-storage-cleanup";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import { loadManagerShelves } from "@/lib/recruitment/district-manager-folders-db";
import { chooseFolderForPush, OTHER_CVS_FOLDER_LABEL } from "@/lib/recruitment/manager-cv-folders";
import { resolveSentForPosition } from "@/lib/recruitment/vacancy-options";
import {
  BULK_DECISION_MAX,
  CANDIDATE_STATUS_NOTE_MAX_LENGTH,
  bulkDecisionRefusal,
  normalizeCandidateStatus,
  statusChangeRefusal,
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
  matchReason?: CandidateMatchReason;
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

/** PostgREST serves at most this many rows for one request, so a whole-table read must page. */
const CANDIDATE_PAGE_SIZE = 1000;

/** A runaway guard, not a data cap: 100 pages is 100,000 candidates. */
const CANDIDATE_PAGE_LIMIT = 100;

/**
 * Every row a whole-table candidate read matches, fetched a page at a time.
 *
 * WHY THIS EXISTS. An unbounded `.select()` is capped by PostgREST at 1000 rows and says nothing
 * about it — no error, no truncation marker, just a short array that looks exactly like a small
 * table. Three reads in this file were whole-table: the pool the recruitment screen renders, the
 * search endpoint behind it, and the dedupe key index. The pool passed 700 rows on 2026-09-03 and
 * takes roughly 90 CVs a day, so all three were days away from quietly serving a truncated answer.
 *
 * What that would have looked like is why the paging is worth its cost. The owner would have
 * watched his newest CVs stop appearing on the pool with nothing on screen to explain it — the same
 * complaint he had already raised once about CVs he could not find. And `loadMatchKeys` would have
 * stopped seeing the older half of the pool, so every repeat applicant past the cap would have been
 * filed as a brand new person instead of matching the record already sitting there.
 *
 * Stops on the first SHORT page rather than at a row count. A full page can still be the last one,
 * so at an exact multiple of the page size this costs one extra empty request — the price of never
 * guessing where the data ends. Past the guard it THROWS rather than returning what it has, because
 * a silently truncated candidate pool is the precise failure this function exists to remove.
 *
 * The `any` on the builder matches `fetchAll` in src/lib/activity/service.ts, which pages the same
 * way for the same reason: the Supabase filter builder's type changes shape with every chained
 * call, so naming it here would pin one chain and refuse the others.
 */
async function selectEveryCandidateRow(
  build: (table: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<CandidateDbRow[]> {
  const supabase = recruitmentDb();
  const rows: CandidateDbRow[] = [];
  for (let page = 0; page < CANDIDATE_PAGE_LIMIT; page += 1) {
    const from = page * CANDIDATE_PAGE_SIZE;
    // `id` goes last as the unique tiebreak: the callers order by `created_at` (or not at all), and an
    // offset walk over ties or no order can repeat one page's rows and skip another's with no error.
    const { data, error } = await build(supabase.from("ats_candidates"))
      .order("id", { ascending: true })
      .range(from, from + CANDIDATE_PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as CandidateDbRow[];
    rows.push(...batch);
    if (batch.length < CANDIDATE_PAGE_SIZE) return rows;
  }
  throw new Error(
    `Candidate paging stopped at ${CANDIDATE_PAGE_LIMIT * CANDIDATE_PAGE_SIZE} rows. Refusing to return a truncated pool.`,
  );
}

async function loadMatchKeys(): Promise<MatchableCandidate[]> {
  const rows = await selectEveryCandidateRow((table) =>
    table.select("id,national_id_norm,email_norm,phone_norm"),
  );
  return rows.map((row) => ({
    id: String(row.id),
    nationalIdNorm: textOrNull(row.national_id_norm),
    emailNorm: textOrNull(row.email_norm),
    phoneNorm: textOrNull(row.phone_norm),
  }));
}

/**
 * Candidates already carrying this canonical phone key, by name — ADVISORY ONLY.
 *
 * Callers pass a key from `normalizePhone`, which is the same function `candidatePayload` and
 * `updateCandidate` write into `phone_norm`, so 01017210988, +201017210988 and 201017210988 all ask
 * the same question here. Verified on production 2026-09-27: of 1,220 candidates holding a phone,
 * zero have a `phone_norm` that disagrees with the normalizer, so exact equality on the column IS
 * the format-proof comparison — no LIKE, no tail match, and no second normalizer written in SQL.
 *
 * A TARGETED read on purpose. The advisory duplicate flag on the pool scans every row because it
 * indexes the whole pool at once; a single arrival needs one number, and this runs on every
 * interview booking.
 *
 * NOT an identity lookup, and it must never become one: phone stopped deciding a match on
 * 2026-08-30 after it merged three different applicants into one record (candidate-matching.ts).
 * Five of the twelve candidate pairs sharing a number on production today are unrelated people
 * whose CVs were forwarded from one handset. This answers "somebody should look", never "these are
 * the same person".
 */
export async function findCandidatesByPhoneNorm(
  phoneNorm: string,
  excludeCandidateId?: string | null,
): Promise<Array<{ id: string; fullName: string }>> {
  const key = String(phoneNorm ?? "").trim();
  if (!key) return [];
  const supabase = recruitmentDb();
  let query = supabase.from("ats_candidates").select("id,full_name").eq("phone_norm", key);
  if (excludeCandidateId) query = query.neq("id", excludeCandidateId);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as Array<{ id?: unknown; full_name?: unknown }>).map((row) => ({
    id: String(row.id),
    fullName: textOrNull(row.full_name) ?? "",
  }));
}

/**
 * How many batches of one whole-pool enrichment read are in flight at once.
 *
 * The batches are independent, so running them one after another only stacked round trips: the
 * pool is ~14 batches of 100, each a full trip to Frankfurt. Four at a time, and every loader below
 * still folds its batches in INDEX order, so "first row seen wins" and "later batch overwrites"
 * come out exactly as they did when the loop was sequential.
 */
const ENRICHMENT_BATCH_CONCURRENCY = 4;

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
  const batches = await mapWithConcurrency(chunkIds(ids), ENRICHMENT_BATCH_CONCURRENCY, async (batch) => {
    const { data, error } = await supabase
      .from("ats_candidate_source_context")
      .select("candidate_id,channel,subject,raw_metadata")
      .in("candidate_id", batch);
    return error || !data ? [] : (data as SourceContextRow[]);
  });
  const rows: SourceContextRow[] = batches.flat();
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
  // Fetched four batches at a time, folded in batch order (ENRICHMENT_BATCH_CONCURRENCY).
  const pages = await mapWithConcurrency(chunkIds(ids), ENRICHMENT_BATCH_CONCURRENCY, async (batch) => {
    // Each batch paged to a short page by the unique `id`, so a re-read CV's newest extraction can never
    // be the row a response cap dropped. A failed batch still drops only its own enrichment.
    try {
      return await fetchAllRows<{ candidate_id?: unknown; extracted_fields?: unknown }>(
        () =>
          supabase
            .from("ats_candidate_cv_extractions")
            .select("candidate_id,created_at,extracted_fields")
            .in("candidate_id", batch)
            .order("created_at", { ascending: false }),
        "id",
      );
    } catch {
      return [];
    }
  });
  for (const data of pages) {
    for (const row of data) {
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
  // Fetched four batches at a time, folded in batch order (ENRICHMENT_BATCH_CONCURRENCY).
  const pages = await mapWithConcurrency(chunkIds(ids), ENRICHMENT_BATCH_CONCURRENCY, async (batch) => {
    // Paged like the job-title loader above, and failing the same way: a failed batch drops only its own cells.
    try {
      return await fetchAllRows<UnconfirmedCvFactRow>(
        () =>
          supabase
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
            .order("created_at", { ascending: false }),
        "id",
      );
    } catch {
      return [];
    }
  });
  for (const data of pages) {
    for (const row of data) {
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
 * Puts the FILER'S NAME on every shelved CV, in place.
 *
 * WHY THIS EXISTS. The shelf row read "filed 03 Sept 2026, 10:33 by B-10" — a raw HR id where the
 * owner's standing rule is a human-readable name. `folder_filed_by_hr_id` is the only thing the
 * candidate row holds about who filed it, and the name lives in `employees`, so the shelf could not
 * have named anybody without this read.
 *
 * THE DISTINCT SET IS WHAT GOES TO THE DATABASE, not the rows, and that is this function's own job
 * rather than the lookup's: measured on production 2026-09-11, all 323 filed CVs carry the same
 * filer (B-10, the owner), so a pool-sized `.in()` of 323 identical ids would be a self-inflicted
 * version of the length limit that makes PostgREST return zero rows with no error.
 *
 * The mixed-case trap, the chunking and the nickname-aware name all belong to `namesByHrId` —
 * `src/lib/employees/names-by-hr-id.ts` — which is where the shelf, the vacancy stand-ins and the
 * production planner's grant list stopped keeping three copies of this read.
 *
 * A FAILED LOOKUP COSTS THE NAME AND NOTHING ELSE. `filedByName` stays null, the shelf says so in
 * words (never the id), and every other thing on the row still renders.
 */
async function attachFolderFilerNames(candidates: Candidate[]): Promise<void> {
  const filed = candidates.filter((candidate) => candidate.folder?.filedByHrId);
  if (filed.length === 0) return;

  const names = await namesByHrId(
    new Set(filed.map((candidate) => candidate.folder?.filedByHrId).filter((hrId): hrId is string => Boolean(hrId))),
  );
  if (names.size === 0) return;

  for (const candidate of filed) {
    if (!candidate.folder) continue;
    const name = names.get(candidate.folder.filedByHrId);
    if (name) candidate.folder.filedByName = name;
  }
}

/**
 * Fill in which hand-built folders each CV sits in — the second way to be off the pool.
 *
 * THE WHOLE TABLE, not one query per candidate and not an `.in()` over the pool's ids. The membership
 * table holds one short row per filing and the pool is read in full by every caller of
 * `listCandidates` anyway, so the whole table is both smaller than the id list would be in a URL and
 * immune to the `.in()` header limit entirely.
 *
 * PAGED, because an unbounded PostgREST select stops at 1,000 rows with no marker. Past that the
 * 1,001st filing would silently not exist here, and its CV would reappear in the main pool while
 * still sitting in its folder — a person counted twice, found by nobody (audit, 2026-09-12).
 *
 * BEST-EFFORT, and the failure direction is the one that matters: if this read fails, every
 * `cvFolderIds` stays empty, so every CV stays VISIBLE in the pool. The opposite failure — hiding
 * people because a query hiccuped — is how somebody is lost. Same reasoning as the loaders above,
 * and as `loadCvFolderCabinet`'s own missing-table fallback, which covers the window between this
 * code deploying and the migration being applied.
 *
 * ONE READ PER RENDER, SHARED WITH THE FOLDER TREE. The recruitment hub loads the cabinet and the
 * pool in the same render, and both used to page the whole table on their own. They now share
 * `readAllFolderItemsOnce` — the cabinet's paged reader (ordered, with `id` breaking ties), which
 * returns NO rows at all on any failed page, so the fail-open direction above is unchanged.
 */
async function attachCvFolderMemberships(candidates: Candidate[]): Promise<void> {
  if (candidates.length === 0) return;
  const { data, error } = await readAllFolderItemsOnce();
  // A failure part-way leaves every CV visible, never a half-read set that hides some of them.
  if (error) return;
  // Re-sorted into `id` order — the order this read used to page in — so each CV's folder list
  // reads in the same order it always did. A copy: the rows are shared with the folder tree.
  const rows = [...data].sort((left, right) => compareFilingIds(left.id, right.id));

  const byCandidate = new Map<string, string[]>();
  for (const row of rows) {
    const candidateId = String(row.candidate_id ?? "");
    const folderId = String(row.folder_id ?? "");
    if (!candidateId || !folderId) continue;
    const bucket = byCandidate.get(candidateId) ?? [];
    bucket.push(folderId);
    byCandidate.set(candidateId, bucket);
  }

  for (const candidate of candidates) {
    candidate.cvFolderIds = byCandidate.get(candidate.id) ?? [];
  }
}

/** Ascending filing id. The column is a bigint identity, so it compares as a number, as SQL orders it. */
function compareFilingIds(left: unknown, right: unknown): number {
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return String(left ?? "").localeCompare(String(right ?? ""));
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
  // Fetched four batches at a time, folded in batch order (ENRICHMENT_BATCH_CONCURRENCY).
  const pages = await mapWithConcurrency(chunkIds(ids), ENRICHMENT_BATCH_CONCURRENCY, async (batch) => {
    // Each batch paged to a short page by the unique `id`; a failed batch drops only its own enrichment.
    try {
      return await fetchAllRows<{ candidate_id?: unknown; ats_requisitions?: unknown }>(
        () =>
          supabase
            .from("ats_applications")
            .select("candidate_id,created_at,ats_requisitions(job_title)")
            .in("candidate_id", batch)
            .order("created_at", { ascending: false }),
        "id",
      );
    } catch {
      return [];
    }
  });
  for (const data of pages) {
    for (const row of data) {
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
 *
 * Exported for the candidate's own page (candidate-record.ts), so its "Applying for" gives the same
 * answer as the pool row the name was pressed on.
 */
export async function attachAppliedFor(
  candidates: Candidate[],
  options: {
    /**
     * The intake context the caller already started reading. `listCandidates` passes the whole-view
     * walk it began before the pool arrived; every other caller holds a handful of candidates and
     * leaves this out, so their ids are looked up in batches as before.
     */
    sourceContext?: Promise<Map<string, CandidateSourceContext>>;
  } = {},
): Promise<void> {
  if (candidates.length === 0) return;
  const sourceContext = await (options.sourceContext ??
    loadSourceContextByCandidate(candidates.map((candidate) => candidate.id)));
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
async function loadNotACvCandidates(): Promise<Set<string>> {
  // THE WHOLE TABLE, in id order, rather than the pool's ids a hundred at a time. Three narrow columns
  // are ~110 bytes a row (3,503 rows on 2026-10-16), so the table is four requests where the pool's ids
  // were fifteen, and it needs no answer from the pool read — it starts BEFORE it (see listCandidates).
  // No `extracted_fields` is selected, so nothing large is read from the TOAST. The newest-row-per-
  // candidate rule is `notACvCandidateIds`'s, a pure function with its own test.
  //
  // Best-effort, exactly as the batched read was: a failure leaves the set empty, so no row is flagged,
  // which is the direction that hides nobody.
  try {
    const rows = await fetchAllRowsKeyset<ExtractionVerdictRow>(
      () => recruitmentDb().from("ats_candidate_cv_extractions").select("id,candidate_id,created_at,is_cv"),
      { cursorColumn: "id", cursorOf: (row) => textOrNull(row.id) },
    );
    return notACvCandidateIds(rows);
  } catch {
    return new Set<string>();
  }
}

/**
 * The latest intake context of EVERY candidate, in one walk of the view.
 *
 * `ats_candidate_source_context` is one row per candidate (the newest intake event), 1,412 rows on
 * 2026-10-16 and 4 ms to read whole — against fifteen `.in()` requests for the pool's ids, each of which
 * asked the database to find its hundred. It needs nothing from the pool read, so `listCandidates`
 * starts it first and the two run side by side. Keyset on `candidate_id` (unique in the view), so a
 * CV arriving mid-read can neither repeat nor skip a row.
 *
 * Best-effort like the batched loader beside it: a failure returns an empty map and the Source column
 * simply shows nothing, rather than breaking the pool.
 */
async function loadSourceContextForWholePool(): Promise<Map<string, CandidateSourceContext>> {
  const map = new Map<string, CandidateSourceContext>();
  try {
    const rows = await fetchAllRowsKeyset<SourceContextRow>(
      () =>
        recruitmentDb().from("ats_candidate_source_context").select("candidate_id,channel,subject,raw_metadata"),
      {
        cursorColumn: "candidate_id",
        cursorOf: (row) => textOrNull((row as { candidate_id?: unknown }).candidate_id),
      },
    );
    for (const row of rows) {
      const candidateId = textOrNull((row as { candidate_id?: unknown }).candidate_id);
      if (!candidateId) continue;
      map.set(candidateId, describeCandidateSource(row));
    }
  } catch {
    map.clear();
  }
  return map;
}

/**
 * Every column `mapCandidate` reads EXCEPT `position_specific_fields`.
 *
 * WHY IT IS WORTH SPELLING OUT 71 COLUMNS. `position_specific_fields` is the repeating CV blocks —
 * work history, education history, certifications, skills, languages — and measured on production
 * 2026-09-05 it is 1,221 kB of the 2,053 kB that a whole-pool `select("*")` moves: 59.4% of the
 * bytes, for 744 candidates, on every single load.
 *
 * The screening queue reads NONE of it. Its whole derive chain — candidate-screening-facts,
 * applied-for, screening-order, role-fit, red-flag — has zero references to the field, and the
 * three enrichments this function runs afterwards have zero as well. The workstation already knew
 * this column was the expensive one and stopped shipping it to the BROWSER; this is the same fix
 * applied one hop earlier, to the read that crosses from Frankfurt to Amsterdam.
 *
 * KEPT IN STEP BY A TEST, NOT BY CARE. `tests/recruitment-screening-page.test.ts` re-derives this
 * list from mapCandidate's own source and fails if the two drift, because the failure mode is
 * silent: a column added by a later migration and mapped here but missing from this list does not
 * error — mapCandidate simply reads `undefined` and maps it to null, and the field is quietly blank
 * on every screen fed by the slim read.
 */
export const CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS =
  "address,applied_for_evidence,applied_for_job_title,background_confirmed_at,background_confirmed_by_hr_id," +
  "background_confirmed_outcome,created_at,created_by,current_employer,current_job_title," +
  "current_role_responsibilities,cv_external_url,cv_reference_name,date_of_birth,declared_background," +
  "declared_expected_salary,declared_experience,degree,email,expected_salary,faculty,folder_filed_at," +
  "folder_filed_by_hr_id,folder_key,folder_kind,full_name,gender,governorate,grade,graduation_year," +
  "has_medical_rep_experience,has_prior_work_experience,id,linkedin_url,manager_notified_area," +
  "manager_notified_at,manager_notified_hr_id,manager_notified_job_title,manager_notified_name," +
  "manager_notified_region,marital_status,medical_rep_employer,medical_rep_experience_from," +
  "medical_rep_experience_to,military_status,national_id,nationality,notes,notice_period,offer_id,phone," +
  "place_of_birth,preferences_declared_at,preferred_area_name,preferred_region_code," +
  "preferred_region_name,professional_summary,rated_at,rated_by_hr_id,rating,screening_extra_answers," +
  "sent_for_area,sent_for_job_title," +
  "sent_for_line,sent_for_region,sent_for_vacancy_id,source,status,status_changed_at," +
  "status_changed_by_hr_id,status_note,university,updated_at,whatsapp,years_experience";

/**
 * The whole live candidate pool.
 *
 * `withRepeatingCvBlocks: false` drops `position_specific_fields` from the read — 59% of the bytes,
 * and unread by every list-shaped caller. Candidates come back with `positionSpecificFields` as an
 * EMPTY OBJECT on that path, indistinguishable from a candidate who genuinely has none, so it is
 * opt-in and the default is unchanged: a caller that renders those blocks must not pass it.
 */
export async function listCandidates(
  options: { withRepeatingCvBlocks?: boolean } = {},
): Promise<Candidate[]> {
  const columns =
    options.withRepeatingCvBlocks === false ? CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS : "*";
  // The two side tables whose answer does not depend on the pool's ids are read WHOLE, and they start
  // here, beside the pool, instead of after it: a request waiting for the pool's rows to learn which
  // ids to ask for was a whole extra wait at the front of the longest chain on the page. Neither
  // promise can reject (both catch inside), so one left unawaited by a failed pool read is harmless.
  const sourceContextLoad = loadSourceContextForWholePool();
  const notACvLoad = loadNotACvCandidates();
  const rows = await selectEveryCandidateRow((table) =>
    table.select(columns).order("created_at", { ascending: false }),
  );
  const candidates = rows.map(mapCandidate);
  // Concurrently: the reads touch different fields on the same objects and none reads another's
  // output, so serialising them would only add Atlantic round trips to a page that already waits on one.
  const [, , , , latestSends, notACv] = await Promise.all([
    attachAppliedFor(candidates, { sourceContext: sourceContextLoad }),
    attachUnconfirmedCvFacts(candidates),
    attachFolderFilerNames(candidates),
    // The hand-built folder tree's memberships. In the same wave for the same reason as its three
    // neighbours: it touches a different field on the same objects and reads none of their output,
    // so serialising it would only add an Atlantic round trip to a page that already waits on one.
    attachCvFolderMemberships(candidates),
    listLatestSendByCandidate(),
    // The "Not a CV" verdicts: the whole-table walk started above, awaited here. Applied at the end,
    // where they always were.
    notACvLoad,
  ]);

  // ── WHO HAS THIS CV, RESOLVED ONCE FOR EVERY SCREEN ─────────────────────────────────────────────
  //
  // `manager_notified_*` on the candidate row is the pre-2026-08-30 single-manager record: it holds
  // whoever was sent the CV LAST and the next send overwrites it. `ats_candidate_manager_sends` is
  // the fan-out that replaced it. Reading either ALONE has a window where it is wrong, and
  // production has carried rows where they disagreed outright — a CV sent to Saad Salama on 31 Aug
  // 2026 with both candidate columns NULL, and one re-sent to Dr Anwar Gaweesh on 1 Sep whose row
  // still named the earlier manager.
  //
  // IT LIVES HERE, not in one page's loader, and that is the point. The screening queue got this
  // overlay on 2026-09-05 and the candidate pool did not, so the two screens answered "was this
  // sent, and to whom" from different sources — the same pool, two truths, and nothing on either
  // screen to say which was right. Every caller of this function reads the whole pool for a person
  // to look at, so every one of them wants the same answer.
  //
  // THE POSITION MOVES ONLY WHEN THE NEWER SEND HAS ONE. A third of production's sends (24 of 72)
  // carry no position at all, and `hiring-manager-notify.ts` omits the `sent_for_*` columns entirely
  // for those — so the previous seat STANDS in the database. Overwriting it here with the new send's
  // empty position would not move the seat, it would erase one, and this module would then contradict
  // the row it just read.
  //
  // A null map means the table is not in this database yet, and then the old columns stand — exactly
  // how every screen behaved before the fan-out existed.
  if (latestSends) {
    for (const candidate of candidates) {
      const send = latestSends.get(candidate.id);
      if (!send) continue;
      if (!isAfter(send.sentAt, candidate.managerNotified?.sentAt ?? null)) continue;
      const stamp = managerSendStamp(send);
      candidate.managerNotified = stamp.managerNotified;
      if (stamp.sentFor) candidate.sentFor = stamp.sentFor;
    }
  }
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
 *
 * NOTHING OLDER THAN 45 DAYS, from either source (manager-hold-window.ts), unless the manager holds
 * folders: those carry no limit (owner, 2026-10-16: "lift it"). The owner, 2026-10-06:
 * *"Never a CV stay at a district manager account or any manager account more than 45 days."* A CV
 * the recruiter sends again is a new row timestamp, so it starts a fresh 45 days; one that is not
 * re-sent drops off this list the second it is 45 days old, and the daily run takes its status back.
 */
export async function listCandidatesSentToManager(managerHrId: string | null | undefined): Promise<Candidate[]> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0) return [];
  const supabase = recruitmentDb();
  const now = new Date();

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
  const sends = await listSendsForManager(managerHrId, now);

  const legacyBase = () => supabase.from("ats_candidates").select("*").in("manager_notified_hr_id", keys);
  // A stamp with no date is not provably inside the window, and `gte` drops a NULL — the same
  // fail-closed answer manager-hold-window.ts gives. Every real send also has a row in the table
  // above, so this costs a manager nothing he is entitled to. A folder holder has no window.
  const holdsFolders = await managerHoldsFolders(managerHrId);
  let legacyRows: CandidateDbRow[] = [];
  try {
    // Every CV stamped for this manager, paged to a short page by the unique `id`: a folder holder has
    // no window, so his list only grows, and a page read from the first response's worth would hide
    // CVs from the person they were sent to.
    legacyRows = await fetchAllRows<CandidateDbRow>(() => {
      const scoped = holdsFolders ? legacyBase() : legacyBase().gte("manager_notified_at", managerHoldCutoffIso(now));
      return scoped.order("manager_notified_at", { ascending: false });
    }, "id");
  } catch (error) {
    // 42703 = the column does not exist, which is the pre-migration state and NOT a fault of this
    // caller: 20260815180000_candidate_manager_push adds it. Everything else is a real failure and
    // is thrown, because a manager silently shown an empty list is precisely the invisibility this
    // module has been fixing all day.
    if ((error as { code?: string }).code !== "42703") throw error;
  }

  const rowsById = new Map<string, CandidateDbRow>();
  for (const row of legacyRows) rowsById.set(String(row.id), row);

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
  const status = textOrNull(filters.status);
  const source = textOrNull(filters.source);
  const q = textOrNull(filters.q);
  // The predicate is rebuilt per page rather than built once and awaited: `.range()` returns a new
  // builder each time, so a single `query` object cannot be paged without re-applying every filter.
  const rows = await selectEveryCandidateRow((table) => {
    let query = table.select("*").order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (source) query = query.eq("source", source);
    if (q) {
      // This one IS an `or(...)` expression, where `,` and `()` are structural — so the value is
      // quoted by the shared helper rather than stripped. Stripping them made a candidate recorded
      // as `Ahmed Ali (Pharmacist)` unfindable by name, and a phone typed as `(010) 1234` searched
      // for as `0101234`. Audit finding B04-C3.
      const filter = ilikeAnyFilter(["full_name", "email", "phone", "national_id"], q);
      // `.or("")` is an HTTP 400: a term with nothing searchable left applies no filter.
      if (filter) query = query.or(filter);
    }
    return query;
  });
  return rows.map(mapCandidate);
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

  // THE GUARD LIVES HERE, NOT ONLY ON THE BUTTON. A disabled control is UX; this is the boundary,
  // and it is the only place that can see the CURRENT status, which is what the rule is about. The
  // fifty records this repairs were written through a live button, but the same request arrives
  // just as easily from a stale tab, a double submit, or any other caller of this route.
  //
  // Asked AFTER `getCandidate` because the refusal needs the stored status, and before the write
  // for the obvious reason.
  const refusal = statusChangeRefusal(existing.status, next);
  if (refusal) throw new Error(refusal);

  // hrIdForStorage, never the raw session value. `access.hrId` is the LOWERCASE comparison key
  // and 178 of 179 employee rows are mixed case, so persisting it verbatim is what left
  // `status_changed_by_hr_id` holding THREE spellings for TWO people (b-10 x119, B-10 x7,
  // hr-010 x6 on production 2026-09-05) and `ats_candidate_status_events.actor_hr_id` holding
  // 255 lowercase rows. Any per-person report then splits one screener in two, with nothing on
  // screen to say so. Fixed at the BINDING because this one value feeds both columns.
  const actorHrId = hrIdForStorage(access.hrId);
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
      // The rejection REASON belongs to the rejection, exactly like the note: a CV moved out of
      // Rejected by hand takes its reason with it, as an Undo does (`clearRejectionReasons`).
      ...(next === "rejected" ? {} : { rejection_reason: null, rejection_reason_note: null }),
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
 * Star a CV 1, 2 or 3 — or take the star off.
 *
 * The owner, 2026-09-12: "i want be able to favorite a cv more", and he chose degrees over a single
 * bookmark so the CVs he likes rank against each other and the best rise to the top of the
 * shortlist. See candidate-rating.ts for why a star is not a status.
 *
 * DELIBERATELY NOT A DECISION, and nothing about this behaves like one:
 *
 *   - It writes no status and it reads none. A CV can be starred at any point in its life, before
 *     anyone has triaged it or long after it was sent, and starring one never advances it.
 *   - It records NO status event. `ats_candidate_status_events` is the decision trail and a star is
 *     not a decision; putting one there would show up as a move in the throughput trend and in
 *     every per-screener report built on that table.
 *   - It refuses nothing and asks `statusChangeRefusal` nothing. There is no illegal star: the only
 *     invalid value is one that is not on the ladder, and that is refused before the read.
 *
 * `null` CLEARS the star. Not 0 — see candidate-rating.ts: "unrated" has exactly one
 * representation so a filter can ask for it, and the check constraint refuses 0 outright.
 *
 * `hrIdForStorage`, never the raw session value, for the reason spelled out on the status write
 * above: `access.hrId` is the lower-cased comparison key, and persisting it verbatim is what left
 * `status_changed_by_hr_id` holding three spellings for two people. A new column gets that right
 * from its first row rather than being repaired later.
 */
export async function setCandidateRating(
  access: AccessContext,
  id: string,
  rating: number | null,
): Promise<Candidate> {
  // Validated BEFORE the read, so a bad value costs no round trip and the refusal names the ladder
  // rather than saying "something went wrong".
  const next = rating === null ? null : parseCandidateRating(rating);
  if (rating !== null && next === null) {
    throw new Error(`A star is ${candidateRatings.join(", ")} — or nothing at all to clear it.`);
  }

  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");

  const actorHrId = hrIdForStorage(access.hrId);
  const ratedAt = new Date().toISOString();
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      // The three move together, always. A cleared star must not leave last month's stamp behind
      // saying somebody rated a CV that now shows no rating — the stamp describes the star, so it
      // goes when the star goes.
      rated_at: next === null ? null : ratedAt,
      rated_by_hr_id: next === null ? null : actorHrId,
      rating: next,
      updated_at: ratedAt,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  return mapCandidate(data as CandidateDbRow);
}

/** One candidate that a bulk decision actually moved, and where it moved them from. */
export type BulkStatusMove = {
  id: string;
  fromStatus: string | null;
  /** The status note it carried before, so an Undo puts that back rather than an empty note. */
  fromNote: string | null;
  toStatus: CandidateStatus;
};

export type BulkStatusResult = {
  /** How many ids the caller asked for, before anything was checked. */
  requested: number;
  /** The candidates that really moved, each with the status it came from. */
  moved: BulkStatusMove[];
  /** Asked for but not moved — an id that matches no candidate row. Never silently dropped. */
  missing: string[];
};

/**
 * One screening verdict across many candidates, atomically.
 *
 * ── WHY THIS IS NOT A LOOP ──────────────────────────────────────────────────────────────────────
 *
 * The obvious implementation is to call `updateCandidateStatus` once per id. It is the wrong one
 * here, and this repository has already paid for the reason twice over. A Supabase client request
 * that times out at 15 seconds STILL COMMITS, so a loop that dies partway through leaves some
 * candidates decided and some not, while the screen reports a failure. The recruiter then re-applies
 * the decision over rows that already carry it, and the history fills with duplicate events that
 * make "who decided this, and when" unanswerable.
 *
 * So the whole thing is one `plpgsql` function — `ats_bulk_set_candidate_status` — which moves every
 * candidate and writes every history row inside one transaction. Either the queue changed or it did
 * not; there is no third state for a tired screener to untangle at 2am.
 *
 * ── THE REFUSAL IS ASKED, NOT RESTATED ──────────────────────────────────────────────────────────
 *
 * `bulkDecisionRefusal` owns which statuses may be set this way and how many at once, so the
 * disabled button's tooltip, this service and the route's 400 all say one sentence. `sent_to_manager`
 * and `hired` are refused there for reasons worth reading before relaxing either.
 *
 * ── WHAT IT RETURNS, AND WHY IT COUNTS THE MISSES ───────────────────────────────────────────────
 *
 * The function returns a row per candidate it actually moved. An id matching no row is skipped
 * rather than failing the batch — that is what a stale tab looks like, and failing all fifty because
 * one was deleted would be worse. But it is reported, because "50 selected, 47 moved" is the truth
 * and "done" is not. The caller needs `fromStatus` too: it is what the undo path restores, and it is
 * unavailable afterwards because the row has already been overwritten.
 */
export async function bulkUpdateCandidateStatus(
  access: AccessContext,
  ids: readonly string[],
  status: string,
  note?: string | null,
): Promise<BulkStatusResult> {
  // Duplicates collapse before anything is counted, so a list holding the same candidate twice is
  // one decision and cannot spend the cap twice over.
  const unique = Array.from(new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)));

  const refusal = bulkDecisionRefusal(status, unique.length);
  if (refusal) throw new Error(refusal);

  const next = normalizeCandidateStatus(status) as CandidateStatus;
  const cleanNote = textOrNull(note);
  if (cleanNote && cleanNote.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
    throw new Error(`Keep the note under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters.`);
  }

  // Defensive and deliberately unreachable through `bulkDecisionRefusal`, which already caps the
  // count. It is here because the cap is the one rule that also lives in SQL, and a mismatch between
  // the two should surface as this sentence rather than as a raw `23514` from Postgres.
  if (unique.length > BULK_DECISION_MAX) {
    throw new Error(`One decision covers up to ${BULK_DECISION_MAX} candidates; this is ${unique.length}.`);
  }

  const supabase = recruitmentDb();
  // Read before the write: the function replaces the note and answers only with the earlier status.
  const noteBefore = new Map<string, string | null>();
  for (const batch of chunkIds(unique)) {
    const { data: rows, error: readError } = await supabase.from("ats_candidates").select("id,status_note").in("id", batch);
    if (readError) throw readError;
    for (const row of (rows ?? []) as Array<{ id: string; status_note: string | null }>) noteBefore.set(row.id, row.status_note);
  }
  const { data, error } = await supabase.rpc("ats_bulk_set_candidate_status", {
    // hrIdForStorage, never the raw session value: `access.hrId` is the LOWERCASE comparison
    // key, and 178 of 179 employee rows are mixed case. Writing the raw key here is how
    // `status_changed_by_hr_id` came to hold three spellings for two people — any per-person
    // report then splits one screener in two, with nothing on screen to say so.
    p_actor_hr_id: hrIdForStorage(access.hrId),
    p_candidate_ids: unique,
    p_note: cleanNote,
    p_status: next,
  });
  if (error) throw error;

  const moved: BulkStatusMove[] = (
    (data ?? []) as Array<{ candidate_id?: string | null; from_status?: string | null }>
  ).map((row) => ({
    fromNote: noteBefore.get(String(row.candidate_id ?? "")) ?? null,
    fromStatus: row.from_status ?? null,
    id: String(row.candidate_id ?? ""),
    toStatus: next,
  }));

  // A batch moved OUT of Rejected takes its reasons with it, as one candidate does.
  if (next !== "rejected") {
    await clearRejectionReasons(
      supabase,
      moved.filter((row) => row.fromStatus === "rejected" && row.id).map((row) => row.id),
    );
  }

  const movedIds = new Set(moved.map((row) => row.id));
  return {
    missing: unique.filter((id) => !movedIds.has(id)),
    moved,
    requested: unique.length,
  };
}

/** One candidate to put back, with the status and note it carried before the decision. */
export type StatusRevert = {
  id: string;
  status: string;
  note: string | null;
};

export type StatusRevertResult = {
  requested: number;
  restored: Array<{ id: string; status: CandidateStatus }>;
  missing: string[];
};

/**
 * Undo — put candidates back to the status and note each one carried moments ago.
 *
 * ── WHY THIS IS NOT "DECIDE BACK" ───────────────────────────────────────────────────────────────
 *
 * A revert is a different operation from a decision, in two ways that matter.
 *
 * It is PER ROW. `bulkUpdateCandidateStatus` sets one status for everybody; an undo has to restore
 * whatever each candidate individually had, which after a mixed selection is several different
 * statuses at once.
 *
 * And it is NOT BOUND BY `bulkDecidableStatuses`. That list exists to stop somebody marking fifty
 * CVs `sent_to_manager` when no manager was told. Putting a candidate BACK to `sent_to_manager`
 * tells no such lie — they really were sent, the notification really happened, and this only
 * restores the row as it stood before the last press. Routing undo through the decision rule would
 * block the commonest undo of all, back to `new`, which is the entire backlog case.
 *
 * ── IT ADDS TO THE HISTORY, IT DOES NOT ERASE ───────────────────────────────────────────────────
 *
 * The original decision stays on the record and the reversal is written after it, so an audit later
 * shows somebody decided and changed their mind within seconds. That is the truth, and it is more
 * useful than a gap where a decision used to be.
 *
 * ── THE STATUS IS VALIDATED, EVEN THOUGH IT CAME FROM US ────────────────────────────────────────
 *
 * These values originate in a response this server sent seconds earlier, so it is tempting to trust
 * them. They still arrive over the wire from a browser, and this is a write path: a caller can send
 * whatever it likes. Every status is normalised against the real vocabulary before it is written.
 */
export async function revertCandidateStatuses(
  access: AccessContext,
  moves: readonly StatusRevert[],
): Promise<StatusRevertResult> {
  const seen = new Set<string>();
  const clean: Array<{ id: string; status: CandidateStatus; note: string | null }> = [];

  for (const move of moves) {
    const id = String(move?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    const status = normalizeCandidateStatus(move?.status);
    if (!status) {
      throw new Error(`"${String(move?.status ?? "").trim()}" is not a candidate status.`);
    }
    const note = textOrNull(move?.note);
    if (note && note.length > CANDIDATE_STATUS_NOTE_MAX_LENGTH) {
      throw new Error(`Keep the note under ${CANDIDATE_STATUS_NOTE_MAX_LENGTH} characters.`);
    }
    seen.add(id);
    clean.push({ id, note, status });
  }

  if (clean.length === 0) return { missing: [], requested: 0, restored: [] };
  if (clean.length > BULK_DECISION_MAX) {
    throw new Error(`One undo covers up to ${BULK_DECISION_MAX} candidates; this is ${clean.length}.`);
  }

  const supabase = recruitmentDb();
  // Three POSITIONAL arrays — the function pairs them by index and refuses a length mismatch, which
  // is the one failure here that would otherwise be invisible: a candidate silently restored to
  // somebody else's status looks exactly like an ordinary set of moves afterwards.
  const { data, error } = await supabase.rpc("ats_revert_candidate_status", {
    // hrIdForStorage, never the raw session value: `access.hrId` is the LOWERCASE comparison
    // key, and 178 of 179 employee rows are mixed case. Writing the raw key here is how
    // `status_changed_by_hr_id` came to hold three spellings for two people — any per-person
    // report then splits one screener in two, with nothing on screen to say so.
    p_actor_hr_id: hrIdForStorage(access.hrId),
    p_candidate_ids: clean.map((move) => move.id),
    p_notes: clean.map((move) => move.note ?? ""),
    p_statuses: clean.map((move) => move.status),
  });
  if (error) throw error;

  const restored = ((data ?? []) as Array<{ candidate_id?: string | null; restored_to?: string | null }>)
    .map((row) => ({
      id: String(row.candidate_id ?? ""),
      status: normalizeCandidateStatus(row.restored_to) as CandidateStatus,
    }))
    .filter((row) => Boolean(row.id) && Boolean(row.status));

  // The rejection REASON belongs to the rejection. An Undo that takes a CV back out of Rejected must
  // take its reason with it, or the row would go on counting as "Salary too high" in every report
  // that counts rejections by reason (owner, 2026-10-20, #24) for a person nobody rejected. A CV put
  // back INTO Rejected keeps whatever reason it still carries.
  await clearRejectionReasons(
    supabase,
    restored.filter((row) => row.status !== "rejected").map((row) => row.id),
  );

  const restoredIds = new Set(restored.map((row) => row.id));
  return {
    missing: clean.map((move) => move.id).filter((id) => !restoredIds.has(id)),
    requested: clean.length,
    restored,
  };
}

/** Take the rejection reason (and its note) off CVs that are no longer rejected. */
async function clearRejectionReasons(supabase: ReturnType<typeof recruitmentDb>, ids: string[]): Promise<void> {
  for (const batch of chunkIds(ids)) {
    const { error } = await supabase
      .from("ats_candidates")
      .update({ rejection_reason: null, rejection_reason_note: null })
      .in("id", batch);
    if (error) throw error;
  }
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
  // Storable, not just a shelf: the duplicate archive shares these columns and is not one of the
  // four the owner named. See DUPLICATE_FOLDER_KIND for why the two vocabularies are separate.
  if (!isStorableFolderKind(kind)) {
    throw new Error(`"${String(kind ?? "").trim()}" is not a folder kind.`);
  }
  const cleanKey = cleanFolderKey(key);
  if (!cleanKey) throw new Error("A folder needs a name.");

  // ONE SHELF, whatever the client sent. The paramedical shelf holds exactly one folder by design —
  // candidate-folder.ts says so and no screen offers a name field for it — but this service took
  // whatever key arrived, so a stale tab or a hand-made request carrying
  // `{kind: "paramedical", key: "Law"}` would quietly create a SECOND paramedical folder that no
  // screen lists and nobody would think to look in. The CV would be filed, gone from the pool, and
  // effectively lost. Normalised here rather than in the route so that every caller is covered by
  // one rule: the recruiter's picker, and confirmCandidateBackground below it.
  // The duplicate shelf holds ONE folder for the same reason and by the same mechanism.
  //
  // THE MEDICAL-REP AREA IS VALIDATED HERE TOO, FILE-TIME — not just where a suggestion is proposed.
  // The picker's own dropdown already only offers a live area, but this function is the one place
  // every write actually lands (the picker, the bulk "file the declared CVs" button, and any future
  // caller), so it is the one place a typo, a stale tab, or a hand-made request gets refused instead
  // of quietly opening a folder nobody else will ever open. Measured against production 2026-09-11:
  // seven CVs had already been filed this way — see resolveCanonicalMedicalRepArea.
  //
  // AND THE REGION IS VALIDATED THE SAME WAY, for the same reason and at the same cost. Its list is
  // closed and lives in this repository (`candidateRegionCodes`), so there is nothing to look up —
  // which is exactly why it stayed unguarded while the area was being fixed. An unrecognised code
  // here would open a folder `candidateFolderLabel` cannot name and `districtManagerFolderOptions`
  // never lists, so the CV would be filed, off the pool screen, and in a folder nobody opens.
  // Production is clean on this shelf today (5 folders, all real codes, verified 2026-09-12) — this
  // keeps it that way rather than repairing it.
  //
  // The "other" shelf deliberately gets NO list to check against. It is keyed on a job title the
  // recruiter types, by the owner's own split — *"8 regions, and split other positions by job
  // title"* — and there is no vocabulary of job titles to validate one against. Its guard belongs
  // where the danger is, on the AUTOMATED path: candidate-folder-suggestion.ts refuses to propose a
  // folder from a typed title nothing can place, so an unread WhatsApp reply can no longer name a
  // shelf. A recruiter typing a title by hand is a person deciding, and is left alone.
  let folderKey: string;
  if (kind === "paramedical") {
    folderKey = PARAMEDICAL_FOLDER_KEY;
  } else if (kind === DUPLICATE_FOLDER_KIND) {
    folderKey = DUPLICATE_FOLDER_KEY;
  } else if (kind === "medical_rep") {
    const canonicalAreas = await listCanonicalMedicalRepAreaNames();
    const resolved = resolveCanonicalMedicalRepArea(cleanKey, canonicalAreas);
    if (resolved.area === null) throw new Error(resolved.refusal);
    folderKey = resolved.area;
  } else if (kind === "district_manager") {
    const resolved = resolveCandidateRegionFolderCode(cleanKey);
    if (resolved.code === null) throw new Error(resolved.refusal);
    folderKey = resolved.code;
  } else {
    folderKey = cleanKey;
  }

  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");
  // The KIND decides the rule. Position shelves refuse a rejected CV — they are for good CVs waiting
  // on a seat — while the duplicate shelf is a discard of a redundant record and must be able to
  // take one, since a duplicate is at least as likely to be rejected as anything else.
  const refusal = candidateFolderRefusal(existing, kind);
  if (refusal) throw new Error(refusal);

  // THE DEGREE, for the two shelves it is about. The bulk "file what they answered" action already
  // holds this rule (candidate-folder-suggestion.ts); this is the same rule for the one path that
  // bypassed it — a recruiter filing a single CV by hand through the picker, which never asked about
  // a degree at all. That gap is what let a Faculty-of-Education CV sit on Medical Representative /
  // Behira 1 for eleven days with nobody having opened it. See background-review.ts for why this is
  // scoped to a `paramedical` verdict only, never `unknown`.
  const backgroundRefusal = backgroundFolderFilingRefusal(existing, kind);
  if (backgroundRefusal) throw new Error(backgroundRefusal);

  const filedAt = new Date().toISOString();
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      folder_filed_at: filedAt,
      folder_filed_by_hr_id: hrIdForStorage(access.hrId),
      // `kind` is already narrowed to CandidateFolderKind by the guard above — no cast needed.
      folder_kind: kind,
      folder_key: folderKey,
      updated_at: filedAt,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return mapCandidate(data as CandidateDbRow);
}

/**
 * Record an admin's answer on a graduation background — the manual half of the backfill.
 *
 * The owner, 2026-08-31: *"anyone non eligible, you will make the admin be able to check first
 * their CV and confirm."*
 *
 * PARAMEDICAL ALSO FILES, IN THE SAME CALL. The owner's first instruction was a folder — "I want
 * the non science or pharmacy or vet to be excluded in a separate folder, name this folder
 * paramedical" — and his second was that a person confirms it. Those are one action, not two, and
 * splitting them across two clicks is how a row ends up confirmed but not filed: invisible to the
 * queue that would have asked again, and still sitting in the pool everybody works from.
 *
 * The confirmation is written FIRST and the filing second. If the filing fails, the decision
 * survives and the row is out of the routing rule immediately — the direction that protects a
 * candidate from being sent to a manager the admin has just excluded them from. The reverse order
 * would file them and then, on a failure, leave a shelved CV that still reads as unanswered.
 *
 * A rejected CV is refused, through `candidateFolderRefusal` for the paramedical half — the same
 * sentence the button's tooltip and the route's 400 use. The eligible half has no such refusal:
 * saying "this person's degree is fine" about somebody already turned down is harmless and true.
 */
export async function confirmCandidateBackground(
  access: AccessContext,
  id: string,
  outcome: string,
): Promise<Candidate> {
  if (!isBackgroundConfirmationOutcome(outcome)) {
    throw new Error(`"${String(outcome ?? "").trim()}" is not a background answer.`);
  }

  const existing = await getCandidate(id);
  if (!existing) throw new Error("Candidate not found.");

  if (outcome === "paramedical") {
    const refusal = candidateFolderRefusal(existing);
    if (refusal) throw new Error(refusal);
  }

  const confirmedAt = new Date().toISOString();
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_candidates")
    .update({
      background_confirmed_at: confirmedAt,
      background_confirmed_by_hr_id: hrIdForStorage(access.hrId),
      background_confirmed_outcome: outcome,
      updated_at: confirmedAt,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;

  if (outcome !== "paramedical") return mapCandidate(data as CandidateDbRow);
  return fileCandidateToFolder(access, id, "paramedical", PARAMEDICAL_FOLDER_KEY);
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
export async function recordCandidateStatusEvent(input: {
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

/** Paging for the projected extraction read. Same shape as its siblings above. */
const FINDING_PAGE_SIZE = 1000;
const FINDING_PAGE_LIMIT = 50;

/**
 * The handful of CV findings the row badge checks, for every candidate, keyed by candidate id.
 *
 * ── WHY THIS IS A PROJECTION AND NOT A NORMAL READ ──────────────────────────────────────────────
 *
 * `extracted_fields` is 1,549 kB across the live pool (measured 2026-09-05) and every round trip
 * from here crosses the Atlantic — which is exactly why `loadCvJobTitlesByCandidate` above is
 * called with only the candidates the free evidence could not answer. Pulling the whole blob on
 * every screening page load, to compute a badge, would be the most expensive thing the page does.
 *
 * PostgREST can return a jsonb member instead of the whole column, so this asks for only the three
 * keys the badge checks: 105 kB, fifteen times less, verified against production before it was
 * written. Each one comes back in its stored `{ value, confidence }` shape, which is exactly what
 * `listUnappliedCvFields` expects — so the badge is computed by the same code as the CV Data tab
 * rather than by a second opinion about what counts.
 *
 * THE SELECT IS BUILT FROM `ROW_FINDING_KEYS`, never written out by hand. A key added to that list
 * and forgotten here would be silently unread, and the badge would quietly stop counting it with
 * nothing to show that it had — the failure being designed out by construction rather than pinned
 * by a test.
 */
export async function loadRowFindings(): Promise<Map<string, ExtractedCandidateFields>> {
  const byCandidate = new Map<string, ExtractedCandidateFields>();
  const seen = new Set<string>();
  const supabase = recruitmentDb();

  const projection = [
    "candidate_id",
    "created_at",
    ...ROW_FINDING_KEYS.map((key) => `${key}:extracted_fields->${key}`),
  ].join(",");

  for (let page = 0; page < FINDING_PAGE_LIMIT; page += 1) {
    const from = page * FINDING_PAGE_SIZE;
    const { data, error } = await supabase
      .from("ats_candidate_cv_extractions")
      .select(projection)
      // Newest first, so the FIRST row seen for a candidate is the reading that counts. A candidate
      // can hold several extractions — a re-read writes another row rather than replacing one.
      .order("created_at", { ascending: false })
      .order("candidate_id", { ascending: true })
      // The unique row id last: a candidate's re-reads can share a `created_at`, and a tied order lets
      // a row repeat or slip between two pages.
      .order("id", { ascending: true })
      .range(from, from + FINDING_PAGE_SIZE - 1);

    if (error) {
      // No extractions table means no findings, which the row renders as no badge — exactly how it
      // behaved before any of this existed.
      if (isMissingStatusEventRelation(error)) return byCandidate;
      throw error;
    }

    // THROUGH `unknown` DELIBERATELY. supabase-js types a select string it can parse; it cannot
    // parse a jsonb projection (`alias:column->key`), so it falls back to GenericStringError[]
    // and a direct cast is rejected as non-overlapping. The runtime shape is verified against
    // production — each key returns its stored `{ value, confidence }` object.
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const candidateId = textOrNull(row.candidate_id);
      if (!candidateId || seen.has(candidateId)) continue;
      seen.add(candidateId);

      const fields: ExtractedCandidateFields = {};
      for (const key of ROW_FINDING_KEYS) {
        const held = row[key] as { value?: unknown; confidence?: unknown } | null | undefined;
        // A key absent from the extraction comes back null, and that is not a finding — it is the
        // reader never having proposed anything, which is a different thing from proposing a blank.
        if (!held || typeof held !== "object") continue;
        fields[key] = {
          confidence: held.confidence === "high" ? "high" : "low",
          value: (held.value ?? null) as ExtractedCvValue,
        };
      }
      if (Object.keys(fields).length > 0) byCandidate.set(candidateId, fields);
    }

    if (rows.length < FINDING_PAGE_SIZE) return byCandidate;
  }

  throw new Error(
    `CV finding paging stopped at ${FINDING_PAGE_LIMIT * FINDING_PAGE_SIZE} rows. Refusing to report ` +
      "a partial read as a complete one — a candidate with unsaved findings would show no badge and " +
      "read as done.",
  );
}

/** A runaway guard on the decision history, not a data cap. */
const STATUS_EVENT_PAGE_SIZE = 1000;
const STATUS_EVENT_PAGE_LIMIT = 50;

export type DecisionHistory = {
  /** When each decided candidate was FIRST decided, keyed by candidate id. */
  firstDecisionAt: Map<string, string>;
  /** The earliest instant the history covers at all, or null when there is none. */
  startsAt: string | null;
};

/**
 * When each candidate was FIRST moved off `new`, across the whole recorded history.
 *
 * ── WHY FIRST, AND WHY DISTINCT CANDIDATES ──────────────────────────────────────────────────────
 *
 * The throughput strip asks whether the backlog is being cleared, so its unit has to be a CV that
 * left the backlog — not a status change. Measured in production 2026-09-05, the week of 08-24
 * carried 461 status events across 189 candidates: counting events would have reported two and a
 * half times the real output, and every re-decision would have read as fresh progress.
 *
 * ── WHY THE WHOLE TABLE, AND WHAT THAT COSTS ────────────────────────────────────────────────────
 *
 * "First ever" cannot be answered from a 30-day slice: a candidate whose first decision was in
 * July and who was re-decided yesterday would look like a brand-new decision. So the read is the
 * full history — 560 rows on 2026-09-05, two columns, and the table only began on 2026-08-16.
 *
 * It grows, and bulk decisions write to it faster than the old one-at-a-time flow did. It is paged
 * with a refusal rather than a silent truncation, and when the count reaches the point where this
 * is no longer a cheap read the answer is a SQL aggregate — not a wider page limit, and not a
 * window, which would quietly reintroduce the "first ever" bug above.
 *
 * ── THE START DATE IS RETURNED, NOT ASSUMED ─────────────────────────────────────────────────────
 *
 * Nothing before the history began can be reported, and a span the history only partly covers must
 * read as unknown rather than as zero. The caller needs the boundary to do that, so it comes back
 * from the same read rather than being hardcoded to a date that will drift.
 */
export async function loadDecisionHistory(): Promise<DecisionHistory> {
  const supabase = recruitmentDb();
  const firstDecisionAt = new Map<string, string>();
  let startsAt: string | null = null;

  for (let page = 0; page < STATUS_EVENT_PAGE_LIMIT; page += 1) {
    const from = page * STATUS_EVENT_PAGE_SIZE;
    const { data, error } = await supabase
      .from("ats_candidate_status_events")
      // actor_hr_id is READ, not decoration: a batch is not a decision, and without it this
      // function cannot tell 65 rows of an automated sweep from a week of screening.
      .select("candidate_id,created_at,to_status,actor_hr_id")
      // Stable and unique together, so paging can neither repeat a row nor drop one.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + STATUS_EVENT_PAGE_SIZE - 1);

    if (error) {
      // No table means no history — which the strip renders as "not recorded", never as zero work.
      if (isMissingStatusEventRelation(error)) return { firstDecisionAt, startsAt };
      throw error;
    }

    const rows = (data ?? []) as Array<{
      actor_hr_id?: string | null;
      candidate_id?: string | null;
      created_at?: string | null;
      to_status?: string | null;
    }>;

    for (const row of rows) {
      const at = row.created_at ? String(row.created_at) : null;
      if (!at) continue;
      // The boundary is the earliest event of ANY kind: it marks when recording began, which is a
      // fact about the table rather than about decisions.
      if (startsAt === null || at < startsAt) startsAt = at;

      const candidateId = row.candidate_id ? String(row.candidate_id) : null;
      if (!candidateId) continue;
      // `new` is where a candidate starts; arriving there is not a decision. A revert back to it is
      // not one either — the undo path writes such a row, and counting it would let one press and
      // its own undo read as two CVs cleared.
      if (normalizeCandidateStatus(row.to_status) === "new") continue;

      // AND NEITHER IS A BATCH. This was missing when the throughput trend shipped on 2026-09-05,
      // and the strip was measured wrong within hours: `ops:non-egyptian-reject-20260828` moved 65
      // candidates in one sweep, so the week of 08-29 read 138 decisions against a true 73. The
      // screen told the owner his backlog had SHRUNK BY 69 that week when it had held level at -4 —
      // an automated rejection of scattergun international CVs presented as a week of screening.
      //
      // The whole point of this trend is that somebody acts on the direction. A number that counts
      // a sweep as work is worse than no number, because it rewards running another sweep.
      if (isBatchActor(row.actor_hr_id)) continue;

      const held = firstDecisionAt.get(candidateId);
      if (!held || at < held) firstDecisionAt.set(candidateId, at);
    }

    if (rows.length < STATUS_EVENT_PAGE_SIZE) return { firstDecisionAt, startsAt };
  }

  throw new Error(
    `Decision history paging stopped at ${STATUS_EVENT_PAGE_LIMIT * STATUS_EVENT_PAGE_SIZE} rows. ` +
      "Refusing to report a partial history as a complete one — the throughput trend would understate " +
      "real output with nothing on screen to say so.",
  );
}

/** PGRST205 is what a MISSING TABLE answers here, not 42P01 — both are treated as one absence. */
function isMissingStatusEventRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
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
//
// TWO MORE THINGS A FOREIGN KEY DOES NOT REACH, both handled here (2026-10-18):
//   - ats_cv_folder_items, ats_candidate_manager_folders and ats_candidate_comments carry NO foreign
//     key, by design (a filing must never block this delete), so they orphaned: a folder or a
//     manager's shelf went on counting a CV nobody could open.
//   - the BYTES behind ats_files. The rows cascade away; the object each one names in the
//     `recruitment-files` bucket did not, so deleted people's CVs and job offers stayed in storage
//     (89 objects with no row on production). The paths are read BEFORE the cascade and the objects
//     removed through the Storage API AFTER the candidate row is gone; a storage failure is logged
//     and never raised, so it cannot block or undo the delete. See candidate-storage-cleanup.ts.
export async function deleteCandidate(access: AccessContext, id: string): Promise<void> {
  assertCanDeleteRecruitment(access);
  const candidate = await getCandidate(id);
  if (!candidate) throw new Error("Candidate not found.");
  const supabase = recruitmentDb();
  // The ats_files rows cascade away with the candidate and take the only record of where their bytes
  // are, so the paths are read now. This read never throws.
  const storagePaths = await readCandidateStoragePaths(id);
  // ats_cv_folder_items has NO foreign key, by design (a filing must never block this delete), so
  // nothing else removes the filings. Left behind, a hand-built folder keeps counting a CV that no
  // longer exists (audit, 2026-09-12). Removed FIRST: if the candidate delete below then fails, the
  // worst case is a candidate who survives unfiled — back in the pool, visible — never a ghost.
  // The manager shelves go with them. The comments go only once the candidate row is GONE: a filing or
  // a shelf comes back with one press, while a comment is the one thing a person wrote that a re-send
  // cannot remake, so a candidate delete that fails must leave every comment where it was.
  const { error: filingError } = await supabase.from("ats_cv_folder_items").delete().eq("candidate_id", id);
  if (filingError) throw filingError;
  const { error: shelfError } = await supabase.from("ats_candidate_manager_folders").delete().eq("candidate_id", id);
  if (shelfError) throw shelfError;
  const { error } = await supabase.from("ats_candidates").delete().eq("id", id);
  if (error) throw error;
  // Only now, with the record gone: take its bytes out of storage. Never throws, never undoes the delete.
  await removeCandidateStorageObjects(id, storagePaths);
  const { error: commentError } = await supabase.from("ats_candidate_comments").delete().eq("candidate_id", id);
  if (commentError) throw commentError;
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
  folderArea?: string | null,
): Promise<{
  candidateName: string;
  /** The folder on the manager's shelf the CV was filed in; null for a manager who holds no folders. */
  folder: string | null;
  managerHrId: string;
  managerName: string;
  sentAt: string;
}> {
  const sent = await sendCandidatesToManager(access, [candidateId], managerHrId, position, folderArea);
  return { ...sent, candidateName: sent.candidateNames[0] ?? "", folder: sent.folders[0]?.folder ?? null };
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
  folderArea?: string | null,
): Promise<{
  candidateNames: string[];
  count: number;
  /** Where each CV was filed on the manager's shelf. `folder` is null for a manager with no folders. */
  folders: Array<{ candidateName: string; folder: string | null }>;
  managerHrId: string;
  managerName: string;
  sentAt: string;
}> {
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

  // ── NOBODY IS SENT AN APPLICATION FOR HIS OWN JOB, BY HAND EITHER ─────────────────────────────
  //
  // The owner, 2026-09-09: *"a district manager never receives district manager."* The folders stopped
  // routing these on their own the same day; this is the other door. Same ladder, asked here — see
  // managerMayBeSentApplication for the two places a person deciding is allowed what a routing rule
  // is not (a head-office manager off the sales tree, and the CEO).
  //
  // REFUSED BEFORE THE NOTIFICATION, and the whole selection is refused rather than the offenders
  // being dropped quietly: a recruiter who picked five people and saw four arrive, with nothing
  // saying which is missing, is the failure this module already refuses one line above.
  //
  // The message names the people and the seat, never a rule number — the recruiter has to be able to
  // act on it, and the action is to send them to the manager above instead.
  const wrongRank = candidates
    .map((candidate) => ({ candidate, tier: candidateManagerSeatTier(candidate) }))
    .filter((entry) => entry.tier !== null && !managerMayBeSentApplication(manager.seatTier, entry.tier));
  if (wrongRank.length > 0) {
    const names = wrongRank.map((entry) => entry.candidate.fullName);
    throw new Error(
      `${names.join(", ")} ${names.length === 1 ? "is applying" : "are applying"} for a job at or above ` +
        `${manager.name}'s own seat (${manager.jobTitle}), so ${names.length === 1 ? "the CV" : "those CVs"} ` +
        `cannot be sent to ${manager.name}. Send ${names.length === 1 ? "it" : "them"} to the sales manager above ` +
        `${manager.name} instead.`,
    );
  }

  // Resolved BEFORE the notification goes out, not after. If the picked vacancy has been filled
  // since the page loaded, this throws — and it must throw while the only cost is an error message,
  // not once a manager has already been alerted about a position that no longer exists.
  const sentForPosition = position ? await resolveSentForPosition(position) : null;

  // ── WHICH FOLDER ON HIS SHELF (owner, 2026-10-16) ─────────────────────────────────────────────
  //
  // Every manager holds an empty folder per area, and a CV is in one only because it was sent there.
  // The recruiter's choice wins; otherwise the area of the position, then the area the applicant
  // declared, then the area their CV's own text names; otherwise "Other CVs". A folder the recruiter
  // names that is not on this manager's shelf is refused by name rather than filed somewhere else.
  const requestedFolder = String(folderArea ?? "").trim();
  const shelves = await loadManagerShelves(manager.hrId);
  const wantsOther = requestedFolder === OTHER_CVS_FOLDER_LABEL;
  if (shelves.length > 0 && requestedFolder && !wantsOther) {
    const onShelf = chooseFolderForPush({ boards: shelves, requested: requestedFolder });
    if (!onShelf) throw new Error(`${requestedFolder} is not a folder on ${manager.name}'s shelf.`);
  }
  const folderByCandidate: Record<string, string | null> = {};
  const filedIn: Array<{ candidateName: string; folder: string | null }> = [];
  for (const candidate of candidates) {
    const folder =
      shelves.length === 0 || wantsOther
        ? null
        : chooseFolderForPush({
            boards: shelves,
            candidate,
            positionArea: sentForPosition?.areaName ?? null,
            requested: requestedFolder,
          });
    folderByCandidate[candidate.id] = folder;
    filedIn.push({
      candidateName: candidate.fullName,
      folder: shelves.length === 0 ? null : (folder ?? OTHER_CVS_FOLDER_LABEL),
    });
  }

  const sent = await pushCandidatesToManager({
    actorHrId: access.hrId ?? null,
    candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.fullName })),
    folderByCandidate,
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

  return { ...sent, candidateNames: candidates.map((candidate) => candidate.fullName), folders: filedIn };
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
