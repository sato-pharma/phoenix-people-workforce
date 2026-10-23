// Recruitment / ATS — pushing a candidate to the hiring manager, as a deliberate, recorded act.
//
// This is the one step the whole module exists to serve: a CV arrives, the AI reads it, and a
// recruiter sends the person to the District Manager (or whoever owns that seat) to look at.
// Until 2026-08-15 it was neither deliberate nor recorded:
//
//   • It fired only as a SIDE EFFECT of picking a value in a dropdown labelled "Pick a position…",
//     so nobody chose to send anything and nobody could re-send.
//   • createApplication wrapped the send in `catch {}` — an empty block that discarded the error.
//     In production 5 candidates were assigned and only 2 notifications ever fired; the 3 failures
//     left no log, no row and no error message anywhere, including both of the owner's own attempts
//     on 2026-08-15. "It silently did nothing" was indistinguishable from "it worked".
//
// So this module does three things the old inline block did not: it returns a RESULT the caller can
// show on screen, it writes an ats_application_events row so the send is visible in history and
// survives a page reload, and it lets a failed send be retried instead of being lost.
//
// Kept out of applications.ts (which imports it) so the notification concern stays testable on its
// own and applications.ts keeps its single job of moving stages.

import { ACTIVE_EMPLOYMENT_STATUSES_IN_LIST } from "@/lib/auth/session-lifecycle";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import {
  EMPLOYEE_AREA_SELECT,
  resolveEmployeeAreaName,
  type EmployeeOrgFields,
} from "@/lib/employees/employee-org-labels";
import { hrIdLookupKeys } from "@/lib/hr-id";
// The shared org casing rule — `Ceo` -> `CEO`, `Sfe Manager` -> `SFE Manager`, `R And D Manager` ->
// `R&D Manager`. All three of those are still the literal contents of `employees.job_title` in
// production; this renders them the way the company writes them without touching the column, and
// deliberately leaves every other word alone (see the note on `orgAcronymCase`).
import { orgAcronymCase } from "@/lib/recruitment/manager-grouping";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { candidateAlertIdempotencyKey } from "@/lib/recruitment/candidate-alert-key";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { writeApplicationEvent } from "@/lib/recruitment/db";
import { boardsForManager, type DistrictSeatRow } from "@/lib/recruitment/district-manager-folders";
import { loadDistrictSeatRows } from "@/lib/recruitment/folder-holders";
import { managerFolderShelves } from "@/lib/recruitment/manager-cv-folders";
import { recordManagerSends } from "@/lib/recruitment/manager-sends";
import { quotedInList } from "@/lib/supabase/search-filter";
import type { SentForPosition } from "@/lib/recruitment/types";

/** The audit action written to ats_application_events when a manager is told about a candidate. */
export const MANAGER_NOTIFIED_ACTION = "manager_notified";

export type HiringManagerNotifyResult =
  | { sent: true; managerHrId: string; managerName: string; sentAt: string }
  /**
   * Not every application HAS a manager to notify, and that is not a failure — a requisition
   * created against a seat with no manager on the organogram carries no hiringManagerHrId, and a
   * manager assigning a candidate to their own seat does not need telling. Distinguished from a
   * genuine failure so the UI can say which happened instead of showing a red error for both.
   */
  | { sent: false; reason: "no_hiring_manager" | "actor_is_the_manager" };

/** A manager a candidate can be pushed to, named the way a person reads it — never a raw HR_ID. */
export type HiringManagerOption = {
  hrId: string;
  name: string;
  jobTitle: string;
  /**
   * Where this manager's seat is. Carried since 2026-08-27 because a name alone is not enough to
   * pick correctly: the live dropdown holds 31 people across 11 distinct job titles, 17 of them
   * District Sales Managers, so telling one from another meant recognising a person rather than
   * reading a seat. Measured the same day, 28 of the 31 carry an area and all 31 carry a region.
   *
   * Null where the employee row has none — shown as nothing rather than as a guess.
   */
  areaName: string | null;
  regionName: string | null;
  /**
   * The LINE this seat carries on the organogram — CNS, Anti Infective or Pedia.
   *
   * ADDED 2026-08-31, and it is the field that makes this picker usable at all. Measured live in
   * production that day, the rendered dropdown held 30 people and **16 of them were not
   * identifiable from their seat text**: three "District Sales Manager · Giza", three "District
   * Sales Manager · Delta (1)", two each on Cairo, Alex-BHR, Delta (2) and Upper Egypt, and two
   * "National Sales Manager · Egypt". The company runs one District Manager PER LINE PER REGION, so
   * the line is the ONLY thing that tells those pairs apart — and it was the one thing the label
   * did not carry. A recruiter had to know by heart that Giza's Anti-Infective DM is Mahmoud
   * Eldaly, its CNS DM is Sameh, and its Pedia DM is Taha.
   *
   * Null for the head-office seats, and that is correct rather than missing: `au_v_org_tree` is the
   * SALES seat model, so Finance, HR, Marketing, R&D, SFE, Training and the Product Managers hold
   * no seat on it at all (8 of the 31 on the day this was written). They are named by their HR job
   * title instead — never as "not in the organogram".
   */
  lineName: string | null;
  /**
   * The organogram tier — `CEO`, `NSM`, `RSM`, `DM` — or null for a head-office seat off the sales
   * tree. Drives the ordering and the grouping in the picker, so the list reads down the org chart
   * instead of alphabetically by job title.
   */
  seatTier: string | null;
  /**
   * The folders on this manager's shelf a CV can be filed in — one per area beneath him, from the
   * organogram (owner, 2026-10-16). Empty or absent for a manager who holds none (head office), and
   * the send dialogs then offer no folder choice. "Other CVs" is not listed: the picker adds it.
   */
  folders?: string[];
};

/**
 * Where a seat sits in the org chart, for ordering.
 *
 * Head office sorts LAST rather than first. Measured in production 2026-08-15 and again on
 * 2026-08-31, the District Sales Managers receive nearly every push; making a recruiter scroll past
 * Finance, R&D and Training to reach them is the ordering the old alphabetical-by-job-title sort
 * produced, and it is exactly backwards.
 */
const SEAT_TIER_RANK: Readonly<Record<string, number>> = { CEO: 0, NSM: 1, RSM: 2, DM: 3, ACTING_DM: 4 };
const HEAD_OFFICE_TIER_RANK = 5;

/**
 * The seat tiers that make somebody a manager a CV can be sent to.
 *
 * **`REP` is the one that matters, and leaving it out of this set is the whole reason the set
 * exists.** `au_v_org_tree` is the sales seat model, so it holds every FIELD seat too: measured in
 * production 2026-08-31 it carries 109 REP seats with 67 people in them, against 22 DM, 3 NSM, 1
 * RSM, 1 CEO and 1 ACTING_DM. The first cut of the seat-holder union below asked the organogram for
 * "anyone holding a seat" without qualifying which, and the picker went from 30 people to 98 — 68 of
 * them medical representatives, who are the people CVs are sent ABOUT, never the people they are
 * sent TO. The owner caught it on sight: "Don't show medical reps."
 *
 * `ACTING_DM` IS included, and that is a judgement rather than an oversight. One person holds such a
 * seat — Nosiba Moussa, Upper Egypt 1 / Anti Infective — and her `employees.job_title` is literally
 * `Medical Representative`, because the owner's standing rule is that an acting district manager
 * keeps her real title and it is the REPS that move, not her title. Dropping her would leave that
 * district with no manager to send a CV to at all, so she is offered under the seat she actually
 * holds. See the title override at the mapping step: she is rendered as an acting DM, which is the
 * truthful answer to "who runs Upper Egypt 1 Anti Infective" and is not the same claim as changing
 * what she is employed as.
 */
const MANAGER_SEAT_TIERS: ReadonlySet<string> = new Set(["CEO", "NSM", "RSM", "DM", "ACTING_DM"]);

/**
 * What an acting seat is CALLED, when the holder's own job title does not say it.
 *
 * Rendering, not rewriting — the same rule `orgAcronymCase` runs under. `employees.job_title` keeps
 * saying `Medical Representative` because that is what she is employed as; the picker says what she
 * is doing, because a list of managers that reads "Medical Representative" is the exact thing the
 * owner asked not to see.
 */
const ACTING_SEAT_TITLES: Readonly<Record<string, string>> = {
  ACTING_DM: "Acting District Sales Manager",
};

/** One organogram seat, reduced to what a picker needs. */
type OrgSeat = {
  /**
   * The occupant's HR_ID **exactly as the organogram spells it**, kept beside the lower-cased map
   * key rather than derived from it.
   *
   * This field is the fix for a bug that shipped in the first cut of this change and cost the whole
   * point of it. The union filter below was built from `orgSeats.keys()` — which are lower-cased,
   * because that is what makes the lookup case-safe — and `employees.hr_id` stores `AA`, `B-156`,
   * `AI-0001` in upper case. PostgREST `in` is case-SENSITIVE, so the filter matched nothing at all
   * and the CEO, the one person this union exists to add, was still absent from the rendered picker.
   * Thirty options, no CEO, and no error anywhere to say why.
   *
   * Lower-case to COMPARE, original case to QUERY. That is the whole rule, and it is the same trap
   * this repo has been bitten by repeatedly — a mixed-case HR_ID match that under-returns silently
   * and reads as "there is nobody there".
   */
  hrId: string;
  seatTier: string | null;
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
};

/**
 * Every occupied seat on the organogram, indexed by lower-cased HR_ID.
 *
 * Read from `au_v_org_tree` — the same view the organogram chart, the CRM boards and the business
 * review all read, which is the entire point: "who are the managers, and which seat does each
 * hold" must have ONE answer in this codebase, not a directory-shaped answer here and an
 * organogram-shaped answer everywhere else.
 *
 * Lower-cased on BOTH sides. `occupant_hr_id` and `employees.hr_id` happen to agree on casing today
 * (both upper-case, verified 2026-08-31), but the standing trap in this repo is that HR ids are
 * mixed case across tables and a bare match silently under-returns — on `au.occupancy_history` the
 * loss was total, 0 of 120. A seat that matches nobody reads as a vacant seat, not as a bug.
 *
 * Never throws. The organogram is an ENRICHMENT here: if this read fails, every manager still
 * appears, just without their line and tier — which is precisely what the picker looked like
 * yesterday. A recruiter losing the ability to send a CV because a view was slow is a regression;
 * losing a line badge is not.
 *
 * THE ROWS ARE `loadDistrictSeatRows`'s, not a read of its own. The picker needs the same view for
 * the folder shelves, and that read selects every column this one did (and more) with no filter,
 * so one request answers both — and a failed read still comes back as no rows, so no seats here.
 */
function orgSeatsByHrId(seatRows: readonly DistrictSeatRow[]): Map<string, OrgSeat> {
  const seats = new Map<string, OrgSeat>();
  try {
    for (const row of seatRows as ReadonlyArray<Record<string, unknown>>) {
      const occupantRaw = String(row.occupant_hr_id ?? "").trim();
      const occupant = occupantRaw.toLowerCase();
      if (!occupant) continue;
      const seat: OrgSeat = {
        areaName: String(row.area_name ?? "").trim() || null,
        hrId: occupantRaw,
        lineName: String(row.line_name ?? "").trim() || null,
        regionName: String(row.region_name ?? "").trim() || null,
        seatTier: String(row.seat_tier ?? "").trim() || null,
      };
      // One person can hold more than one seat. Keep the HIGHEST — a manager covering a district
      // while holding the national seat is a National Sales Manager, and filing him under the
      // district would bury him below seventeen DMs in the picker.
      const existing = seats.get(occupant);
      if (existing && seatTierRank(existing.seatTier) <= seatTierRank(seat.seatTier)) continue;
      seats.set(occupant, seat);
    }
  } catch {
    /* enrichment only — see above */
  }
  return seats;
}

function seatTierRank(seatTier: string | null): number {
  return seatTier ? (SEAT_TIER_RANK[seatTier] ?? HEAD_OFFICE_TIER_RANK) : HEAD_OFFICE_TIER_RANK;
}

/** The manager's seat as it was AT THE MOMENT OF A SEND, frozen onto the candidate row. */
export type NotifiedManagerContext = {
  name: string;
  jobTitle: string | null;
  areaName: string | null;
  regionName: string | null;
};

/**
 * Everyone a candidate can be sent to.
 *
 * Deliberately title-driven rather than a curated list or an app-role check: the org's managers are
 * exactly the people whose job title says so, and a curated list is one more thing that goes stale
 * the day someone is promoted. Measured in production 2026-08-15 this yields 30 people, 17 of them
 * District Sales Managers — small enough to be one dropdown, which is the whole point of the
 * feature. Sorted by title then name so the District Sales Managers, who receive nearly every push,
 * do not have to be hunted for among the Finance and R&D managers.
 *
 * The employment filter goes through ACTIVE_EMPLOYMENT_STATUSES_IN_LIST rather than a hand-written
 * literal, and that is not tidiness. `employment_status` in production is lower-case `active` on all
 * 112 live employees; an `.eq("employment_status", "Active")` here matched ZERO rows, which made the
 * dropdown empty and every send fail with "That person is not a manager who can be sent candidates."
 * PostgREST `eq` is case-sensitive and a filter that matches nothing looks exactly like an org with
 * no managers. The shared constant also covers `on_leave` — a manager on leave is still the person
 * who owns that seat when they return, and their CVs should not silently route to nobody.
 */
export async function listHiringManagerOptions(): Promise<HiringManagerOption[]> {
  // The organogram is read FIRST, because it decides who is on the list as well as how they read.
  // ONE read serves both the seats and the shelves below (see orgSeatsByHrId).
  const seatRows = await loadDistrictSeatRows();
  const orgSeats = orgSeatsByHrId(seatRows);
  // The folders each manager holds, for the folder choice in the send dialogs. A failed organogram
  // read gives no folders, so the dialogs simply offer no choice and the server picks as before.
  const shelves = managerFolderShelves(seatRows);

  // ── WHO IS OFFERED ────────────────────────────────────────────────────────────────────────────
  // Two sources unioned, and the union is the fix rather than a belt-and-braces.
  //
  //   1. The job title, as before — it is what catches the eight head-office managers who hold no
  //      seat on the sales tree at all (Finance, HR, Marketing, R&D, SFE, Training, 2 Product
  //      Managers). For them the directory IS the right source, and always was.
  //   2. Anyone holding a MANAGING seat on the organogram, whatever their title says — CEO, NSM,
  //      RSM, DM, ACTING_DM, and pointedly NOT the 67 occupied REP seats. See MANAGER_SEAT_TIERS
  //      for what that unqualified "anyone holding a seat" cost when it shipped without the filter.
  //
  // Measured in production 2026-08-31, source 2 adds exactly ONE person to source 1 — and it is the
  // CEO, which is the whole reason this changed. His `job_title` is stored as the three letters
  // `Ceo`, and the patterns below match `manager`/`director`/`head`/`chief`. Whoever wrote `chief`
  // plainly expected "Chief Executive Officer"; production never held that string, so the intended
  // catch has never once fired and the owner could not send a CV to himself.
  //
  // `*ceo*` is NOT simply added to the pattern list, and that is deliberate. A substring that short
  // is a liability — it matches any title that happens to contain those three letters — and, more
  // to the point, patching the pattern would fix today's one name while leaving the next oddly
  // titled seat-holder invisible in exactly the same silent way. Asking the organogram who holds a
  // seat is the answer that keeps being right.
  const seatHolderIds = [...orgSeats.values()]
    // Managing seats only. Without this the union drags in every medical representative on the
    // sales tree — 68 of them, measured live — and buries the seventeen District Managers under a
    // list of the people whose CVs get sent in the first place.
    .filter((seat) => MANAGER_SEAT_TIERS.has((seat.seatTier ?? "").toUpperCase()))
    // The ORIGINAL casing, never the lower-cased map key — see the note on `OrgSeat.hrId`. Querying
    // with the key matched zero rows and silently dropped the CEO.
    .map((seat) => seat.hrId)
    .filter((hrId) => hrId.length > 0);
  // Quoted through the shared builder. This line used to wrap each id in `"` by hand and escape
  // NOTHING inside them, which is only safe if no id can carry a quote — so the ids that could
  // were dropped from the list a few lines up instead. Dropping a seat holder silently removes a
  // manager from the notification this function exists to send; quoting keeps him and cannot
  // break the filter.
  const seatHolderClause = seatHolderIds.length > 0 ? `,hr_id.in.(${quotedInList(seatHolderIds)})` : "";

  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    // The area from the `area_id` LINK: `employees.area_name` was a label frozen at write time and
    // was dropped on 2026-09-29. A select naming it fails the WHOLE read, which here would throw and
    // lose the send.
    .select(`hr_id,full_name,nickname,job_title,region_name,${EMPLOYEE_AREA_SELECT}`)
    .filter("employment_status", "in", ACTIVE_EMPLOYMENT_STATUSES_IN_LIST)
    .or(
      `job_title.ilike.*manager*,job_title.ilike.*director*,job_title.ilike.*head*,job_title.ilike.*chief*${seatHolderClause}`,
    );
  if (error) throw error;

  const rows = (data ?? []) as Array<
    EmployeeOrgFields & {
      hr_id?: string | null;
      full_name?: string | null;
      nickname?: string | null;
      job_title?: string | null;
      region_name?: string | null;
    }
  >;

  return rows
    .filter((row) => Boolean(row.hr_id) && Boolean(row.full_name))
    .map((row) => {
      const hrId = String(row.hr_id);
      const held = orgSeats.get(hrId.trim().toLowerCase()) ?? null;
      // A REP seat never colours a manager's label. The map keeps the highest tier a person holds,
      // so this only bites where somebody is offered by TITLE while also occupying a field seat —
      // but "District Sales Manager · Minia 1 · Anti Infective" built out of a rep seat would be a
      // wrong seat rendered with total confidence, which is worse than no seat at all.
      const seat = held && MANAGER_SEAT_TIERS.has((held.seatTier ?? "").toUpperCase()) ? held : null;
      const actingTitle = seat ? ACTING_SEAT_TITLES[(seat.seatTier ?? "").toUpperCase()] : undefined;
      /**
       * Whether the organogram has anything to say about WHERE this seat is.
       *
       * The fallback below is all-or-nothing on purpose, and this flag is the whole reason. Falling
       * back field by field mixes two different seats' geography into one label: Nosiba Moussa acts
       * as District Manager for **Upper Egypt 1** (the organogram's region, with no area — DM seats
       * are region-scoped) while her directory row still says **Minia 1**, the area she covers as a
       * medical representative. Per-field, the null seat area handed the label her rep's area and
       * the picker read "Nosiba Moussa · Minia 1" under the Acting District Sales Manager heading —
       * a real place, confidently wrong, and the one thing a recruiter would use to tell her seat
       * apart from somebody else's. Measured live 2026-08-31.
       *
       * The directory is still the answer where the organogram genuinely has nothing: the CEO and
       * the Regional Sales Manager both hold seats carrying neither region nor area, and their
       * "Head office" and "Alex East" come from `employees` as they always did.
       */
      const seatKnowsWhere = Boolean(seat && (seat.areaName || seat.regionName));
      return {
        // The organogram wins on the seat's geography, the directory fills in behind it. On every
        // District Manager the two agree; where they differ it is because the directory's
        // `area_name` is a copy of its `region_name` (verified on all 17 DMs, 2026-08-31) while the
        // organogram knows the DM seat is scoped by REGION and carries no area at all.
        areaName: seatKnowsWhere ? seat?.areaName ?? null : resolveEmployeeAreaName(row),
        hrId,
        // Cased through the shared org helper, at DISPLAY time only. Production still stores the
        // raw importer output in `employees.job_title` — `Ceo`, `Sfe Manager`, `R And D Manager`
        // were all live on 2026-08-31 — and the standing rule is that no mangled label reaches a
        // person. Rendering it correctly is not the same as rewriting the column, and rewriting it
        // is not this feature's business.
        // The acting seat's own name wins over the employment title — see ACTING_SEAT_TITLES.
        jobTitle: actingTitle ?? (orgAcronymCase(String(row.job_title ?? "").trim()) || "Manager"),
        folders: boardsForManager(shelves, hrId).flatMap((board) =>
          board.folders.filter((folder) => folder.kind === "area").map((folder) => folder.areaName),
        ),
        lineName: seat?.lineName ?? null,
        name: resolveEmployeeDisplayName(String(row.full_name), row.nickname ?? null),
        regionName: seatKnowsWhere ? seat?.regionName ?? null : String(row.region_name ?? "").trim() || null,
        seatTier: seat?.seatTier ?? null,
      };
    })
    .sort(
      (left, right) =>
        // DOWN THE ORG CHART, not down the alphabet. The old sort led on the job title string, which
        // put "District Sales Manager" above "National Sales Manager" for no reason anyone could
        // read and buried the CEO under Finance and R&D. Tier first answers "how senior", and the
        // seventeen District Managers — who take nearly every push — now sit in one block.
        seatTierRank(left.seatTier) - seatTierRank(right.seatTier) ||
        left.jobTitle.localeCompare(right.jobTitle) ||
        // Territory before line, matching the vacancy picker in the same panel, which reads
        // "Area · Job title · Line". A recruiter holding a Giza CV wants Giza's managers together;
        // the line is what then tells those three apart.
        (left.regionName ?? "").localeCompare(right.regionName ?? "") ||
        (left.areaName ?? "").localeCompare(right.areaName ?? "") ||
        (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
        left.name.localeCompare(right.name),
    );
}

/**
 * The manager's name and seat, for stamping onto a candidate at send time.
 *
 * Looked up through hrIdLookupKeys rather than a bare `.eq("hr_id", …)`. The ids in this module
 * cross two tables that disagree about case — `ats_candidates` holds lower-case ids while
 * `employees` holds upper-case — and PostgREST `eq` is case-sensitive, so an exact match on the
 * wrong casing returns no row and the send is silently attributed to a raw HR_ID with no title and
 * no area. That is the same class of bug that once made a dropdown empty and every send fail.
 *
 * Falls back to the HR_ID as the name, and nulls elsewhere, exactly as the old name-only lookup
 * did: an unresolvable manager must degrade to "we do not know their seat", never to a thrown
 * request that loses the send.
 */
export async function notifiedManagerContext(hrId: string): Promise<NotifiedManagerContext> {
  try {
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select(`full_name,nickname,job_title,region_name,${EMPLOYEE_AREA_SELECT}`)
      .in("hr_id", hrIdLookupKeys(hrId))
      .limit(1)
      .maybeSingle();
    const row = data as
      | (EmployeeOrgFields & {
          full_name?: string;
          nickname?: string | null;
          job_title?: string | null;
          region_name?: string | null;
        })
      | null;
    if (!row?.full_name) return { areaName: null, jobTitle: null, name: hrId, regionName: null };
    return {
      areaName: resolveEmployeeAreaName(row),
      // Cased on the way IN as well as on the way out. `managerSeatLabel` cases at render, which is
      // what rescues the stamps already written; casing here means the ones written from now on are
      // right in the column itself, for any reader that is not a label — an export, a digest email.
      jobTitle: orgAcronymCase(String(row.job_title ?? "").trim()) || null,
      name: resolveEmployeeDisplayName(row.full_name, row.nickname),
      regionName: String(row.region_name ?? "").trim() || null,
    };
  } catch {
    return { areaName: null, jobTitle: null, name: hrId, regionName: null };
  }
}

/** Human-readable name for an HR_ID, per the standing rule that no raw code reaches a person. */
export async function hiringManagerName(hrId: string): Promise<string> {
  return (await notifiedManagerContext(hrId)).name;
}

/**
 * Push a candidate to a manager with NO requisition in between, and stamp the candidate row.
 *
 * This is the shortest path the module has, and the owner's actual ask: a CV arrives, the AI reads
 * it, and the recruiter sends the person to a District Manager. Measured in production 2026-08-15,
 * 214 of the 221 people in the pool had never left it, because the only route to a manager ran
 * through createApplication -> a requisition -> a job title, line, area, seat and owner. None of
 * that is needed to ask someone "look at this CV".
 *
 * Same contract as the application-level push above: it THROWS on a real delivery failure, and the
 * record is written only once the manager has actually been told.
 */
export async function pushCandidateToManager(input: {
  actorHrId: string | null;
  candidateId: string;
  candidateName: string;
  managerHrId: string;
  position?: SentForPosition | null;
}): Promise<{ managerHrId: string; managerName: string; sentAt: string }> {
  const { count: _count, ...sent } = await pushCandidatesToManager({
    actorHrId: input.actorHrId,
    candidates: [{ id: input.candidateId, name: input.candidateName }],
    managerHrId: input.managerHrId,
    position: input.position ?? null,
  });
  return sent;
}

/** The position a send is recorded under once it is filed in a named folder: the folder IS its area. */
function positionInFolder(position: SentForPosition | null, folder: string): SentForPosition {
  return {
    areaName: folder,
    jobTitle: position?.jobTitle ?? null,
    lineName: position?.lineName ?? null,
    regionName: position?.regionName ?? null,
    vacancyId: position?.vacancyId ?? null,
  };
}

/** "Ahmed, Sara and Mona" — never an ellipsis, never a count standing in for the names. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * True when the database has not learned the three seat columns yet.
 *
 * Two codes, because the two layers disagree about which one this is. PostgREST answers a write
 * naming an unknown column with PGRST204 out of its own schema cache, while PostgreSQL itself
 * raises 42703 (undefined_column) — which is what arrives when the cache is warm but the column
 * genuinely is not there. Matching only one of them leaves the other as a thrown send.
 *
 * Deliberately narrow: it is checked ONLY around the seat-stamp update, so a real write failure on
 * any other column still throws and is still visible.
 */
function isMissingSeatColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "PGRST204" || code === "42703";
}

/**
 * Push one OR MANY candidates to a manager in a single notification.
 *
 * The one-notification-per-candidate shape is what makes this worth having. Measured in production
 * on 2026-08-15 the pool receives 152 CVs a week and the District Sales Managers take nearly all of
 * them; sending five people to the same manager as five separate alerts is how a useful signal
 * becomes something they mute. One alert names everybody in it — no ellipsis, no "and 3 others",
 * because a manager deciding whether to open it needs to see who is in it.
 *
 * Every candidate is stamped, and the stamp is written only AFTER delivery, for the same reason the
 * single-candidate path always has: history must never claim a send that did not happen.
 */
export async function pushCandidatesToManager(input: {
  actorHrId: string | null;
  candidates: Array<{ id: string; name: string }>;
  managerHrId: string;
  /**
   * The position they are being sent FOR — the folder the manager will find them in. Optional
   * because a send without one is still a valid send: it is what every send looked like before
   * 2026-08-28, and refusing one would break the flow rather than improve the filing.
   */
  position?: SentForPosition | null;
  /**
   * The folder on the manager's shelf each candidate goes in, by candidate id. Absent or null for a
   * candidate means "Other CVs". Stored in the send's own `sent_for_area`, so the folder travels with
   * the send exactly as the position does, and a send to a second manager can name a different one.
   */
  folderByCandidate?: Readonly<Record<string, string | null>>;
}): Promise<{ count: number; managerHrId: string; managerName: string; sentAt: string }> {
  if (input.candidates.length === 0) {
    throw new Error("Choose at least one candidate to send.");
  }
  const manager = await notifiedManagerContext(input.managerHrId);
  const managerName = manager.name;
  const names = input.candidates.map((candidate) => candidate.name);
  const many = input.candidates.length > 1;
  // Taken BEFORE the notification rather than after it, because the alert's identity now depends on
  // it. One instant is used for the alert key, the candidate stamp and the fan-out row, so all
  // three agree — reading the clock twice would let a send straddle a minute boundary and key the
  // alert to a minute the stamp does not claim.
  const sentAt = new Date().toISOString();

  await createSystemNotification({
    // The manager's own screen, NOT the CV database. This link pointed at
    // /employee-portals/cv-database until 2026-08-15, which answers anyone who is not Talent
    // Acquisition or Super Admin with "The CV database is available to Talent Acquisition and Super
    // Admin only" — so the entire flow this module exists for ended on a locked door for exactly the
    // District Managers it was built to reach. My Candidates lists the pushes by HR_ID, newest
    // first, so the person named in this alert is at the top whether one or five were sent.
    actionUrl: "/employee-portals/recruitment-candidates",
    // Owner rule 2026-08-24: never email a candidate push. Stated here so the intent is readable
    // where the notification is written; the guarantee is enforceCandidateAssignedEmailBlock, which
    // strips email from the RESOLVED list whatever this line, the policy row, or the
    // Telegram-failure fallback asks for.
    //
    // Telegram added the same day, on the owner's follow-up. It is the channel that actually
    // reaches a District or National Sales Manager in the field, where the portal bell only works
    // once they open it. The recruitment module is governed `enabled: true, genericOnly: false`, so
    // the message goes out in full rather than as an unactionable "you have a notification" ping.
    channels: ["in_app", "telegram", "push"],
    eventType: "candidate_assigned",
    message: `${joinNames(names)} ${many ? "have" : "has"} been sent to you to review.`,
    // WITHOUT THIS, EVERY SEND TO THIS MANAGER IS THE SAME ALERT. The default key is derived from
    // the title, the link, the module and the recipient — all constants here — so alert number two
    // overwrote alert number one, keeping its original date and its already-read state. See
    // candidateAlertIdempotencyKey for the measurements and the three consequences.
    metadata: {
      idempotencyKey: candidateAlertIdempotencyKey({
        candidateIds: input.candidates.map((candidate) => candidate.id),
        eventType: "candidate_assigned",
        managerHrId: input.managerHrId,
        sentAtIso: sentAt,
      }),
    },
    module: "recruitment",
    priority: "normal",
    recipientHrId: input.managerHrId,
    title: many ? `${input.candidates.length} new candidates to review` : "New candidate to review",
  });

  // One update per batch, all the stamp columns together — so a stamp is never half-written and
  // mapCandidate never has to render a send attributed to nobody. Batched through chunkIds because
  // the id list comes from a multi-select and is therefore unbounded (see db-batch.ts).
  //
  // The seat travels WITH the send rather than being joined on render. A manager who moves from
  // Giza to Cairo next month did not retroactively change where last week's CVs went, and an
  // archived leaver must not turn eight recorded sends into blanks — the same reasoning that put
  // manager_notified_name here in the first place, now applied to the title and the area the
  // recruiter's grouping is built on.
  // The three seat columns are NEWER THAN THIS CODE PATH. Code reaches production on a merge to
  // `main` and ships immediately; the migration that adds them is a separate, announced step that
  // happens around it. In the window between the two, PostgREST answers an update naming a column
  // it has never heard of with PGRST204 / 42703 — and this update is the one that records the send,
  // so a bare throw there would mean "Send to manager" is simply broken until somebody runs a
  // migration. It degrades instead: stamp the seat when the columns exist, and record the send
  // WITHOUT the seat when they do not. A send with no seat is what every send looked like
  // yesterday; a send that fails is a regression.
  const identity = {
    manager_notified_at: sentAt,
    manager_notified_hr_id: input.managerHrId,
    manager_notified_name: managerName,
  };
  const seat = {
    manager_notified_area: manager.areaName,
    manager_notified_job_title: manager.jobTitle,
    manager_notified_region: manager.regionName,
  };

  // The position the candidate was sent FOR, when the recruiter named one. Stamped beside the seat
  // and frozen for the same reason: a vacancy that closes or is renamed next month must not re-file
  // a send made today under a folder nobody chose. Empty when no position was given, which is a
  // legitimate send — it was the only kind that existed before 2026-08-28.
  const position = input.position
    ? {
        sent_for_area: input.position.areaName,
        sent_for_job_title: input.position.jobTitle,
        sent_for_line: input.position.lineName,
        sent_for_region: input.position.regionName,
        sent_for_vacancy_id: input.position.vacancyId,
      }
    : {};

  // THREE tiers, not two, and they are ordered widest-first. The seat columns and the position
  // columns arrive in SEPARATE migrations, so a database can genuinely have one and not the other —
  // and folding them into a single optional bucket would mean a missing position column silently
  // dropped the seat as well, undoing yesterday's work to fix today's. Each tier is tried once per
  // send, never once per batch: whether a column exists is a property of the schema, so re-asking
  // per batch would double every write on an un-migrated database.
  const tiers = [
    { ...identity, ...seat, ...position },
    { ...identity, ...seat },
    identity,
  ];

  const supabase = getSupabaseAdmin();
  let tier = 0;
  for (const batch of chunkIds(input.candidates.map((candidate) => candidate.id))) {
    // One update per batch, every column of the chosen tier together — so a stamp is never
    // half-written and mapCandidate never has to render a send attributed to nobody.
    let lastError: unknown = null;
    let written = false;
    while (tier < tiers.length) {
      const attempt = await supabase.from("ats_candidates").update(tiers[tier]).in("id", batch);
      if (!attempt.error) {
        written = true;
        break;
      }
      lastError = attempt.error;
      // Only a missing column drops to a narrower tier. Any other failure is real and must surface:
      // this is the ONLY place a send is recorded, so swallowing it would recreate exactly the
      // invisibility this module exists to end.
      if (!isMissingSeatColumn(attempt.error)) break;
      tier += 1;
    }
    if (!written) throw lastError;
  }

  // THE FAN-OUT ROW — and the reason a CV no longer falls out of the previous manager's list.
  //
  // The columns stamped above hold ONE manager. Sending the same CV to a second person overwrote
  // the first, and what was overwritten was the record of the first send, so it vanished with
  // nothing left behind to notice. Confirmed in production on 2026-08-30: Salim Salim Abdo Ibrahim
  // Gomaa was sent Sara Osama AbdAlfattah at 01:44:22 Cairo and got the alert for her; the same CV
  // went to Hany Saad Mohamed Omar at 01:44:53 and Salim's list dropped to zero while his alert
  // still named her. Owner, asked directly: "yes a CV can go to two managers".
  //
  // Written AFTER the stamp, not instead of it. The old columns still drive the 6-hourly intake
  // digest, the stale-send nudge and the recruiter's own "sent to" line, and keeping them current
  // (last send wins) is also what makes this whole change revertible by dropping one table.
  //
  // Not wrapped in a catch: this is now the row the manager's list is read from, so a failure here
  // is a send that will not be seen, which is precisely the silence this module exists to end. The
  // one tolerated case is the table not existing yet — recordManagerSends returns false rather than
  // throwing for that, because code ships minutes before its migration is applied.
  //
  // One write per FOLDER: a send's folder is the area stored on its own row, and the candidates of one
  // push can belong in different folders of the same manager's shelf.
  const idsByFolder = new Map<string, string[]>();
  for (const candidate of input.candidates) {
    const folder = input.folderByCandidate?.[candidate.id] ?? "";
    idsByFolder.set(folder, [...(idsByFolder.get(folder) ?? []), candidate.id]);
  }
  for (const [folder, candidateIds] of idsByFolder) {
    await recordManagerSends({
      actorHrId: input.actorHrId,
      candidateIds,
      managerArea: manager.areaName,
      managerHrId: input.managerHrId,
      managerJobTitle: manager.jobTitle,
      managerName,
      managerRegion: manager.regionName,
      position: folder ? positionInFolder(input.position ?? null, folder) : (input.position ?? null),
      sentAt,
    });
  }

  return { count: input.candidates.length, managerHrId: input.managerHrId, managerName, sentAt };
}

/**
 * Tell the requisition's hiring manager that a candidate is waiting on their seat, and record it.
 *
 * THROWS on a real delivery failure. That is the deliberate reversal of the old behaviour: the
 * caller decides what a failure means (createApplication logs it and still keeps the assignment;
 * the explicit "Send to manager" button surfaces it to the person who pressed it), but nothing
 * discards it silently any more.
 */
export async function notifyHiringManagerOfCandidate(input: {
  applicationId: string;
  actorHrId: string | null;
  candidateName: string;
  hiringManagerHrId: string | null;
  jobTitle: string;
  /** True when the actor IS the hiring manager — sending them their own alert is noise. */
  actorIsTheManager: boolean;
}): Promise<HiringManagerNotifyResult> {
  if (!input.hiringManagerHrId) return { sent: false, reason: "no_hiring_manager" };
  if (input.actorIsTheManager) return { sent: false, reason: "actor_is_the_manager" };

  const managerName = await hiringManagerName(input.hiringManagerHrId);
  const sentAt = new Date().toISOString();

  await createSystemNotification({
    actionUrl: "/employee-portals/recruitment-candidates",
    // Same owner rule as the push above — the requisition-level assignment is the same event type
    // reaching the same person, so it is silenced by the same guard and carried on the same three
    // channels. The two lists are kept identical deliberately: a manager should not learn about a
    // candidate differently depending on which screen the recruiter happened to start from.
    channels: ["in_app", "telegram", "push"],
    eventType: "candidate_assigned",
    message: `${input.candidateName} has been assigned to your ${input.jobTitle} position.`,
    // The SAME collision as the push above, on the same event type, and it has to be fixed in both
    // places or a manager's alerts collapse depending on which screen the recruiter started from —
    // the exact inconsistency the two call sites are kept identical to avoid. The application is
    // this alert's identity here, since a requisition assignment carries one candidate by
    // construction and the application id is what the manager is being sent to act on.
    metadata: {
      idempotencyKey: candidateAlertIdempotencyKey({
        candidateIds: [input.applicationId],
        eventType: "candidate_assigned",
        managerHrId: input.hiringManagerHrId,
        sentAtIso: sentAt,
      }),
    },
    module: "recruitment",
    priority: "normal",
    recipientHrId: input.hiringManagerHrId,
    title: "New candidate assigned",
  });

  // Written only AFTER the send succeeds, so the history never claims a delivery that did not
  // happen — the exact failure mode this whole module exists to end. Best-effort on its own: a
  // notification that reached the manager must not be reported as failed because the audit row
  // could not be written.
  try {
    await writeApplicationEvent({
      action: MANAGER_NOTIFIED_ACTION,
      actorHrId: input.actorHrId,
      applicationId: input.applicationId,
      details: { managerHrId: input.hiringManagerHrId, managerName, sentAt },
      fromStage: null,
      toStage: null,
    });
  } catch {
    /* the manager has been told; the audit row is a convenience, not the delivery */
  }

  return { sent: true, managerHrId: input.hiringManagerHrId, managerName, sentAt };
}
