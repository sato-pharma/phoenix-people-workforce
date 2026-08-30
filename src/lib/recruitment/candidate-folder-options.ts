// Recruitment / ATS — the folders a recruiter may file a CV into, loaded for the picker.
//
// SERVER ONLY. This reaches the database, so it must never be imported from the candidate pool,
// which is a "use client" component — the same split candidate-folder.ts (pure) and screening-link.ts
// are written under. The page loads this and hands the result down as props.
//
// Only the AREA list needs a read at all. Regions are a closed list in candidate-region.ts and job
// titles are free-typed, so those two are answered without touching the database.

import { recruitmentRegionForArea } from "@/lib/recruitment/candidate-region";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";

export type CandidateFolderAreaOption = {
  /** The area name, verbatim — this is what gets stored as the folder key. */
  name: string;
  /** The region it files under IN RECRUITMENT, which is not always its sales region. */
  regionCode: string;
};

/**
 * Every active area, in the Organogram's own sort order, tagged with its RECRUITMENT region.
 *
 * THE DELTA (3) TRAP, and the reason this does not read `code_region_code` directly. Qalubeya,
 * Sharkia 1, Sharkia 2, Suez and Ismailia moved to Delta (3) for recruitment on 2026-08-29, while
 * the SALES geography was deliberately left filing them under Delta (1)/(2)/Others — the owner's own
 * decision, and `au.canonical_areas` still says the old thing on purpose. Reading that column raw
 * would put Sharkia in the Delta (2) folder and leave Delta (3) reading empty on the very shelf the
 * district was opened for. `recruitmentRegionForArea` is the one place that rule lives; the WhatsApp
 * apply flow already goes through it and this must too, or the two menus disagree about where an
 * applicant's own area is.
 *
 * Read live rather than cached: this is loaded once per page render, not per webhook, and an area
 * list that lags the org chart by ten minutes is exactly how a recruiter files into a territory that
 * no longer exists.
 */
export async function listCandidateFolderAreaOptions(): Promise<CandidateFolderAreaOption[]> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("au_v_canonical_areas")
    .select("area_name,code_region_code,sort_order,is_active")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw error;

  const options: CandidateFolderAreaOption[] = [];
  for (const raw of (data ?? []) as Array<{ area_name: string | null; code_region_code: string | null }>) {
    const name = textOrNull(raw.area_name);
    const salesRegion = textOrNull(raw.code_region_code);
    if (!name || !salesRegion) continue;
    options.push({ name, regionCode: recruitmentRegionForArea(name, salesRegion) });
  }
  return options;
}
