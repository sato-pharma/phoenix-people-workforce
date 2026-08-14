// Recruitment / ATS — read-only display of a candidate's currently-saved fields, for comparing
// them against the source CV (see CvPreviewModal's sidePanel prop). Schema-driven off
// cv-field-schemas.ts, same field list the extraction/review flows use — this just renders
// whatever is on record now, it never talks to the extraction pipeline itself.
//
// Grouped by section rather than listed flat: the universal schema carries 36 fields where the old
// Medical Rep template carried 12, and an unbroken 36-row list is not readable next to a CV.
// Sections a candidate has nothing under are omitted entirely, so a sparse CV still reads short.

import type { Candidate } from "@/lib/recruitment/types";
import {
  CV_FIELD_SECTIONS,
  type CvFieldDefinition,
  type CvPositionSchema,
  type CvSubFieldDefinition,
} from "@/lib/recruitment/cv-field-schemas";

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
  return typeof raw === "string" ? raw : null;
}

function formatValue(field: CvFieldDefinition, value: FieldValue): string {
  if (field.type === "boolean") {
    if (value === true) return "Yes";
    if (value === false) return "No";
    return "Not stated";
  }
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value : "—";
}

// One sub-field of one block entry. Rendered as "Label: value" on its own line rather than as a
// nested grid — the side panel is narrow, and a table here would either wrap mid-word or truncate.
function formatSubValue(subField: CvSubFieldDefinition, raw: unknown): string | null {
  if (subField.type === "boolean") return typeof raw === "boolean" ? (raw ? "Yes" : "No") : null;
  if (subField.type === "number") return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function isFieldVisible(candidate: Candidate, field: CvFieldDefinition, schema: CvPositionSchema): boolean {
  if (!field.showWhen) return true;
  const gate = schema.fields.find((entry) => entry.key === field.showWhen!.field);
  if (!gate) return true;
  return readFieldValue(candidate, gate) === field.showWhen.equals;
}

// A field with nothing on record is hidden rather than shown as an em dash. With 36 fields, a
// column of dashes buries the handful the recruiter is actually looking at. `false` is a real
// answer ("no prior experience") and stays visible.
function hasValue(value: FieldValue): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function BlockEntries({ entries, itemFields }: { entries: Array<Record<string, unknown>>; itemFields: CvSubFieldDefinition[] }) {
  return (
    <div className="mt-1 space-y-2">
      {entries.map((entry, index) => {
        const lines = itemFields
          .map((subField) => ({ subField, text: formatSubValue(subField, entry[subField.key]) }))
          .filter((line): line is { subField: CvSubFieldDefinition; text: string } => line.text !== null);
        if (lines.length === 0) return null;
        return (
          <div key={index} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
            {lines.map(({ subField, text }) => (
              <p key={subField.key} className="text-xs text-slate-700">
                <span className="font-medium text-slate-500">{subField.label}:</span> {text}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function CandidateFieldsPanel({ candidate, schema }: { candidate: Candidate; schema: CvPositionSchema }) {
  const populated = schema.fields
    .filter((field) => isFieldVisible(candidate, field, schema))
    .map((field) => ({ field, value: readFieldValue(candidate, field) }))
    .filter(({ value }) => hasValue(value));

  return (
    <div className="space-y-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">On record</p>

      {populated.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing saved on this candidate yet.</p>
      ) : (
        CV_FIELD_SECTIONS.map((section) => {
          const rows = populated.filter(({ field }) => field.section === section.key);
          if (rows.length === 0) return null;
          return (
            <div key={section.key} className="space-y-3">
              <p className="border-b border-slate-200 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {section.label}
              </p>
              {rows.map(({ field, value }) => (
                <div key={field.key}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{field.label}</p>
                  {field.type === "array" && Array.isArray(value) ? (
                    <BlockEntries entries={value} itemFields={field.itemFields ?? []} />
                  ) : (
                    <p className="text-sm text-slate-700">{formatValue(field, value)}</p>
                  )}
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}
