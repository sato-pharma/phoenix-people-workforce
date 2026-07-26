// Recruitment / ATS — read-only display of a candidate's currently-saved position fields, for
// comparing them against the source CV (see CvPreviewModal's sidePanel prop). Schema-driven off
// cv-field-schemas.ts, same field list the extraction/review flows use — this just renders
// whatever is on record now, it never talks to the extraction pipeline itself.

import type { Candidate } from "@/lib/recruitment/types";
import type { CvFieldDefinition, CvPositionSchema } from "@/lib/recruitment/cv-field-schemas";

function readFieldValue(candidate: Candidate, field: CvFieldDefinition): string | boolean | null {
  if (field.storage === "jsonb") {
    const value = candidate.positionSpecificFields?.[field.key];
    return typeof value === "string" || typeof value === "boolean" ? value : null;
  }
  const value = (candidate as unknown as Record<string, unknown>)[field.key];
  return typeof value === "string" || typeof value === "boolean" ? value : null;
}

function formatValue(field: CvFieldDefinition, value: string | boolean | null): string {
  if (field.type === "boolean") {
    if (value === true) return "Yes";
    if (value === false) return "No";
    return "Not stated";
  }
  return typeof value === "string" && value.trim() ? value : "—";
}

function isFieldVisible(candidate: Candidate, field: CvFieldDefinition, schema: CvPositionSchema): boolean {
  if (!field.showWhen) return true;
  const gate = schema.fields.find((entry) => entry.key === field.showWhen!.field);
  if (!gate) return true;
  return readFieldValue(candidate, gate) === field.showWhen.equals;
}

export function CandidateFieldsPanel({ candidate, schema }: { candidate: Candidate; schema: CvPositionSchema }) {
  const visibleFields = schema.fields.filter((field) => isFieldVisible(candidate, field, schema));

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">On record</p>
      <div className="space-y-3">
        {visibleFields.map((field) => (
          <div key={field.key}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{field.label}</p>
            <p className="text-sm text-slate-700">{formatValue(field, readFieldValue(candidate, field))}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
