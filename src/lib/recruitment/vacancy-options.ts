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

import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { getMergedAreaName } from "@/lib/sales/closing-area-merges";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";
import { cleanPositionText } from "@/lib/recruitment/position-folder";
import {
  MANAGER_SEAT_COLUMNS,
  resolveVacancyManager,
  type ManagerSeatRow,
  type ManagerStandIn,
} from "@/lib/recruitment/vacancy-manager-escalation";
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
   * The manager who receives a CV sent for this seat. Picking a vacancy pre-selects this person,
   * which is the whole reason a recruiter should pick rather than type: the vacancy already knows
   * who owns it, and choosing the wrong manager is how a CV lands somewhere nobody is looking.
   *
   * Usually the manager the vacancy itself names. Where that post is ITSELF vacant — "Vacant Cairo
   * District Manager" is a real row in this table — it is instead whoever the organogram puts above
   * it, and `standingInFor` says so. Null only when neither can be resolved, and the send then stays
   * disabled rather than addressing a CV to nobody.
   */
  managerHrId: string | null;
  managerName: string | null;
  /**
   * The vacant post this manager is covering, named the way the vacancy or the organogram names it.
   * Null in the ordinary case, where the manager is the seat's own manager and there is nothing to
   * explain. Set, it is shown beside the send so a recruiter can see the CV is going a level up and
   * why — routing silently would leave them to discover it in the reply.
   */
  standingInFor: string | null;
};

type VacancyRow = {
  id?: number | string | null;
  job_title?: string | null;
  region_name?: string | null;
  manager_hr_id?: string | null;
  manager_name?: string | null;
  seat_id?: string | null;
  areas?: { name?: string | null; code?: string | null } | Array<{ name?: string | null; code?: string | null }> | null;
  lines?: { name?: string | null; code?: string | null } | Array<{ name?: string | null; code?: string | null }> | null;
};

/** PostgREST returns an embedded row as an object or, on some relationships, a one-element array. */
function embeddedName(value: VacancyRow["areas"] | VacancyRow["lines"]): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  const name = String(row?.name ?? "").trim();
  return name.length > 0 ? name : null;
}

function embeddedCode(value: VacancyRow["areas"] | VacancyRow["lines"]): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  const code = String(row?.code ?? "").trim();
  return code.length > 0 ? code : null;
}

/**
 * The area name a recruiter reads for one vacancy. `public.areas.name` says "Suez" for the Anti
 * Infective Delta (3) seat, but from September 2026 Ismailia and Suez are ONE area on that line
 * (owner, 2026-09-19), so the picker uses the line's merge rule where one applies and the plain area
 * name everywhere else. Line-scoped on purpose: a CNS or Pedia seat in Suez keeps saying "Suez".
 */
export function vacancyAreaName(row: Pick<VacancyRow, "areas" | "lines">): string | null {
  const areaCode = embeddedCode(row.areas);
  const merged = areaCode ? getMergedAreaName(embeddedCode(row.lines), areaCode) : null;
  return merged ?? embeddedName(row.areas);
}

/**
 * The organogram, for vacancies whose own manager post is empty.
 *
 * A failed read degrades to no escalation rather than throwing. The picker worked without this until
 * today, and taking the whole screening page down because a view was slow would cost the recruiter
 * every vacancy to fix one.
 */
async function loadManagerSeatRows(): Promise<ManagerSeatRow[]> {
  try {
    // Every seat, paged to a short page. The view holds one row per OCCUPANT (a handover seat has two),
    // so the order is occupant then `seat_id`: together they are unique, which paging needs. A row a
    // response cap dropped would leave its vacancy with no manager to stand in.
    return await fetchAllRows<ManagerSeatRow>(
      () =>
        getSupabaseAdmin()
          .from("au_v_org_tree")
          .select(MANAGER_SEAT_COLUMNS)
          .order("occupant_hr_id", { ascending: true }),
      "seat_id",
    );
  } catch (error) {
    logError("Vacancy manager escalation could not read the org tree", {
      error,
      labels: { event: "vacancy_manager_escalation_tree_read_failed" },
    });
    return [];
  }
}

/**
 * Fill in the manager on any seat whose own manager post is vacant.
 *
 * Costs nothing on a list where every vacancy names its manager: the organogram is read only once a
 * vacancy is found without one. Measured in production 2026-08-28, exactly one of the 48 open
 * vacancies is in that state.
 *
 * A vacancy that already names a manager is never touched. The organogram may well disagree with the
 * row, but the row is the deliberate answer and quietly overruling it would move CVs away from the
 * person somebody chose to put on it.
 */
async function withEscalatedManagers(
  options: readonly VacancyOption[],
  seatIdByVacancyId: Map<number, string | null>,
): Promise<VacancyOption[]> {
  const unmanaged = options.filter((option) => !option.managerHrId);
  if (unmanaged.length === 0) return [...options];

  const seatRows = await loadManagerSeatRows();
  if (seatRows.length === 0) return [...options];

  const standIns = new Map<number, ManagerStandIn>();
  for (const option of unmanaged) {
    const standIn = resolveVacancyManager(
      {
        lineName: option.lineName,
        regionName: option.regionName,
        seatId: seatIdByVacancyId.get(option.id) ?? null,
      },
      seatRows,
    );
    if (standIn) standIns.set(option.id, standIn);
  }
  if (standIns.size === 0) return [...options];

  const names = await namesByHrId([...new Set([...standIns.values()].map((standIn) => standIn.hrId))]);

  return options.map((option) => {
    const standIn = standIns.get(option.id);
    if (!standIn) return option;
    return {
      ...option,
      managerHrId: standIn.hrId,
      // Never the vacancy's own manager_name as a fallback here: that string names the EMPTY post,
      // and leaving it beside a stand-in's HR_ID would read as though this person holds it. An
      // unresolvable name degrades to none — the send picker carries the name either way.
      managerName: names.get(standIn.hrId),
      // The vacancy's own wording first, where it has any. "Vacant Cairo District Manager" is what a
      // person wrote for a person to read; the organogram's "PEDIA Cairo DM (VACANT)" is a label.
      standingInFor: standIn.coveredSeatLabel ? option.managerName ?? standIn.coveredSeatLabel : null,
    };
  });
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
  let rows: VacancyRow[];
  try {
    // Every open seat, paged to a short page by the unique `id`: the picker is the whole list, and a
    // seat a response cap dropped could never be sent a CV.
    rows = await fetchAllRows<VacancyRow>(
      () =>
        getSupabaseAdmin()
          .from("position_vacancies")
          .select("id,job_title,region_name,manager_hr_id,manager_name,seat_id,areas(name,code),lines(name,code)")
          .eq("status", "open"),
      "id",
    );
  } catch (error) {
    // 42P01 = the table is absent. Not possible in production, but a preview database built from a
    // partial schema would otherwise take the whole screening page down over a picker — and a
    // screening page with no position picker is exactly what shipped yesterday and worked.
    if ((error as { code?: string }).code === "42P01") return [];
    throw error;
  }

  // Kept beside the options rather than on them. The seat id is how the organogram is entered, not
  // anything a recruiter reads, and putting a raw code on a type that crosses to the browser is how
  // one ends up rendered.
  const seatIdByVacancyId = new Map<number, string | null>(
    rows.map((row) => [Number(row.id), String(row.seat_id ?? "").trim() || null]),
  );

  const options = rows
    .map((row) => ({
      areaName: vacancyAreaName(row),
      id: Number(row.id),
      jobTitle: String(row.job_title ?? "").trim(),
      lineName: embeddedName(row.lines),
      managerHrId: String(row.manager_hr_id ?? "").trim() || null,
      managerName: String(row.manager_name ?? "").trim() || null,
      regionName: String(row.region_name ?? "").trim() || null,
      standingInFor: null as string | null,
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

  // The manager has to read the same way here as in the manager picker one row below it on the
  // screening page. `position_vacancies.manager_name` is a full legal name — "Hany Saad Mohamed
  // Omar", "Sameh Shabaan El Hoseiny El Hoseiny" — while every other surface in the app shows the
  // name the company actually uses him by, through `resolveEmployeeDisplayName`: "Hany Saad",
  // "Sameh El Hoseiny". Picking a vacancy PRE-SELECTS that manager, so the two fields sit an inch
  // apart and used to name the same person two different ways at the moment a recruiter is checking
  // the CV is going to the right place.
  //
  // The row's own wording stays as the fallback rather than being blanked: it is the only name a
  // manager who is not in `employees` has, and a nameless manager is worse than a formal one.
  const named = await namesByHrId([
    ...new Set(options.map((option) => option.managerHrId).filter((hrId): hrId is string => Boolean(hrId))),
  ]);

  return withEscalatedManagers(
    options.map((option) =>
      option.managerHrId ? { ...option, managerName: named.get(option.managerHrId) ?? option.managerName } : option,
    ),
    seatIdByVacancyId,
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
  const supabase = getSupabaseAdmin();
  let data: Array<{ sent_for_job_title?: string | null; sent_for_area?: string | null }>;
  try {
    // Every send, paged to a short page by the unique `id`: a suggestion list read from the first
    // response's worth would stop offering an existing spelling and invite a near-duplicate folder.
    data = await fetchAllRows<{ sent_for_job_title?: string | null; sent_for_area?: string | null }>(
      () => supabase.from("ats_candidates").select("sent_for_job_title,sent_for_area").not("sent_for_job_title", "is", null),
      "id",
    );
  } catch (error) {
    // 42703 = the columns do not exist yet, which is the pre-migration state and not a fault of this
    // caller. No suggestions is a complete answer; a thrown error would take the picker down.
    if ((error as { code?: string } | null)?.code === "42703") return { areas: [], jobTitles: [] };
    throw error;
  }

  const jobTitles = new Set<string>();
  const areas = new Set<string>();
  for (const row of data) {
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
