import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { ContractManagerRecommendation, ContractManagerRecommendationValue } from "./types";

/**
 * The one door to public.contract_renewal_manager_recommendations. It decides nothing about who may
 * read or write — src/lib/contracts/manager-recommendation.ts does, before it calls here.
 */

const TABLE = "contract_renewal_manager_recommendations";
const DATE_CHUNK = 50;

type RecommendationDbRow = {
  employee_hr_id: string;
  renewal_date: string;
  recommender_hr_id: string;
  recommendation: ContractManagerRecommendationValue;
  note: string | null;
  updated_at: string;
};

/** The key one employee's renewal is filed under: the canonical HR id and the renewal date. */
export function recommendationKey(employeeHrId: string | null | undefined, renewalDate: string | null | undefined) {
  return `${canonicalHrIdKey(employeeHrId) ?? ""}|${String(renewalDate ?? "").slice(0, 10)}`;
}

/**
 * Every recommendation recorded for the given renewal dates, grouped by recommendationKey and newest
 * first. Read by DATE (a handful of distinct days) and matched to employees here, so a board of a few
 * hundred people is one or two requests, not one per person.
 */
export async function loadManagerRecommendations(
  renewalDates: Iterable<string>,
): Promise<Map<string, ContractManagerRecommendation[]>> {
  const dates = [...new Set([...renewalDates].map((value) => String(value ?? "").slice(0, 10)).filter(Boolean))];
  const grouped = new Map<string, ContractManagerRecommendation[]>();
  if (dates.length === 0) return grouped;

  const rows: RecommendationDbRow[] = [];
  for (let start = 0; start < dates.length; start += DATE_CHUNK) {
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .select("employee_hr_id, renewal_date, recommender_hr_id, recommendation, note, updated_at")
      .in("renewal_date", dates.slice(start, start + DATE_CHUNK));
    if (error) throw error;
    rows.push(...((data ?? []) as RecommendationDbRow[]));
  }
  if (rows.length === 0) return grouped;

  const names = await namesByHrId(rows.map((row) => row.recommender_hr_id));
  for (const row of rows) {
    const key = recommendationKey(row.employee_hr_id, row.renewal_date);
    const list = grouped.get(key) ?? [];
    list.push({
      employeeHrId: row.employee_hr_id,
      note: row.note,
      recommendation: row.recommendation,
      recommenderHrId: row.recommender_hr_id,
      recommenderName: names.get(row.recommender_hr_id),
      renewalDate: String(row.renewal_date).slice(0, 10),
      updatedAt: row.updated_at,
    });
    grouped.set(key, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  return grouped;
}

/** One manager's answer for one renewal date; a second answer from the same manager replaces the first. */
export async function saveManagerRecommendation(input: {
  employeeHrId: string;
  renewalDate: string;
  recommenderHrId: string;
  recommendation: ContractManagerRecommendationValue;
  note: string | null;
}) {
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(
      {
        employee_hr_id: input.employeeHrId,
        note: input.note,
        recommendation: input.recommendation,
        recommender_hr_id: input.recommenderHrId,
        renewal_date: input.renewalDate,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "employee_hr_id,renewal_date,recommender_hr_id" },
    );
  if (error) throw error;
}
