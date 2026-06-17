import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { CoachingScoreItemKey } from "@/lib/coaching/constants";

/**
 * Historical coaching evaluations for reps who could not be matched to an active
 * employee at import time (typically resignations). Persisted so the coach's
 * effort — scores plus written development/strength notes — is never lost.
 *
 * Server-only: every read/write uses the service-role admin client.
 */

export type CoachingArchivedEvaluationInput = {
  areaOfDevelopment?: string | null;
  claimedHrId?: string | null;
  coachHrId?: string | null;
  coachingDate?: string | null;
  coachingQuarter?: number | null;
  coachingYear?: number | null;
  createdBy?: string | null;
  generalRemarks?: string | null;
  importBatchId?: string | null;
  overallScore?: number | null;
  performanceBand?: string | null;
  repCode?: string | null;
  repName?: string | null;
  scores: Partial<Record<CoachingScoreItemKey, number>>;
  sourceFile?: string | null;
  sourceName: string;
  strengthPoints?: string | null;
  territory?: string | null;
  unmatchedReason?: string | null;
};

export type CoachingArchivedEvaluationRow = {
  area_of_development: string | null;
  claimed_hr_id: string | null;
  coach_hr_id: string | null;
  coaching_date: string | null;
  coaching_quarter: number | null;
  coaching_year: number | null;
  created_at: string;
  created_by: string | null;
  general_remarks: string | null;
  id: string;
  import_batch_id: string | null;
  overall_score: number | string | null;
  performance_band: string | null;
  rep_code: string | null;
  rep_name: string | null;
  scores: Record<string, number>;
  source_file: string | null;
  source_name: string;
  strength_points: string | null;
  territory: string | null;
  unmatched_reason: string | null;
};

export type CoachingArchivedEvaluationFilters = {
  importBatchId?: string | null;
  limit?: number | null;
  quarter?: number | null;
  year?: number | null;
};

const ARCHIVE_TABLE = "coaching_archived_evaluations";

function cleanText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function toRowInsert(input: CoachingArchivedEvaluationInput) {
  return {
    area_of_development: cleanText(input.areaOfDevelopment),
    claimed_hr_id: cleanText(input.claimedHrId),
    coach_hr_id: cleanText(input.coachHrId),
    coaching_date: cleanText(input.coachingDate),
    coaching_quarter: input.coachingQuarter ?? null,
    coaching_year: input.coachingYear ?? null,
    created_by: cleanText(input.createdBy),
    general_remarks: cleanText(input.generalRemarks),
    import_batch_id: cleanText(input.importBatchId),
    overall_score: input.overallScore ?? null,
    performance_band: cleanText(input.performanceBand),
    rep_code: cleanText(input.repCode),
    rep_name: cleanText(input.repName),
    scores: input.scores ?? {},
    source_file: cleanText(input.sourceFile),
    source_name: input.sourceName,
    strength_points: cleanText(input.strengthPoints),
    territory: cleanText(input.territory),
    unmatched_reason: cleanText(input.unmatchedReason),
  };
}

export async function insertArchivedCoachingEvaluations(
  inputs: CoachingArchivedEvaluationInput[],
): Promise<CoachingArchivedEvaluationRow[]> {
  if (inputs.length === 0) return [];
  const { data, error } = await getSupabaseAdmin()
    .from(ARCHIVE_TABLE)
    .insert(inputs.map(toRowInsert))
    .select("*");
  if (error) throw error;
  return (data ?? []) as CoachingArchivedEvaluationRow[];
}

export async function listArchivedCoachingEvaluations(
  filters: CoachingArchivedEvaluationFilters = {},
): Promise<CoachingArchivedEvaluationRow[]> {
  let query = getSupabaseAdmin()
    .from(ARCHIVE_TABLE)
    .select("*")
    .order("coaching_year", { ascending: false, nullsFirst: false })
    .order("coaching_quarter", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (filters.year != null) query = query.eq("coaching_year", filters.year);
  if (filters.quarter != null) query = query.eq("coaching_quarter", filters.quarter);
  if (filters.importBatchId) query = query.eq("import_batch_id", filters.importBatchId);
  if (filters.limit != null) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CoachingArchivedEvaluationRow[];
}

/**
 * De-dup key set ("<source_name>|<coaching_date>") for already-archived rows, so a
 * re-run of the importer does not create duplicate archive entries.
 */
export async function loadArchivedEvaluationKeys(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin()
    .from(ARCHIVE_TABLE)
    .select("source_name, coaching_date");
  if (error) throw error;
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{ coaching_date: string | null; source_name: string }>) {
    keys.add(archivedEvaluationKey(row.source_name, row.coaching_date));
  }
  return keys;
}

export function archivedEvaluationKey(sourceName: string, coachingDate: string | null | undefined) {
  return `${sourceName.trim().toLowerCase()}|${(coachingDate ?? "").slice(0, 10)}`;
}
