// Recruitment / ATS — the DB half of a candidate merge (rules: candidate-merge.ts).
//
// Kept apart from candidate-merge.ts so the refusal rules stay unit testable without a Supabase
// client, the same split as contact-review / contact-review-service.

import type { AccessContext } from "@/lib/auth/permissions";
import { canReviewCandidateContacts } from "@/lib/recruitment/access";
import { candidateDisplayName } from "@/lib/recruitment/candidate-display";
import {
  normalizeEmail,
  normalizeNationalId,
  normalizePhone,
} from "@/lib/recruitment/candidate-matching";
import {
  borrowableFields,
  describeBorrowedFields,
  mergeBlockReason,
  mergeScreeningExtraAnswers,
  type BorrowedField,
  type MergeApplicationFacts,
} from "@/lib/recruitment/candidate-merge";
import { getCandidate } from "@/lib/recruitment/candidates";
import { mapCandidate, recruitmentDb, type CandidateDbRow } from "@/lib/recruitment/db";
import { logError } from "@/lib/observability/log";
import type { Candidate } from "@/lib/recruitment/types";

export type CandidateMergeResult = {
  borrowedFields: string[];
  candidate: Candidate;
  duplicateName: string;
  movedApplications: number;
  movedFiles: number;
  summary: string;
};

/**
 * Every table that points at a candidate by id, in the order a merge must move them.
 *
 * `ats_applications` goes FIRST on purpose. It is the only one carrying a unique constraint
 * (`recruitment_applications_active_uidx`, one live application per person per requisition), so it
 * is the only move that can be rejected by the database. Moving it before anything else means a
 * refusal we failed to predict leaves the duplicate whole rather than half-emptied.
 *
 * `ats_candidate_source_context` is NOT here and must never be added — it is a VIEW over
 * `ats_cv_intake_events`, so it follows that table automatically.
 */
const childTables = [
  "ats_applications",
  "ats_files",
  "ats_candidate_cv_extractions",
  "ats_cv_intake_events",
  // No foreign key at all on this one, so a delete would silently orphan its rows rather than
  // cascade or null them. It has to be moved by hand or the duplicate's decision history is lost.
  "ats_candidate_status_events",
] as const;

/**
 * Rows that point at a candidate through a column of their OWN naming, which `reassign` cannot
 * move — it keys every child on `candidate_id`.
 *
 * The WhatsApp classification session is the only one today, and it is deliberately not in
 * `childTables` above: it is not a child record. It outlives the merge, it holds the applicant's
 * own answers, and `applied_candidate_id` is the note saying which record those answers were
 * written onto. Left pointing at the deleted duplicate it says they went somewhere that no longer
 * exists, so anything resolving a conversation back to a candidate finds nothing — which reads as
 * "this applicant never applied", not as a broken link. Two sessions were found in exactly that
 * state in production on 2026-09-02, both stranded by a merge run minutes earlier.
 *
 * Keep this list BELOW childTables: recruitment-candidate-merge.test.ts slices childTables to the
 * first `] as const` in the file, so a second one above it silently empties what that test reads.
 */
const linkedByOwnColumn = [
  { column: "applied_candidate_id", table: "ats_whatsapp_classification_sessions" },
] as const;

type ApplicationScopeRow = {
  candidate_id: unknown;
  converted_employee_hr_id?: unknown;
  requisition_id: unknown;
  stage: unknown;
};

/** Both candidates' applications, with the job title of the opening each one is against. */
async function loadApplicationFacts(candidateIds: readonly string[]): Promise<Map<string, MergeApplicationFacts[]>> {
  const byCandidate = new Map<string, MergeApplicationFacts[]>();
  for (const id of candidateIds) byCandidate.set(id, []);

  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_applications")
    .select("candidate_id,converted_employee_hr_id,requisition_id,stage")
    .in("candidate_id", [...candidateIds]);
  if (error) throw error;

  const rows = (data ?? []) as ApplicationScopeRow[];
  const requisitionIds = [...new Set(rows.map((row) => String(row.requisition_id ?? "")).filter(Boolean))];
  const titles = new Map<string, string>();
  if (requisitionIds.length > 0) {
    const { data: requisitions, error: requisitionError } = await supabase
      .from("ats_requisitions")
      .select("id,job_title")
      .in("id", requisitionIds);
    if (requisitionError) throw requisitionError;
    for (const row of (requisitions ?? []) as { id: unknown; job_title: unknown }[]) {
      titles.set(String(row.id ?? ""), String(row.job_title ?? ""));
    }
  }

  for (const row of rows) {
    const candidateId = String(row.candidate_id ?? "");
    const bucket = byCandidate.get(candidateId);
    if (!bucket) continue;
    const requisitionId = String(row.requisition_id ?? "");
    bucket.push({
      convertedEmployeeHrId: row.converted_employee_hr_id ? String(row.converted_employee_hr_id) : null,
      requisitionId,
      requisitionTitle: titles.get(requisitionId) ?? null,
      stage: String(row.stage ?? ""),
    });
  }
  return byCandidate;
}

/** Points one table's rows at the survivor. Returns how many rows moved. */
async function reassign(table: string, fromCandidateId: string, toCandidateId: string): Promise<number> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(table)
    .update({ candidate_id: toCandidateId })
    .eq("candidate_id", fromCandidateId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * Repoints one table's own candidate column at the survivor. Returns how many rows moved.
 *
 * Separate from `reassign` rather than a parameter on it: that one moves CHILD rows, whose whole
 * existence belongs to the candidate, and this one repairs a reference held by a record that
 * stands on its own. Same UPDATE, different meaning — and a merge that confused the two would
 * either miss this link or try to write `candidate_id` onto a table that has no such column.
 */
async function relink(
  table: string,
  column: string,
  fromCandidateId: string,
  toCandidateId: string,
): Promise<number> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(table)
    .update({ [column]: toCandidateId })
    .eq(column, fromCandidateId)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * Joins a duplicate candidate record into the one being kept, then deletes the duplicate.
 *
 * The order is what makes this safe to interrupt:
 *
 *  1. refuse outright if the merge cannot complete (candidate-merge.ts decides);
 *  2. move every child row to the survivor — applications first, see childTables;
 *  3. delete the duplicate;
 *  4. only THEN fill the survivor's blanks from the values captured in step 1.
 *
 * Step 4 comes last because `national_id`, `email` and `phone` each carry a partial UNIQUE index.
 * Writing the duplicate's email onto the survivor while the duplicate still holds it is a 23505,
 * every time — the value has to be freed before it can be borrowed.
 */
export async function mergeCandidates(
  access: AccessContext,
  input: { duplicateId: string; survivorId: string },
): Promise<CandidateMergeResult> {
  // A merge writes the two columns dedupe itself is decided on (email_norm / phone_norm), so it is
  // gated on who may work the pipeline — the same authority as the contact review, not the broader
  // read gate. It is deliberately NOT Super Admin only: duplicates are Talent Acquisition's daily
  // problem, and a merge nobody with the problem can run is a merge that never happens.
  if (!canReviewCandidateContacts(access)) {
    throw new Error("Forbidden: only Super Admin and HR Advisory can merge candidate records.");
  }

  const survivorId = String(input.survivorId ?? "").trim();
  const duplicateId = String(input.duplicateId ?? "").trim();
  if (!survivorId || !duplicateId) throw new Error("Both the candidate to keep and the duplicate are required.");

  const [survivor, duplicate] = await Promise.all([getCandidate(survivorId), getCandidate(duplicateId)]);
  const applications = await loadApplicationFacts([survivorId, duplicateId]);

  const blocked = mergeBlockReason({
    duplicate,
    duplicateApplications: applications.get(duplicateId) ?? [],
    survivor,
    survivorApplications: applications.get(survivorId) ?? [],
  });
  if (blocked) throw new Error(blocked);
  if (!survivor || !duplicate) throw new Error("Candidate not found.");

  // Captured BEFORE the duplicate is deleted — after step 3 there is nothing left to read.
  const borrowed = borrowableFields(survivor, duplicate);
  const { changed: extraAnswersChanged, merged: mergedExtraAnswers } = mergeScreeningExtraAnswers(
    survivor.screeningExtraAnswers,
    duplicate.screeningExtraAnswers,
  );
  // 40% of full_name holds a whole forwarded-mail envelope, so the stored value is not the name —
  // candidateDisplayName is what turns it back into one.
  const duplicateName = candidateDisplayName(duplicate.fullName) || "this duplicate record";

  let movedApplications = 0;
  let movedFiles = 0;
  for (const table of childTables) {
    const moved = await reassign(table, duplicateId, survivorId);
    if (table === "ats_applications") movedApplications = moved;
    if (table === "ats_files") movedFiles = moved;
  }

  // Before the delete, for the same reason the child rows move first: once the duplicate is gone,
  // a row still pointing at it cannot be found from either end.
  for (const link of linkedByOwnColumn) {
    await relink(link.table, link.column, duplicateId, survivorId);
  }

  const supabase = recruitmentDb();
  const { error: deleteError } = await supabase.from("ats_candidates").delete().eq("id", duplicateId);
  if (deleteError) throw deleteError;

  let merged = survivor;
  if (borrowed.length > 0 || extraAnswersChanged) {
    const payload: Record<string, unknown> = { ...borrowedPayload(borrowed) };
    if (extraAnswersChanged) payload.screening_extra_answers = mergedExtraAnswers;
    const { data, error } = await supabase
      .from("ats_candidates")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", survivorId)
      .select("*")
      .single();
    if (error) throw error;
    merged = mapCandidate(data as CandidateDbRow);
  }

  const summary = buildSummary({ borrowed, duplicateName, extraAnswersChanged, movedApplications, movedFiles });
  await recordMergeEvent({
    actorHrId: access.hrId ?? null,
    candidateId: survivorId,
    note: summary,
    status: merged.status,
  });

  return {
    borrowedFields: borrowed.map((field) => field.label),
    candidate: merged,
    duplicateName,
    movedApplications,
    movedFiles,
    summary,
  };
}

/**
 * The borrowed values as columns — plus the `_norm` twin of each of the three identity columns.
 *
 * Nothing in the database maintains those: `candidatePayload`/`updateCandidatePayload` recompute
 * them in TypeScript on every write. A merge that set `email` without `email_norm` would leave the
 * survivor findable by a recruiter and invisible to dedup, which is how the duplicate got created.
 */
function borrowedPayload(borrowed: readonly BorrowedField[]): Record<string, string | number | null> {
  const payload: Record<string, string | number | null> = {};
  for (const field of borrowed) {
    payload[field.column] = field.value;
    if (field.key === "email") payload.email_norm = normalizeEmail(String(field.value));
    if (field.key === "phone") payload.phone_norm = normalizePhone(String(field.value));
    if (field.key === "nationalId") payload.national_id_norm = normalizeNationalId(String(field.value));
  }
  return payload;
}

function buildSummary(input: {
  borrowed: readonly BorrowedField[];
  duplicateName: string;
  extraAnswersChanged: boolean;
  movedApplications: number;
  movedFiles: number;
}): string {
  const parts: string[] = [`Merged the duplicate record for ${input.duplicateName}.`];
  const moved: string[] = [];
  if (input.movedFiles > 0) moved.push(input.movedFiles === 1 ? "1 file" : `${input.movedFiles} files`);
  if (input.movedApplications > 0) {
    moved.push(input.movedApplications === 1 ? "1 application" : `${input.movedApplications} applications`);
  }
  if (moved.length > 0) parts.push(`Moved ${moved.join(" and ")} across.`);
  const filledIn: string[] = [];
  if (input.borrowed.length > 0) filledIn.push(describeBorrowedFields(input.borrowed));
  if (input.extraAnswersChanged) filledIn.push("screening question answers");
  parts.push(filledIn.length > 0 ? `Filled in the ${filledIn.join(" and ")}.` : "Nothing was missing here, so no details changed.");
  return parts.join(" ");
}

/**
 * One line on the survivor's decision history saying what was joined into it.
 *
 * Best effort, and for the same reason updateCandidateStatus writes its own event that way: the
 * merge has already happened by this point and cannot be undone by throwing. A missing history
 * line is a gap; reporting a completed merge as a failure would invite a second click, and the
 * second click would refuse because the duplicate is already gone.
 */
async function recordMergeEvent(input: {
  actorHrId: string | null;
  candidateId: string;
  note: string;
  status: string;
}): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_candidate_status_events").insert({
    actor_hr_id: input.actorHrId,
    candidate_id: input.candidateId,
    // The status did not move — this line is here for its note. Writing the same value on both
    // sides keeps it out of any "changed from X to Y" reading of the history.
    from_status: input.status,
    note: input.note,
    to_status: input.status,
  });
  if (error) {
    logError("Candidates merged but the history line could not be written", {
      error,
      labels: {
        candidate_id: input.candidateId,
        event: "candidate_merge_event_write_failed",
      },
    });
  }
}
