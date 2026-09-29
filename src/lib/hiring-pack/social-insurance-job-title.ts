/**
 * The Arabic job title an employee is filed under with the Social Insurance Authority —
 * "المسمى الوظيفى فى التأمينات الاجتماعية".
 *
 * IT IS NOT A NEW FIELD. The owner was asked directly on 2026-09-29 whether the insurance title is
 * the one Phoenix already prints, and answered that it is: this is
 * `employee_hiring_profile.job_title_ar`, the value the contract, Form 1, the custody receipt, the
 * clearance and the labour forms all carry. So the Employee Master surfaces THAT value rather than
 * storing a second one that could disagree with the paperwork.
 *
 * WHY IT IS ITS OWN MODULE. The hiring pack's own reader loads the whole profile one employee at a
 * time, and its writer (`saveHiringPackProfile`) upserts every column of that row — either would be
 * wrong for a sheet covering hundreds of people and touching one field. These two functions do the
 * narrow thing: read the titles in bulk, and write ONLY the title, leaving the rest of somebody's
 * hiring profile exactly as HR typed it.
 */

import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type ProfileTitleRow = { hr_id: string; job_title_ar: string | null };

/** PostgREST folds every `.in()` value into the URL — the size this repository uses everywhere. */
const CHUNK = 50;

function cleanTitle(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * HR id -> insurance job title, for the ids given.
 *
 * KEYED THE WAY THE CALLER SPELLS ITS IDS. `employee_hiring_profile.hr_id` is written through
 * `canonicalHrIdForDisplay`, and the employee directory is not, so a raw map from the database
 * misses rows whenever the two spellings differ in case. The lookup is therefore built on
 * `canonicalHrIdKey` and re-keyed onto the caller's own ids before it is returned.
 */
export async function loadSocialInsuranceJobTitles(
  hrIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const wanted = hrIds.filter((hrId) => Boolean(hrId));
  if (wanted.length === 0) return out;

  const lookupIds = Array.from(
    new Set(wanted.map((hrId) => canonicalHrIdForDisplay(hrId)).filter((hrId): hrId is string => Boolean(hrId))),
  );

  const supabase = getSupabaseAdmin();
  const byKey = new Map<string, string | null>();
  for (let index = 0; index < lookupIds.length; index += CHUNK) {
    const chunk = lookupIds.slice(index, index + CHUNK);
    const { data, error } = await supabase
      .from("employee_hiring_profile")
      .select("hr_id,job_title_ar")
      .in("hr_id", chunk)
      .returns<ProfileTitleRow[]>();
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const key = canonicalHrIdKey(row.hr_id);
      if (key) byKey.set(key, cleanTitle(row.job_title_ar));
    }
  }

  for (const hrId of wanted) {
    const key = canonicalHrIdKey(hrId);
    if (key && byKey.has(key)) out.set(hrId, byKey.get(key) ?? null);
  }

  return out;
}

export type SocialInsuranceJobTitleWrite = { hrId: string; jobTitleAr: string | null };

/**
 * Write the insurance job title for one or more employees, and NOTHING else on their profile.
 *
 * The upsert payload names three columns, so PostgREST's `on conflict do update` sets three
 * columns: a nationality or an insurance office somebody typed months ago is untouched. A brand-new
 * row is created for an employee who has no hiring profile yet, which is the normal case for
 * anybody hired before the hiring pack existed.
 *
 * Returns how many rows it wrote, so a caller that reports what an upload changed can say so.
 */
export async function saveSocialInsuranceJobTitles(
  entries: SocialInsuranceJobTitleWrite[],
  actorHrId: string | null = null,
): Promise<number> {
  const payload = entries
    .map((entry) => ({ hrId: canonicalHrIdForDisplay(entry.hrId), jobTitleAr: cleanTitle(entry.jobTitleAr) }))
    .filter((entry): entry is { hrId: string; jobTitleAr: string | null } => Boolean(entry.hrId));
  if (payload.length === 0) return 0;

  const now = new Date().toISOString();
  const supabase = getSupabaseAdmin();
  let written = 0;
  for (let index = 0; index < payload.length; index += CHUNK) {
    const chunk = payload.slice(index, index + CHUNK);
    const { error } = await supabase.from("employee_hiring_profile").upsert(
      chunk.map((entry) => ({
        hr_id: entry.hrId,
        job_title_ar: entry.jobTitleAr,
        updated_at: now,
        updated_by_hr_id: canonicalHrIdForDisplay(actorHrId),
      })),
      { onConflict: "hr_id" },
    );
    if (error) throw new Error(error.message);
    written += chunk.length;
  }

  return written;
}
