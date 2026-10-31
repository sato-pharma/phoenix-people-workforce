// TOTAL YEARS OF EXPERIENCE — HR's field (owner, 2026-10-31: "make the HR the one responsible for
// filling it"). All the years a person has worked in the role, at Sato and before. The Team Coaching
// Skills Survey reads it as "Years in Role"; nobody else types it.
//
// Two columns on `employees`: `total_experience_years` (0 to 60, one decimal) and
// `total_experience_as_of`, the Cairo day the number last changed, stamped by the trigger
// `employees_stamp_total_experience_as_of` — so the years keep counting from the day HR typed them.
//
// Read in its OWN query, never added to the directory's big select: a select that names a column the
// database does not have fails the whole read (42703), and the directory feeds nearly every page.
// This read fails soft — no figures, never a broken directory.

import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export { parseTotalExperienceYears, totalExperienceMaxYears } from "./total-experience-rules";

export type TotalExperience = {
  years: number;
  asOf: string | null;
};

type TotalExperienceDbRow = {
  hr_id: string;
  total_experience_years: number | string | null;
  total_experience_as_of: string | null;
};

/**
 * Every filled value, keyed by the canonical HR id. Only the rows HR has filled come back, so this
 * is a small read. An empty map when the columns are missing or the read fails.
 */
export async function readTotalExperienceByHrId(): Promise<Map<string, TotalExperience>> {
  const result = new Map<string, TotalExperience>();
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id,total_experience_years,total_experience_as_of")
      .not("total_experience_years", "is", null);
    if (error) {
      console.warn("[total-experience] read failed", error.code ?? "", error.message ?? "");
      return result;
    }
    for (const row of (data ?? []) as TotalExperienceDbRow[]) {
      const years = row.total_experience_years === null ? null : Number(row.total_experience_years);
      const key = canonicalHrIdKey(row.hr_id);
      if (key && years !== null && Number.isFinite(years)) {
        result.set(key, { asOf: row.total_experience_as_of ?? null, years });
      }
    }
  } catch (error) {
    console.warn("[total-experience] read failed", error instanceof Error ? error.message : String(error));
  }
  return result;
}

export function totalExperienceFor(
  byHrId: ReadonlyMap<string, TotalExperience>,
  hrId: string | null | undefined,
): TotalExperience | null {
  const key = canonicalHrIdKey(hrId);
  return key ? byHrId.get(key) ?? null : null;
}

/** Saves HR's value. The trigger stamps the as-of day. */
export async function saveTotalExperienceYears(hrId: string, years: number | null): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("employees")
    .update({ total_experience_years: years })
    .eq("hr_id", hrId);
  if (error) throw error;
}
