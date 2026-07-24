// Recruitment / ATS — read-only CV-extraction accuracy analytics.
//
// For every reviewed AI extraction (a recruitment_candidate_cv_extractions row where
// Talent Acquisition has actually saved a review — applied_fields is not null), diffs the
// AI's per-field proposal (extracted_fields) against what was actually kept (applied_fields).
// A field TA never had to correct means the AI is doing well on it; a high correction rate
// flags a field worth revisiting the schema's aiDescription/instructions for.
//
// Deliberately read-only and passive — this does not feed back into extraction behavior (see
// cv-field-schemas.ts for where that would live if ever built). Rollups are pure functions so
// they unit-test without a DB; only getCvExtractionAccuracyAnalytics touches Supabase.

import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ExtractionReviewRow = {
  positionKey: string;
  extractedFields: Record<string, { value: unknown; confidence: "high" | "low" }>;
  appliedFields: Record<string, unknown>;
};

export type FieldAccuracyRow = {
  fieldKey: string;
  totalReviewed: number;
  correctedCount: number;
  correctionRate: number; // 0..1
};

export type PositionAccuracy = {
  positionKey: string;
  totalReviewed: number;
  fields: FieldAccuracyRow[]; // sorted worst-first (highest correction rate first)
};

export type CvExtractionAccuracyAnalytics = {
  overallTotalReviewed: number;
  overallCorrectionRate: number; // 0..1, corrected field-checks / total field-checks across all reviewed rows
  byPosition: PositionAccuracy[];
};

// Reviewed CV files are already normalized (trimmed strings, real booleans) before being
// saved as applied_fields, but the AI's raw proposal may still carry surrounding whitespace —
// normalize both sides the same way so a whitespace-only "fix" doesn't count as a correction.
function normalizeForCompare(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * Pure aggregation — no I/O, unit-testable with plain fixture rows.
 */
export function summarizeCvExtractionAccuracy(rows: ExtractionReviewRow[]): CvExtractionAccuracyAnalytics {
  const rowsByPosition = new Map<string, ExtractionReviewRow[]>();
  for (const row of rows) {
    const list = rowsByPosition.get(row.positionKey) ?? [];
    list.push(row);
    rowsByPosition.set(row.positionKey, list);
  }

  const byPosition: PositionAccuracy[] = [];
  let overallFieldChecks = 0;
  let overallCorrections = 0;

  for (const [positionKey, positionRows] of rowsByPosition) {
    const fieldStats = new Map<string, { total: number; corrected: number }>();
    for (const row of positionRows) {
      for (const [fieldKey, extracted] of Object.entries(row.extractedFields)) {
        const stats = fieldStats.get(fieldKey) ?? { corrected: 0, total: 0 };
        stats.total += 1;
        if (!valuesEqual(extracted.value, row.appliedFields[fieldKey])) stats.corrected += 1;
        fieldStats.set(fieldKey, stats);
      }
    }

    const fields: FieldAccuracyRow[] = Array.from(fieldStats.entries())
      .map(([fieldKey, stats]) => ({
        correctedCount: stats.corrected,
        correctionRate: stats.total > 0 ? stats.corrected / stats.total : 0,
        fieldKey,
        totalReviewed: stats.total,
      }))
      .sort((a, b) => b.correctionRate - a.correctionRate);

    for (const field of fields) {
      overallFieldChecks += field.totalReviewed;
      overallCorrections += field.correctedCount;
    }

    byPosition.push({ fields, positionKey, totalReviewed: positionRows.length });
  }

  return {
    byPosition: byPosition.sort((a, b) => b.totalReviewed - a.totalReviewed),
    overallCorrectionRate: overallFieldChecks > 0 ? overallCorrections / overallFieldChecks : 0,
    overallTotalReviewed: rows.length,
  };
}

type ExtractionRowDb = {
  position_key: string;
  extracted_fields: Record<string, { value: unknown; confidence: "high" | "low" }> | null;
  applied_fields: Record<string, unknown> | null;
};

export async function getCvExtractionAccuracyAnalytics(): Promise<
  CvExtractionAccuracyAnalytics & { generatedAt: string }
> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("recruitment_candidate_cv_extractions")
    .select("position_key, extracted_fields, applied_fields")
    .not("applied_fields", "is", null);
  if (error) throw error;

  const rows: ExtractionReviewRow[] = ((data ?? []) as ExtractionRowDb[]).map((row) => ({
    appliedFields: row.applied_fields ?? {},
    extractedFields: row.extracted_fields ?? {},
    positionKey: row.position_key,
  }));

  return { ...summarizeCvExtractionAccuracy(rows), generatedAt: new Date().toISOString() };
}
