// Recruitment / ATS — read-only display of a candidate's currently-saved fields, for comparing
// them against the source CV (see CvPreviewModal's sidePanel prop). Schema-driven off
// cv-field-schemas.ts, same field list the extraction/review flows use — this just renders
// whatever is on record now, it never talks to the extraction pipeline itself.
//
// Grouped by section rather than listed flat: the universal schema carries 36 fields where the old
// Medical Rep template carried 12, and an unbroken 36-row list is not readable next to a CV.
// Sections a candidate has nothing under are omitted entirely, so a sparse CV still reads short.
//
// THE LOOK (2026-10-19 premium sweep): each section opens on the module's orange tick and a hairline,
// each field is a micro-caps label over its value, and a repeated block (jobs, courses) sits in a
// square recessed tray so one entry cannot run into the next. Everything wraps — the panel is narrow
// and sits beside a CV, so nothing in it may push the viewer sideways.

import { ClipboardList } from "lucide-react";

import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { RecruitmentEmptyState } from "@/components/recruitment/recruitment-premium";
import type { Candidate } from "@/lib/recruitment/types";
import {
  CV_FIELD_SECTIONS,
  fieldIsIrrelevant,
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
    <div className="mt-1.5 space-y-2">
      {entries.map((entry, index) => {
        const lines = itemFields
          .map((subField) => ({ subField, text: formatSubValue(subField, entry[subField.key]) }))
          .filter((line): line is { subField: CvSubFieldDefinition; text: string } => line.text !== null);
        if (lines.length === 0) return null;
        return (
          <div
            key={index}
            className={`space-y-0.5 border border-slate-200 border-l-2 border-l-slate-400 bg-slate-50 px-2.5 py-2 ${adminRecessedDepthClassName}`}
          >
            {lines.map(({ subField, text }) => (
              <p key={subField.key} className="break-words text-xs leading-5 text-slate-700" dir="auto">
                <span className="font-semibold text-slate-500">{subField.label}:</span> {text}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function CandidateFieldsPanel({ candidate, schema }: { candidate: Candidate; schema: CvPositionSchema }) {
  // Reads another field's saved string value, so `irrelevantWhen` can test it (e.g. gender).
  const valueOf = (fieldKey: string): string | null => {
    const gate = schema.fields.find((entry) => entry.key === fieldKey);
    if (!gate) return null;
    const raw = readFieldValue(candidate, gate);
    return typeof raw === "string" ? raw : null;
  };
  const populated = schema.fields
    .filter((field) => isFieldVisible(candidate, field, schema))
    .map((field) => ({ field, irrelevant: fieldIsIrrelevant(field, valueOf), value: readFieldValue(candidate, field) }))
    // An irrelevant field is shown as "Irrelevant" even when empty — otherwise every female
    // candidate would simply be missing the Military status row, which is what the owner asked to
    // make explicit. Relevant fields keep hiding when blank.
    .filter(({ irrelevant, value }) => irrelevant || hasValue(value));

  return (
    <div className="space-y-5">
      <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
        <ClipboardList aria-hidden="true" className="h-3.5 w-3.5 text-orange-600" />
        On record
      </p>

      {populated.length === 0 ? (
        <RecruitmentEmptyState
          icon={<ClipboardList aria-hidden="true" className="h-5 w-5" />}
          message="Nothing saved on this candidate yet."
          title="No fields on record"
        />
      ) : (
        CV_FIELD_SECTIONS.map((section) => {
          const rows = populated.filter(({ field }) => field.section === section.key);
          if (rows.length === 0) return null;
          return (
            <div key={section.key} className="space-y-3">
              <p className="flex items-center gap-2 border-b border-slate-200 pb-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-slate-700">
                <span aria-hidden="true" className="h-3 w-0.5 bg-orange-500" />
                {section.label}
              </p>
              {rows.map(({ field, irrelevant, value }) => (
                <div key={field.key} className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{field.label}</p>
                  {irrelevant ? (
                    <p className="mt-0.5 text-sm italic text-slate-400">Irrelevant</p>
                  ) : field.type === "array" && Array.isArray(value) ? (
                    <BlockEntries entries={value} itemFields={field.itemFields ?? []} />
                  ) : (
                    <p className="mt-0.5 break-words text-sm font-medium leading-snug text-slate-800" dir="auto">
                      {formatValue(field, value)}
                    </p>
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
