// Recruitment / ATS — the shape a rule returns, and what "confidence" is allowed to mean here.
//
// The rule engine emits the SAME {value, confidence} pairs the AI path emits
// (ExtractedCandidateFields), which is the design decision the whole module rests on: the review
// board, auto-apply, the unapplied-field count and the stored jsonb row all keep working with no
// change, and a rule result and an AI result can be merged, compared or swapped freely.
//
// Confidence is a promise about PROVENANCE, not a mood:
//   • "high" — the value was READ from the document by an exact rule (a regex matched a real
//     address; a dictionary matched a whole word inside the right section). Auto-apply may write
//     these to candidate columns without a human.
//   • "low"  — the value was INFERRED (a name guessed from typography, a title taken from the first
//     job, years of experience computed from date arithmetic). A human, or the later AI pass,
//     should confirm it.
//
// Getting this line wrong in the optimistic direction is the expensive mistake: an auto-applied
// wrong phone number is a candidate nobody can call, and it looks exactly like a right one.

import type { ExtractedCandidateFields, ExtractedCvValue, ExtractedField } from "@/lib/recruitment/cv-extraction-fields";

export function high<T extends ExtractedCvValue>(value: T): ExtractedField<T> {
  return { confidence: "high", value };
}

export function low<T extends ExtractedCvValue>(value: T): ExtractedField<T> {
  return { confidence: "low", value };
}

/**
 * Collects field results, ignoring anything empty.
 *
 * Silently dropping a null is right here and only here: a rule that finds nothing must leave the
 * slot ABSENT rather than write `null` into it, because an absent slot is what lets the AI
 * enhancement pass (and `seedReviewFieldsFromCandidate`) fill it later. A stored `null` reads as
 * "answered: nothing", which would block both.
 */
export class FieldCollector {
  private readonly fields: ExtractedCandidateFields = {};

  set(key: string, field: ExtractedField<ExtractedCvValue> | null | undefined): void {
    if (!field) return;
    const { value } = field;
    if (value === null || value === undefined) return;
    if (typeof value === "string" && value.trim().length === 0) return;
    if (Array.isArray(value) && value.length === 0) return;
    this.fields[key] = field;
  }

  /** Sets only if nothing better is already there — first writer wins. */
  setIfAbsent(key: string, field: ExtractedField<ExtractedCvValue> | null | undefined): void {
    if (this.fields[key]) return;
    this.set(key, field);
  }

  has(key: string): boolean {
    return Boolean(this.fields[key]);
  }

  value(key: string): ExtractedCvValue | undefined {
    return this.fields[key]?.value;
  }

  build(): ExtractedCandidateFields {
    return { ...this.fields };
  }
}
