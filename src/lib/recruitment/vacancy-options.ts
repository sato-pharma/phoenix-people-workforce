// Recruitment / ATS — the open seats a CV can be sent FOR.
//
// The owner's rule, stated many times and restated on 2026-08-28: the Organogram / AU seat model is
// the source of truth for org-structure and vacancy data. So the positions offered when sending a
// CV are not typed into recruitment and are not a second list kept in step by hand — they are the
// open rows of `position_vacancies`, read live.
//
// Measured in production 2026-08-28: 35 open, 43 filled, 29 cancelled. The 35 span 34 areas and
// exactly two job titles (34 Medical Representative, 1 Regulatory Affairs), which is why the AREA
// is what a person picks by and why the picker is sorted by it. Nasr City carries two of them, on
// different lines and reporting to different managers — see position-folder.ts for why the line is
// part of a position's identity rather than decoration.
//
// Reads the service-role client, so this module must never be imported by a client component. The
// screening page loads it server-side and passes the plain array down as a prop, the same way it
// loads the manager list.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cleanPositionText } from "@/lib/recruitment/position-folder";
import type { SentForPosition } from "@/lib/recruitment/types";

/** One open seat, as a recruiter picks it. */
export type VacancyOption = {
  /** `position_vacancies.id`. Sent back verbatim so the send can be traced to the seat. */
  id: number;
  jobTitle: string;
  areaName: string | null;
  regionName: string | null;
  lineName: string | null;
  /**
   * The manager this seat reports to, when the vacancy names one. Picking a vacancy pre-selects
   * this person, which is the whole reason a recruiter should pick rather than type: the vacancy
   * already knows who owns it, and choosing the wrong manager is how a CV lands somewhere nobody
   * is looking. Null on a seat whose own manager is also vacant — "Vacant Cairo District Manager"
   * is a real row in this table.
   */
  managerHrId: string | null;
  managerName: string | null;
};

type VacancyRow = {
  id?: number | string | null;
  job_title?: string | null;
  region_name?: string | null;
  manager_hr_id?: string | null;
  manager_name?: string | null;
  areas?: { name?: string | null } | Array<{ name?: string | null }> | null;
  lines?: { name?: string | null } | Array<{ name?: string | null }> | null;
};

/** PostgREST returns an embedded row as an object or, on some relationships, a one-element array. */
function embeddedName(value: VacancyRow["areas"] | VacancyRow["lines"]): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  const name = String(row?.name ?? "").trim();
  return name.length > 0 ? name : null;
}

/**
 * Every currently open seat, ordered the way a recruiter reads them.
 *
 * Only `status = 'open'`. A filled seat is not something to send a CV for, and a cancelled one is a
 * decision that was reversed — offering either would invite filing a candidate against a vacancy
 * that no longer wants anybody, and the folder would then outlive the reason it exists.
 *
 * Area first in the sort, then line, then title: 34 of the 35 share one title, so sorting by title
 * would produce one undifferentiated block and force the recruiter to read every row.
 */
export async function listOpenVacancyOptions(): Promise<VacancyOption[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("position_vacancies")
    .select("id,job_title,region_name,manager_hr_id,manager_name,areas(name),lines(name)")
    .eq("status", "open");
  if (error) {
    // 42P01 = the table is absent. Not possible in production, but a preview database built from a
    // partial schema would otherwise take the whole screening page down over a picker — and a
    // screening page with no position picker is exactly what shipped yesterday and worked.
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }

  return ((data ?? []) as VacancyRow[])
    .map((row) => ({
      areaName: embeddedName(row.areas),
      id: Number(row.id),
      jobTitle: String(row.job_title ?? "").trim(),
      lineName: embeddedName(row.lines),
      managerHrId: String(row.manager_hr_id ?? "").trim() || null,
      managerName: String(row.manager_name ?? "").trim() || null,
      regionName: String(row.region_name ?? "").trim() || null,
    }))
    .filter((option) => Number.isFinite(option.id) && option.jobTitle.length > 0)
    .sort(
      (left, right) =>
        // A seat with no area LAST, not first. One of the 35 has none (measured 2026-08-28), and an
        // empty string sorts before every real name — so the plain `??  ""` comparison would open
        // the picker on the one row that cannot be told apart by the thing the list is sorted by.
        Number(!left.areaName) - Number(!right.areaName) ||
        (left.areaName ?? "").localeCompare(right.areaName ?? "") ||
        (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
        left.jobTitle.localeCompare(right.jobTitle),
    );
}

/**
 * Look one open vacancy up by id, for stamping a send.
 *
 * Re-read server-side rather than trusted from the request body. The id arrives from a form, and a
 * body that named a filled or cancelled seat — or somebody else's — would otherwise file a real
 * candidate against it. Returns null when the id is not an OPEN vacancy, and the caller refuses.
 */
export async function findOpenVacancy(vacancyId: number): Promise<VacancyOption | null> {
  if (!Number.isFinite(vacancyId)) return null;
  const options = await listOpenVacancyOptions();
  return options.find((option) => option.id === vacancyId) ?? null;
}

/**
 * Turn what the browser posted into the position that gets stamped — or refuse it.
 *
 * THE ID IS RE-READ, THE TEXT IS NOT TRUSTED. When a vacancy id arrives, every field of the stamp
 * comes from the row this function reads back, and the title, area and line in the request body are
 * discarded. Otherwise a posted body could file a candidate under "Nasr City · Medical
 * Representative" while pointing at an entirely different seat, and the folder would be a lie that
 * looks exactly like the truth.
 *
 * A closed or cancelled vacancy is REFUSED rather than degraded to free text. The recruiter picked
 * a specific seat; if that seat filled while the page was open, silently filing the candidate under
 * its words anyway hides the one fact they most need to know.
 *
 * Free-typed text is cleaned through the same normaliser the folders are keyed on, so what is
 * stored is already what it will be compared as. All-empty means no position was given, which is a
 * legitimate send and returns null.
 *
 * The manager is NOT forced to match the vacancy's own manager. Picking the seat pre-selects them
 * in the UI, but sending a Nasr City CV to the National Sales Manager instead is a real thing a
 * recruiter does, and the position is a filing label, not a routing rule.
 */
export async function resolveSentForPosition(input: {
  vacancyId?: number | string | null;
  jobTitle?: string | null;
  areaName?: string | null;
  lineName?: string | null;
}): Promise<SentForPosition | null> {
  const rawId = String(input.vacancyId ?? "").trim();
  if (rawId) {
    const vacancyId = Number(rawId);
    const vacancy = Number.isFinite(vacancyId) ? await findOpenVacancy(vacancyId) : null;
    if (!vacancy) {
      throw new Error("That position is no longer open. Reload the page and pick another.");
    }
    return {
      areaName: vacancy.areaName,
      jobTitle: vacancy.jobTitle,
      lineName: vacancy.lineName,
      regionName: vacancy.regionName,
      vacancyId: vacancy.id,
    };
  }

  const position: SentForPosition = {
    areaName: cleanPositionText(input.areaName),
    jobTitle: cleanPositionText(input.jobTitle),
    lineName: cleanPositionText(input.lineName),
    // A typed position has no region. It is derived from the organogram, not from a person's
    // typing, and guessing it from the area would be inventing a value — Beni Suef and Fayoum sit
    // in different regions depending on the LINE, so even the obvious guess is wrong twice.
    regionName: null,
    vacancyId: null,
  };
  if (!position.areaName && !position.jobTitle && !position.lineName) return null;
  return position;
}

/**
 * Job titles and areas already used on a send, for the free-typed field's suggestions.
 *
 * The owner chose free typing alongside the vacancy list knowing it can drift (2026-08-28). This is
 * the cheap half of holding that drift down: offering what has already been typed means the second
 * person to file a "Marketing Executive · Head office" picks the existing spelling from a list
 * instead of inventing "Marketing Exec." and opening a folder that reads almost the same.
 *
 * Reads the sends themselves, not a vocabulary table — there is nothing to maintain and a value
 * stops being suggested once nothing is filed under it.
 */
export async function listUsedPositionText(): Promise<{ jobTitles: string[]; areas: string[] }> {
  const { data, error } = await getSupabaseAdmin()
    .from("ats_candidates")
    .select("sent_for_job_title,sent_for_area")
    .not("sent_for_job_title", "is", null);
  if (error) {
    // 42703 = the columns do not exist yet, which is the pre-migration state and not a fault of this
    // caller. No suggestions is a complete answer; a thrown error would take the picker down.
    if ((error as { code?: string }).code === "42703") return { areas: [], jobTitles: [] };
    throw error;
  }

  const jobTitles = new Set<string>();
  const areas = new Set<string>();
  for (const row of (data ?? []) as Array<{ sent_for_job_title?: string | null; sent_for_area?: string | null }>) {
    const title = String(row.sent_for_job_title ?? "").trim();
    const area = String(row.sent_for_area ?? "").trim();
    if (title) jobTitles.add(title);
    if (area) areas.add(area);
  }
  return {
    areas: [...areas].sort((left, right) => left.localeCompare(right)),
    jobTitles: [...jobTitles].sort((left, right) => left.localeCompare(right)),
  };
}
