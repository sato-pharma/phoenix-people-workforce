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

// Generic (keyed by whatever the position's schema declares) rather than a fixed 12-key
// type — a value is a string field's text or a boolean field's judgment; readStringField/
// readBoolField in cv-extraction.ts are the only code that needs to know which is which per key.
export type ExtractedCandidateFields = Record<string, ExtractedField<string | boolean | null>>;

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
export function normalizeStoredExtractionFields(raw: unknown): ExtractedCandidateFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const fields: ExtractedCandidateFields = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!("value" in record)) continue;
    const value = record.value;
    fields[key] = {
      confidence: record.confidence === "high" ? "high" : "low",
      value:
        typeof value === "string" ? (value.trim().length > 0 ? value.trim() : null) : typeof value === "boolean" ? value : null,
    };
  }
  return fields;
}

// How many fields the AI actually found, for the "N fields already read from this CV" prompt. A
// boolean `false` IS a finding ("no medical rep experience"), so only null/blank is uncounted.
export function countProposedCvFields(fields: ExtractedCandidateFields): number {
  return Object.values(fields).filter((field) => field && field.value !== null && field.value !== "").length;
}

function candidateFieldValue(candidate: Candidate, field: CvFieldDefinition): string | boolean | null {
  const raw =
    field.storage === "jsonb"
      ? (candidate.positionSpecificFields ?? {})[field.key]
      : (candidate as unknown as Record<string, unknown>)[field.key];
  if (field.type === "boolean") return typeof raw === "boolean" ? raw : null;
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
    if (proposed && proposed.value !== null && proposed.value !== "") continue;
    const current = candidateFieldValue(candidate, field);
    if (current === null) continue;
    // "high" = no low-confidence badge. This value is not an AI guess at all — it is what is
    // already saved on the candidate, shown so the reviewer can see (and keep) it.
    seeded[field.key] = { confidence: "high", value: current };
  }
  return seeded;
}
