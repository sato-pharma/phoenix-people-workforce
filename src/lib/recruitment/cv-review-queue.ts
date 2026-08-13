// Recruitment / ATS — the review queue for CV extractions no human has ever seen.
//
// Why this exists: automated intake (WhatsApp/email) writes an ats_candidate_cv_extractions row
// for every CV, but the review UI is reachable ONLY from the two MANUAL paths — the
// create-from-CV bulk board and the per-candidate "re-run extraction" button — so an auto-intake
// candidate's proposal was never put in front of anyone. cv-auto-apply.ts closed the
// HIGH-confidence half of that gap by writing those fields unattended. What it deliberately
// declines (gate 1, `confidence === "low"`) still had no route to a human at all. This module is
// that route: a worklist of the proposals that are sitting in the database unseen.
//
// A queue item is one candidate + its NEWEST UNREVIEWED extraction (`applied_fields is null` —
// nobody has ever saved a review of it) + the fields a human could still act on.
//
// Note the queue is deliberately NOT filtered by confidence. Gate 4 below (the candidate column
// must still be blank) already removes anything auto-apply successfully wrote, so a high-confidence
// field only survives here when it was NOT applied — an extraction that predates the feature, or
// one where the best-effort apply step failed. Those need a human just as much as the low-confidence
// ones, and filtering on confidence would hide them.
//
// Saving a review goes through the EXISTING PATCH /api/recruitment/candidates/[id] route with an
// `extractionId`, which writes `applied_fields`. That is correct and intended here: unlike
// auto-apply, this IS a human review, and it is exactly the signal cv-extraction-analytics.ts
// measures the AI's correction rate from. Reviewing from this queue therefore also repairs the
// analytics coverage that unattended intake had been silently starving.
//
// Selection is pure (schema registry + plain types) so the rules unit-test without Supabase,
// matching cv-auto-apply.ts and cv-extraction-analytics.ts.

import { CV_IDENTITY_FIELD_KEYS, isBlankCandidateValue } from "@/lib/recruitment/cv-auto-apply";
import { getCvPositionSchema, type CvFieldType } from "@/lib/recruitment/cv-field-schemas";
import { mapCandidate, type CandidateDbRow } from "@/lib/recruitment/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { Candidate } from "@/lib/recruitment/types";

/** The AI's per-field proposal shape, narrowed to what this decision needs. */
export type ReviewQueueExtractedFields = Record<string, { value: string | boolean | null; confidence: "high" | "low" }>;

export type PendingReviewField = {
  key: string;
  label: string;
  type: CvFieldType;
  value: string | boolean;
  confidence: "high" | "low";
};

export type CvReviewQueueItem = {
  candidateId: string;
  candidateName: string;
  candidateSource: string | null;
  extractionId: string;
  positionKey: string;
  extractedAt: string;
  /** What a human could still act on — drives the queue's "N fields waiting" count. */
  pendingFields: PendingReviewField[];
  /** Prefill for CvExtractionReviewBoard. Identity keys hold the CANDIDATE's stored values. */
  boardFields: ReviewQueueExtractedFields;
};

export type CvReviewQueue = {
  items: CvReviewQueueItem[];
  /** True when the row cap below was hit, so the caller can say so rather than imply completeness. */
  truncated: boolean;
  generatedAt: string;
};

// Hard cap on extraction rows scanned per call. Well above the real volume (low tens today) and
// only a runaway backstop; `truncated` reports honestly when it bites rather than silently
// returning a short list that reads as "nothing left to review".
const MAX_EXTRACTION_ROWS = 1000;

/**
 * The proposals on one extraction that a human could still act on.
 *
 * Four gates, mirroring cv-auto-apply.ts so the two modules can never disagree about what is
 * eligible — this is the same field population, minus the confidence gate:
 *   1. storage === "column" — jsonb/position_specific_fields has different merge semantics and
 *      stays out of both modules until that write path is deliberately designed.
 *   2. not an identity field — shared CV_IDENTITY_FIELD_KEYS. createCandidate owns identity, and
 *      intake sometimes MATCHES an existing candidate, so offering it here could repoint someone
 *      else's record and its dedupe norms.
 *   3. the proposal has a real value — null/empty is nothing to decide about. The declared field
 *      `type` is enforced against the runtime value so a malformed model response never reaches
 *      the UI as a boolean-shaped string.
 *   4. the candidate column is still blank — a value a human typed, or one auto-apply already
 *      wrote, is settled. The queue only ever surfaces genuine gaps.
 */
export function selectPendingReviewFields(input: {
  extractedFields: ReviewQueueExtractedFields | null | undefined;
  positionKey: string;
  candidate: Record<string, unknown>;
}): PendingReviewField[] {
  const schema = getCvPositionSchema(input.positionKey);
  if (!schema || !input.extractedFields) return [];

  const pending: PendingReviewField[] = [];
  for (const definition of schema.fields) {
    if (definition.storage !== "column") continue;
    if (CV_IDENTITY_FIELD_KEYS.has(definition.key)) continue;

    const proposal = input.extractedFields[definition.key];
    if (!proposal) continue;

    const value = proposal.value;
    if (value === null || value === undefined) continue;
    if (definition.type === "boolean" && typeof value !== "boolean") continue;
    if (definition.type === "string" && typeof value !== "string") continue;
    if (typeof value === "string" && value.trim().length === 0) continue;

    if (!isBlankCandidateValue(input.candidate[definition.key])) continue;

    pending.push({
      confidence: proposal.confidence,
      key: definition.key,
      label: definition.label,
      type: definition.type,
      value: typeof value === "string" ? value.trim() : value,
    });
  }
  return pending;
}

/**
 * Prefill for the review board, with anything the CANDIDATE already holds winning over the AI.
 *
 * The board renders every schema field and its save writes ALL of them, so whatever this function
 * puts in a slot is what gets persisted. That makes the prefill the only thing standing between a
 * review and the rest of the record, and seeding it purely from the extraction had two silent
 * failure modes on an existing candidate:
 *
 *   - a column the AI never extracted reached the board empty and was saved back as `null`,
 *     clearing a value a human had typed (updateCandidate treats an explicit null as "clear it");
 *   - a column the AI DID extract but that was already filled reached the board holding the AI's
 *     competing value, overwriting the human's on save.
 *
 * Neither is a decision the reviewer asked to make. selectPendingReviewFields deliberately surfaces
 * only blank columns (gate 4), so a filled column is already settled — the queue's own contract is
 * that it fills gaps and touches nothing else. Seeding from the candidate makes the default save a
 * no-op for everything already answered, while leaving each field editable on purpose.
 *
 * The identity triple keeps an unconditional override: it shows the stored identity even when that
 * is blank, so a reviewer can never save the CV's competing identity over the one createCandidate
 * resolved (choosing between the CV's and the sender's per identitySource) and derived the
 * national_id_norm/email_norm/phone_norm dedupe keys from.
 */
export function buildReviewBoardFields(input: {
  extractedFields: ReviewQueueExtractedFields | null | undefined;
  positionKey: string;
  candidate: Record<string, unknown>;
}): ReviewQueueExtractedFields {
  const fields: ReviewQueueExtractedFields = { ...(input.extractedFields ?? {}) };

  const schema = getCvPositionSchema(input.positionKey);
  for (const definition of schema?.fields ?? []) {
    // Same storage gate as selectPendingReviewFields — a jsonb field is not a candidate column,
    // so there is no stored column value to prefer over the proposal.
    if (definition.storage !== "column") continue;
    const stored = input.candidate[definition.key];
    if (isBlankCandidateValue(stored)) continue;
    // A stored value has to be board-shaped, then has to match the field's DECLARED type — the
    // same defence selectPendingReviewFields applies to a malformed proposal, for the same reason:
    // the board renders strings and booleans as different controls. (The first check is also what
    // narrows `stored` off `unknown`; the declared-type pair alone does not, because it turns on
    // `definition.type`.)
    if (typeof stored !== "string" && typeof stored !== "boolean") continue;
    if (definition.type === "boolean" && typeof stored !== "boolean") continue;
    if (definition.type === "string" && typeof stored !== "string") continue;
    // "high" because this is no longer the AI's guess — a stored value must not carry the
    // low-confidence "Check this" badge.
    fields[definition.key] = { confidence: "high", value: stored };
  }

  for (const key of CV_IDENTITY_FIELD_KEYS) {
    const stored = input.candidate[key];
    fields[key] = { confidence: "high", value: typeof stored === "string" ? stored : null };
  }
  return fields;
}

type ExtractionQueueDbRow = {
  id: unknown;
  candidate_id: unknown;
  position_key: unknown;
  extracted_fields: ReviewQueueExtractedFields | null;
  created_at: unknown;
};

/**
 * Candidates whose newest never-reviewed extraction still has something worth a human decision.
 *
 * Newest-unreviewed-per-candidate rather than every row: 7 of 24 candidates already carry multiple
 * extractions (a re-run makes another), and one worklist entry per candidate is what a reviewer
 * actually works through. Older unreviewed rows for the same candidate stay in the table untouched.
 */
export async function listCvReviewQueue(): Promise<CvReviewQueue> {
  const supabase = getSupabaseAdmin();

  const { data: extractionData, error: extractionError } = await supabase
    .from("ats_candidate_cv_extractions")
    .select("id, candidate_id, position_key, extracted_fields, created_at")
    .is("applied_fields", null)
    .not("candidate_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_EXTRACTION_ROWS);
  if (extractionError) throw extractionError;

  const extractionRows = (extractionData ?? []) as ExtractionQueueDbRow[];
  const truncated = extractionRows.length >= MAX_EXTRACTION_ROWS;

  // Rows arrive newest-first, so the first one seen for a candidate is the one to review.
  const newestByCandidate = new Map<string, ExtractionQueueDbRow>();
  for (const row of extractionRows) {
    const candidateId = String(row.candidate_id ?? "");
    if (!candidateId || newestByCandidate.has(candidateId)) continue;
    newestByCandidate.set(candidateId, row);
  }
  if (newestByCandidate.size === 0) {
    return { generatedAt: new Date().toISOString(), items: [], truncated };
  }

  const { data: candidateData, error: candidateError } = await supabase
    .from("ats_candidates")
    .select("*")
    .in("id", Array.from(newestByCandidate.keys()));
  if (candidateError) throw candidateError;

  const candidatesById = new Map<string, Candidate>();
  for (const row of (candidateData ?? []) as CandidateDbRow[]) {
    const candidate = mapCandidate(row);
    candidatesById.set(candidate.id, candidate);
  }

  const items: CvReviewQueueItem[] = [];
  for (const [candidateId, row] of newestByCandidate) {
    const candidate = candidatesById.get(candidateId);
    // A deleted candidate can leave its extraction behind; there is nothing to review then.
    if (!candidate) continue;

    const positionKey = String(row.position_key ?? "");
    const candidateRecord = candidate as unknown as Record<string, unknown>;
    const pendingFields = selectPendingReviewFields({
      candidate: candidateRecord,
      extractedFields: row.extracted_fields,
      positionKey,
    });
    if (pendingFields.length === 0) continue;

    items.push({
      boardFields: buildReviewBoardFields({
        candidate: candidateRecord,
        extractedFields: row.extracted_fields,
        positionKey,
      }),
      candidateId,
      candidateName: candidate.fullName,
      candidateSource: candidate.source,
      extractedAt: String(row.created_at ?? ""),
      extractionId: String(row.id ?? ""),
      pendingFields,
      positionKey,
    });
  }

  // Most fields waiting first — the reviewer's highest-yield record is at the top; ties break
  // on the older extraction so nothing lingers indefinitely behind a steady stream of new CVs.
  items.sort((a, b) => b.pendingFields.length - a.pendingFields.length || a.extractedAt.localeCompare(b.extractedAt));

  return { generatedAt: new Date().toISOString(), items, truncated };
}
