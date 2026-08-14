// Recruitment / ATS — read-only CV-extraction accuracy analytics.
//
// For every reviewed AI extraction (an ats_candidate_cv_extractions row where
// Talent Acquisition has actually saved a review — applied_fields is not null), diffs the
// AI's per-field proposal (extracted_fields) against what was actually kept (applied_fields).
// A field TA never had to correct means the AI is doing well on it; a high correction rate
// flags a field worth revisiting the schema's aiDescription/instructions for.
//
// The rate is measured ONLY over fields the AI actually proposed. extracted_fields carries an
// entry for every schema field including the ones the AI reported finding nothing for (the
// prompt instructs it to write value:null), and the review board saves every schema field —
// seeding the empty ones from the candidate record. Diffing those would book a "correction"
// every time a human filled a gap the AI never claimed to fill, which is the opposite of what
// this page is for. They are reported separately as notProposedCount instead of dropped.
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
  // Reviews where the AI actually proposed this field. This, NOT the number of reviews, is the
  // correction-rate denominator — see summarizeCvExtractionAccuracy.
  proposedCount: number;
  // Reviews where the AI proposed nothing for this field. Reported rather than dropped: a field
  // the AI never finds is its own signal, and hiding it would make proposedCount look arbitrary.
  notProposedCount: number;
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
  overallCorrectionRate: number; // 0..1, corrections / proposals across all reviewed rows
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

// Did the AI actually propose something for this field? Same definition of "a finding" as
// countProposedCvFields in cv-extraction-fields.ts: a boolean `false` IS a finding ("no medical
// rep experience"), only null / blank is nothing.
function isProposal(value: unknown): boolean {
  return normalizeForCompare(value) !== null;
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
    const fieldStats = new Map<string, { proposed: number; notProposed: number; corrected: number }>();
    for (const row of positionRows) {
      for (const [fieldKey, extracted] of Object.entries(row.extractedFields)) {
        const stats = fieldStats.get(fieldKey) ?? { corrected: 0, notProposed: 0, proposed: 0 };
        // A field the AI left empty is not something a human CORRECTED, whatever ends up saved in
        // it. The review board writes every schema field and seeds the empty ones from what the
        // candidate already has (seedReviewFieldsFromCandidate), so counting these would score the
        // AI as wrong on exactly the fields it honestly reported finding nothing for.
        if (!isProposal(extracted.value)) {
          stats.notProposed += 1;
        } else {
          stats.proposed += 1;
          if (!valuesEqual(extracted.value, row.appliedFields[fieldKey])) stats.corrected += 1;
        }
        fieldStats.set(fieldKey, stats);
      }
    }

    const fields: FieldAccuracyRow[] = Array.from(fieldStats.entries())
      .map(([fieldKey, stats]) => ({
        correctedCount: stats.corrected,
        correctionRate: stats.proposed > 0 ? stats.corrected / stats.proposed : 0,
        fieldKey,
        notProposedCount: stats.notProposed,
        proposedCount: stats.proposed,
      }))
      .sort((a, b) => b.correctionRate - a.correctionRate);

    for (const field of fields) {
      overallFieldChecks += field.proposedCount;
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
  id: string;
  position_key: string;
  extracted_fields: Record<string, { value: unknown; confidence: "high" | "low" }> | null;
  applied_fields: Record<string, unknown> | null;
};

export type CvExtractionAccuracyReport = CvExtractionAccuracyAnalytics & {
  generatedAt: string;
  rowsScanned: number;
  // True only if the safety cap below was reached, i.e. the numbers describe a prefix of the
  // reviews rather than all of them. The page must say so — a silently partial accuracy rate is
  // worse than no accuracy rate.
  truncated: boolean;
};

// PostgREST caps how many rows one response may return (db-max-rows), and this table only grows.
// An unpaged select would therefore start analysing a prefix of the reviews one day and present
// the result as if it were all of them, with nothing anywhere saying otherwise. Page by keyset on
// id — uuid ordering is total and unique, so no row is skipped or seen twice, and there is no
// OFFSET cost as the table grows.
const EXTRACTION_PAGE_SIZE = 1000;
const EXTRACTION_ROW_CAP = 50_000;

export async function getCvExtractionAccuracyAnalytics(): Promise<CvExtractionAccuracyReport> {
  const supabase = getSupabaseAdmin();
  const all: ExtractionRowDb[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (;;) {
    let query = supabase
      .from("ats_candidate_cv_extractions")
      .select("id, position_key, extracted_fields, applied_fields")
      .not("applied_fields", "is", null)
      .order("id", { ascending: true })
      .limit(EXTRACTION_PAGE_SIZE);
    if (cursor) query = query.gt("id", cursor);

    const { data, error } = await query;
    if (error) throw error;

    const page = (data ?? []) as ExtractionRowDb[];
    all.push(...page);
    if (page.length < EXTRACTION_PAGE_SIZE) break;
    if (all.length >= EXTRACTION_ROW_CAP) {
      truncated = true;
      break;
    }
    cursor = page[page.length - 1].id;
  }

  const rows: ExtractionReviewRow[] = all.map((row) => ({
    appliedFields: row.applied_fields ?? {},
    extractedFields: row.extracted_fields ?? {},
    positionKey: row.position_key,
  }));

  return {
    ...summarizeCvExtractionAccuracy(rows),
    generatedAt: new Date().toISOString(),
    rowsScanned: rows.length,
    truncated,
  };
}
