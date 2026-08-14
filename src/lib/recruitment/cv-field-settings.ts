// Recruitment / ATS — the per-field include/exclude switch for CV extraction.
//
// The owner's rule is "capture everything", so ENABLED IS THE DEFAULT and the backing table
// records only deviations: a field with no row in ats_cv_field_settings is on. A fresh database
// therefore needs no seeding, and a field added to the schema later is live immediately.
//
// Disabling a field removes it from the AI request schema itself, not just from the UI — an
// off field costs no output tokens and cannot come back as a half-populated value nobody reads.

import { recruitmentDb } from "@/lib/recruitment/db";
import {
  universalCvFields,
  type CvFieldDefinition,
  type CvPositionSchema,
} from "@/lib/recruitment/cv-field-schemas";
import { CV_IDENTITY_FIELD_KEYS } from "@/lib/recruitment/cv-auto-apply";

export type CvFieldSetting = {
  fieldKey: string;
  enabled: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

// Identity fields can never be switched off. Candidate matching (national ID, else email OR phone
// — see candidate-matching.ts) is built on them, and the dedupe partial-unique indexes behind it
// assume they are populated. Turning fullName off would make every inbound CV a new candidate.
export const UNDISABLEABLE_CV_FIELD_KEYS: ReadonlySet<string> = CV_IDENTITY_FIELD_KEYS;

export function isUndisableableCvField(key: string): boolean {
  return UNDISABLEABLE_CV_FIELD_KEYS.has(key);
}

// Reads the deviation rows. A stale key — a field that was disabled and has since been removed
// from the schema — is ignored rather than treated as an error, so a schema edit never has to be
// paired with a data cleanup.
export async function listCvFieldSettings(): Promise<Map<string, boolean>> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase.from("ats_cv_field_settings").select("field_key,enabled");
  if (error) throw error;

  const known = new Set(universalCvFields.map((field) => field.key));
  const settings = new Map<string, boolean>();
  for (const row of data ?? []) {
    const key = String((row as { field_key?: unknown }).field_key ?? "");
    if (!key || !known.has(key)) continue;
    settings.set(key, Boolean((row as { enabled?: unknown }).enabled));
  }
  return settings;
}

// The full field list annotated with its current state — what the settings page renders.
export async function listCvFieldSettingsView(): Promise<
  Array<CvFieldDefinition & { enabled: boolean; locked: boolean }>
> {
  const settings = await listCvFieldSettings();
  return universalCvFields.map((field) => ({
    ...field,
    enabled: isUndisableableCvField(field.key) ? true : (settings.get(field.key) ?? true),
    locked: isUndisableableCvField(field.key),
  }));
}

export function applyCvFieldSettings(
  fields: CvFieldDefinition[],
  settings: Map<string, boolean>,
): CvFieldDefinition[] {
  return fields.filter((field) => {
    if (isUndisableableCvField(field.key)) return true;
    return settings.get(field.key) ?? true;
  });
}

// The schema actually sent to the model. Falls back to the full field list if the settings table
// cannot be read — a settings outage must degrade to capturing MORE, never to silently capturing
// less, because a field missing from an extraction is invisible after the fact.
export async function resolveEffectiveCvSchema(schema: CvPositionSchema): Promise<CvPositionSchema> {
  let settings: Map<string, boolean>;
  try {
    settings = await listCvFieldSettings();
  } catch {
    return schema;
  }

  const fields = applyCvFieldSettings(schema.fields, settings);
  if (fields.length === schema.fields.length) return schema;
  return { ...schema, fields };
}

export async function setCvFieldEnabled(
  fieldKey: string,
  enabled: boolean,
  actorHrId: string | null,
): Promise<void> {
  const known = universalCvFields.some((field) => field.key === fieldKey);
  if (!known) throw new Error(`Unknown CV extraction field "${fieldKey}".`);
  if (!enabled && isUndisableableCvField(fieldKey)) {
    throw new Error(
      `"${fieldKey}" cannot be switched off — candidate matching and duplicate detection depend on it.`,
    );
  }

  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_cv_field_settings").upsert(
    {
      enabled,
      field_key: fieldKey,
      updated_at: new Date().toISOString(),
      updated_by: actorHrId,
    },
    { onConflict: "field_key" },
  );
  if (error) throw error;
}
