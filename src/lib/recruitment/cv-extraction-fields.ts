// Recruitment / ATS — the extracted-field shape and the pure logic around it.
//
// Split out of cv-extraction.ts for the same reason cv-field-schemas.ts is: that module pulls in
// pdf-parse, mammoth, the OpenAI client and the Supabase admin client, so a "use client" component
// can only ever import TYPES from it. The candidate profile needs to render and seed a stored
// proposal in the browser, which needs real functions — so the isomorphic half lives here (no DB,
// AI, or Node imports) and cv-extraction.ts re-exports the types it used to own.

import type { CvFieldDefinition, CvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import type { Candidate } from "@/lib/recruitment/types";

export type ExtractedFieldConfidence = "high" | "low";
export type ExtractedField<T> = { value: T; confidence: ExtractedFieldConfidence };

// One extracted value. A scalar field yields text (a YYYY-MM-DD date included), a boolean
// judgment, or a number; a repeating block (workHistory, educationHistory, certifications,
// skills, languages) yields an array of entry objects shaped by that field's `itemFields`.
// readSchemaField in cv-extraction.ts is the only code that needs to know which is which per key.
export type ExtractedCvValue = string | boolean | number | Array<Record<string, unknown>> | null;

// Generic (keyed by whatever the schema declares) rather than a fixed key list — the universal
// schema is edited as data, so nothing here changes when a field is added.
export type ExtractedCandidateFields = Record<string, ExtractedField<ExtractedCvValue>>;

// One stored row of ats_candidate_cv_extractions, read back for review.
export type StoredCvExtraction = {
  extractionId: string;
  positionKey: string;
  model: string | null;
  fields: ExtractedCandidateFields;
  createdAt: string | null;
  // applied_fields is written only when a reviewer saves (recordAppliedExtractionFields), so this
  // is exactly "has a human already accepted or corrected this proposal".
  reviewed: boolean;
};

// extracted_fields is jsonb, so a row written by an older shape (or edited by hand) may hold
// anything — keep only entries shaped like the {value, confidence} pair the review board renders,
// and collapse blank strings to null so they don't read as findings.
//
// Arrays and numbers must survive this pass. Until 2026-08-14 anything that was not a string or a
// boolean was flattened to null here, which was harmless while the schema held only those two
// types — but the universal schema stores repeating blocks (workHistory and friends) as arrays and
// graduationYear as a number, and a value dropped on read-back is indistinguishable from a value
// the AI never found.
export function normalizeStoredExtractionFields(raw: unknown): ExtractedCandidateFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields: ExtractedCandidateFields = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!("value" in record)) continue;
    fields[key] = {
      confidence: record.confidence === "high" ? "high" : "low",
      value: normalizeStoredValue(record.value),
    };
  }
  return fields;
}

function normalizeStoredValue(value: unknown): ExtractedCvValue {
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "boolean") return value;
  // NaN/Infinity round-trip through jsonb as null anyway; reject them so they never reach a column.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // A repeating block. Non-object entries are dropped rather than coerced — a block entry is a
  // record of sub-fields, and a bare string in that position means the row is malformed, not that
  // it holds one unnamed value.
  if (Array.isArray(value)) {
    const entries = value.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
    return entries.length > 0 ? entries : null;
  }
  return null;
}

// How many fields the AI actually found, for the "N fields already read from this CV" prompt. A
// boolean `false` IS a finding ("no medical rep experience"), so only null/blank is uncounted —
// and an empty repeating block counts as blank, matching isRealFinding below. No schema is
// available here, so this cannot check declared types; countUnappliedCvFields is the one that
// drives anything a human is asked to act on.
export function countProposedCvFields(fields: ExtractedCandidateFields): number {
  return Object.values(fields).filter((field) => {
    if (!field || field.value === null || field.value === "") return false;
    if (Array.isArray(field.value)) return field.value.length > 0;
    return true;
  }).length;
}

// How many of the AI's findings are still MISSING from the candidate — the number a reviewer
// actually has to act on.
//
// This, not countProposedCvFields, is what a human-facing prompt must report. Inbound intake
// auto-applies the high-confidence, column-storage findings (cv-auto-apply.ts) without writing
// applied_fields, deliberately, so the analytics keep measuring only real human corrections. The
// consequence is that "has anyone reviewed this" and "is there anything left to review" are
// different questions: counting raw findings would announce work that intake already did, on every
// inbound candidate, forever.
export function countUnappliedCvFields(
  fields: ExtractedCandidateFields,
  candidate: Candidate,
  schema: CvPositionSchema,
): number {
  let count = 0;
  for (const field of schema.fields) {
    const proposed = fields[field.key];
    if (!proposed || !isRealFinding(proposed.value, field)) continue;
    if (candidateFieldValue(candidate, field) === null) count += 1;
  }
  return count;
}

// Whether a proposal is something a human could still act on. Two gates, each closing a permanent
// nag — a count that can NEVER reach zero, because nothing downstream is able to clear it.
//
//   • An EMPTY repeating block is not a finding. readArrayField returns {confidence:"high",
//     value: []} for a CV that lists no certifications, which is the honest answer. But
//     selectAutoApplyFields skips empty arrays and selectPendingReviewFields skips arrays
//     entirely, so an empty block counted here would be reported as outstanding forever. Worse,
//     it made the intake NOTIFICATION disagree with the profile: the notification counts the
//     fresh extraction (where the value is []), while the profile banner counts the STORED row,
//     which normalizeStoredValue collapses to null. Up to 5 phantom fields per CV.
//   • A proposal whose runtime type contradicts its DECLARED type is not a finding either.
//     Auto-apply rejects it, so counting it here promises a reviewer work the UI will never offer
//     them. (A fresh extraction cannot produce one — readSchemaField dispatches per declared type —
//     but a legacy or hand-edited jsonb row can.)
function isRealFinding(value: ExtractedCvValue, field: CvFieldDefinition): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (field.type === "array") return Array.isArray(value) && value.length > 0;
  if (Array.isArray(value)) return false;
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  // "date" values are YYYY-MM-DD strings, so they share the string check.
  return typeof value === "string" && value.trim().length > 0;
}

// What the candidate already holds for one schema field, in the same shape an extraction proposes
// it — so "is this already saved" is one comparison for every field type.
//
// The per-type reads matter for the count and the seed alike: a repeating block that read as null
// here would be reported as unapplied on every visit and would never be seeded into the review
// board, so a reviewer's saved work history would be blanked by the next save.
function candidateFieldValue(candidate: Candidate, field: CvFieldDefinition): ExtractedCvValue {
  const raw =
    field.storage === "jsonb"
      ? (candidate.positionSpecificFields ?? {})[field.key]
      : (candidate as unknown as Record<string, unknown>)[field.key];
  if (field.type === "boolean") return typeof raw === "boolean" ? raw : null;
  if (field.type === "number") return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (field.type === "array") return normalizeStoredValue(Array.isArray(raw) ? raw : null);
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

// The review board's save writes EVERY schema field, including the ones it shows as empty — so
// handing it a bare extraction would blank whatever the candidate already has that this CV didn't
// mention (a direct WhatsApp applicant's phone comes from the sender, and no CV field would
// restore it). Seeding empty slots from the saved record makes "save" mean "apply the AI's
// findings on top of what we know", never "replace the record with what one PDF happened to say".
export function seedReviewFieldsFromCandidate(
  fields: ExtractedCandidateFields,
  candidate: Candidate,
  schema: CvPositionSchema,
): ExtractedCandidateFields {
  const seeded: ExtractedCandidateFields = { ...fields };
  for (const field of schema.fields) {
    const proposed = seeded[field.key];
    // isRealFinding, not a bare null check: a re-extraction that returns an EMPTY work history
    // would otherwise read as "the AI answered", the stored history would not be seeded, and the
    // save would blank a history a human had corrected. Same reason the queue's
    // buildReviewBoardFields prefers the stored block.
    if (proposed && isRealFinding(proposed.value, field)) continue;
    const current = candidateFieldValue(candidate, field);
    if (current === null) continue;
    // "high" = no low-confidence badge. This value is not an AI guess at all — it is what is
    // already saved on the candidate, shown so the reviewer can see (and keep) it.
    seeded[field.key] = { confidence: "high", value: current };
  }
  return seeded;
}
