// Recruitment / ATS — every field on one candidate's record, grouped the way the CV schema groups it.
//
// The candidate page prints the WHOLE record, not the screening summary: identity, personal details,
// the job they hold, education, the full work and education history, certifications, skills,
// languages and the pharma block. It is driven off cv-field-schemas.ts, the same list the CV reader
// fills and the review board edits, so a field added to the schema appears on the page with no
// second list to keep in step.
//
// The reading rules are the ones the CV viewer's side panel (candidate-fields-panel.tsx) already
// uses, so the two never disagree about what is on file:
//   - a field with nothing on it is left out rather than printed as a dash; `false` is an answer
//     ("no prior experience") and stays;
//   - a field the schema marks irrelevant for this person (military service for a woman) says
//     "Irrelevant" rather than vanishing;
//   - a follow-up whose gate is not met (the medical rep employer, for someone with no rep
//     experience) is not asked.
//
// Pure, so it is tested without a browser and the client page carries no database import.

import {
  CV_FIELD_SECTIONS,
  fieldIsIrrelevant,
  type CvFieldDefinition,
  type CvPositionSchema,
  type CvSubFieldDefinition,
} from "@/lib/recruitment/cv-field-schemas";
import type { Candidate } from "@/lib/recruitment/types";

/** One "Label: value" line of one entry in a repeating block (one job, one qualification). */
export type CandidateRecordLine = { label: string; text: string };

export type CandidateRecordRow =
  | { key: string; label: string; kind: "text"; text: string }
  | { key: string; label: string; kind: "irrelevant" }
  | { key: string; label: string; kind: "entries"; entries: CandidateRecordLine[][] };

export type CandidateRecordSection = { key: string; label: string; rows: CandidateRecordRow[] };

type FieldValue = string | boolean | number | Array<Record<string, unknown>> | null;

function readFieldValue(candidate: Candidate, field: CvFieldDefinition): FieldValue {
  const raw =
    field.storage === "jsonb"
      ? candidate.positionSpecificFields?.[field.key]
      : (candidate as unknown as Record<string, unknown>)[field.key];

  if (field.type === "array") {
    if (!Array.isArray(raw)) return null;
    const entries = raw.filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
    return entries.length > 0 ? entries : null;
  }
  if (field.type === "boolean") return typeof raw === "boolean" ? raw : null;
  if (field.type === "number") return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function formatSubValue(subField: CvSubFieldDefinition, raw: unknown): string | null {
  if (subField.type === "boolean") return typeof raw === "boolean" ? (raw ? "Yes" : "No") : null;
  if (subField.type === "number") return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function isFieldAsked(candidate: Candidate, field: CvFieldDefinition, schema: CvPositionSchema): boolean {
  if (!field.showWhen) return true;
  const gate = schema.fields.find((entry) => entry.key === field.showWhen!.field);
  if (!gate) return true;
  return readFieldValue(candidate, gate) === field.showWhen.equals;
}

function rowFor(field: CvFieldDefinition, value: FieldValue): CandidateRecordRow | null {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) =>
        (field.itemFields ?? [])
          .map((subField) => ({ label: subField.label, text: formatSubValue(subField, entry[subField.key]) }))
          .filter((line): line is CandidateRecordLine => line.text !== null),
      )
      .filter((lines) => lines.length > 0);
    return entries.length > 0 ? { entries, key: field.key, kind: "entries", label: field.label } : null;
  }
  const text = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  return { key: field.key, kind: "text", label: field.label, text };
}

/**
 * The record, section by section, holding only what is on file.
 *
 * A section with nothing in it is dropped, so a thin record reads short instead of as a column of
 * empty headings. An empty list means nothing at all has been saved on this candidate.
 */
export function candidateRecordSections(candidate: Candidate, schema: CvPositionSchema): CandidateRecordSection[] {
  const valueOf = (fieldKey: string): string | null => {
    const gate = schema.fields.find((entry) => entry.key === fieldKey);
    if (!gate) return null;
    const raw = readFieldValue(candidate, gate);
    return typeof raw === "string" ? raw : null;
  };

  const sections: CandidateRecordSection[] = [];
  for (const section of CV_FIELD_SECTIONS) {
    const rows: CandidateRecordRow[] = [];
    for (const field of schema.fields) {
      if (field.section !== section.key || !isFieldAsked(candidate, field, schema)) continue;
      if (fieldIsIrrelevant(field, valueOf)) {
        rows.push({ key: field.key, kind: "irrelevant", label: field.label });
        continue;
      }
      const row = rowFor(field, readFieldValue(candidate, field));
      if (row) rows.push(row);
    }
    if (rows.length > 0) sections.push({ key: section.key, label: section.label, rows });
  }
  return sections;
}
