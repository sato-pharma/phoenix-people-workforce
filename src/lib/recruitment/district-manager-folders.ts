// Recruitment / ATS — a folder per district manager, and inside it a folder per area he holds.
//
// The owner, 2026-08-31: *"you will make a folder per district manager. Okay? You will make a folder
// per district manager. Each folder has his areas. His areas listed. All his areas in the
// organogram. And populate the folders based on the CVs we receive. So if you need a CV from any
// area, he click the folder and open he find all CVs."*
//
// ── THE SHAPE SOLVES A PROBLEM THE FLAT VERSION HAD ─────────────────────────────────────────────
//
// An area is not owned by one person. Nasr City is a rep seat on Anti Infective AND on CNS AND on
// Pedia, under three different district managers. Routing a Nasr City CV to "the manager for Nasr
// City" therefore has no single right answer, and 28 candidates sit in areas with open seats on two
// lines at once. A folder PER MANAGER dissolves that: the same CV appears in the Anti Infective DM's
// Nasr City folder and in the Pedia DM's Nasr City folder, and each of them sees only his own. No
// applicant has to be asked which line they meant, and nothing is routed to the wrong person.
//
// ── ALL HIS AREAS, NOT THE ONES WITH CVs ────────────────────────────────────────────────────────
//
// He said "all his areas in the organogram", and the empty ones carry the information: a district
// manager looking at eight folders of which three are empty knows those three have had no
// applicants. A screen that lists only the areas with CVs reads as "these are my areas", which is
// false, and the day a CV arrives for a ninth the list silently grows.
//
// ── THE ORGANOGRAM IS READ, NEVER COPIED ────────────────────────────────────────────────────────
//
// The folder set is derived at read time from `au_v_org_tree`, the same tree the Organogram screen
// and the vacancy escalation read. It is deliberately NOT stored. A stored copy is a second source
// of truth that goes stale on the next reorganisation, and the owner's standing rule is that the AU
// seat model IS the truth for org structure. Nothing here writes.
//
// ── WHO OPENS A DISTRICT WHOSE MANAGER SEAT IS EMPTY ────────────────────────────────────────────
//
// Two real DM seats in production are vacant — PEDIA Alex-BHR and PEDIA Cairo, 11 areas between them
// — and their folders would otherwise belong to nobody. They climb to the nearest occupied seat
// above, which is the answer the owner already gave for the identical case on the send path ("route
// him to the district manager's manager"), reusing that module's own climb rather than a second copy.
//
// PURE — no database, no React. Same rule as candidate-folder.ts and for the same reason: this is
// reached from a "use client" screen, so a database import anywhere in the chain would drag the
// service-role client into the browser bundle. The loader lives in district-manager-folders-db.ts.

import { canonicalHrIdKey } from "@/lib/hr-id";
import { resolveBackgroundStanding } from "@/lib/recruitment/background-review";
import { canFileCandidate } from "@/lib/recruitment/candidate-folder";
import { areaGovernedByCv, areaNamedByCv } from "@/lib/recruitment/cv-address-place";
import {
  candidateRegionForGovernorate,
  candidateRegionLabels,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import {
  climbToOccupiedSeat,
  MANAGER_SEAT_COLUMNS,
  type ManagerSeatRow,
} from "@/lib/recruitment/vacancy-manager-escalation";
import type { Candidate } from "@/lib/recruitment/types";

/** One `au_v_org_tree` row, narrowed to what this module reads. */
export type DistrictSeatRow = ManagerSeatRow & {
  area_name?: string | null;
  is_other_pseudo_dm?: boolean | null;
};

export const DISTRICT_SEAT_COLUMNS = `${MANAGER_SEAT_COLUMNS},area_name,is_other_pseudo_dm`;

/**
 * The tiers that hold a district's areas.
 *
 * ACTING_DM belongs beside DM and is not an edge case: ANTI_INFECTIVE Upper Egypt 1 is a rep acting
 * as district manager, holding Beni Suef, Minia 1 and Minia 2, and reporting straight to the NSM.
 * Leaving the tier out would make three real areas belong to nobody — and the failure would look
 * like "no applicants for Upper Egypt", not like a missing tier.
 */
const DISTRICT_TIERS = new Set(["DM", "ACTING_DM"]);

/**
 * Everything this module reads off a candidate — structural, so a fixture need not be whole.
 *
 * THE LAST FIELDS ARE WHAT MAKES THE HISTORICAL POOL ROUTABLE, and they are a weaker kind of
 * evidence than the first ones on purpose. A CV that arrived by email in February named no area and
 * answered no question — the questions did not exist yet. All it carries is the address and
 * governorate its own text mentions and whatever faculty the extractor read off it.
 *
 * `address` IS THE ONE THAT WAS BEING THROWN AWAY. Until 2026-09-03 this rule read `governorate`
 * and stopped, so a CV whose address says "Nasr City" carried the same information as one that says
 * only "Cairo" — both resolved to a region and both landed in the "No area named" folder. The
 * address is the longer and more specific string, and cv-address-place.ts has been able to read an
 * area out of it since 2026-08-28; nothing here could reach that until it moved.
 */
export type DistrictFolderCandidate = Pick<
  Candidate,
  | "id"
  | "fullName"
  | "preferencesDeclaredAt"
  | "preferredAreaName"
  | "status"
  | "folder"
  | "preferredRegionCode"
  | "preferredRegionName"
  | "address"
  | "governorate"
  | "faculty"
  | "declaredBackground"
  | "backgroundConfirmedOutcome"
  | "backgroundConfirmedAt"
  | "backgroundConfirmedByHrId"
>;

/** One folder inside one manager's set: an area he holds, or the district's one catch-all. */
export type DistrictAreaFolder<T = DistrictFolderCandidate> = {
  areaName: string;
  /**
   * "area" is a folder for one named area, filled by applicants who asked for that area by name.
   *
   * "region" is the single catch-all that closes every district, filled by CVs that reached the
   * REGION and never named an area — almost entirely the historical pool. It is a separate kind
   * rather than another area folder because the two are not equally trustworthy: an area folder
   * holds people who said where they want to work, and this one holds people whose CV mentioned a
   * governorate. Mixing them would launder the second into the first.
   */
  kind: "area" | "region";
  candidates: T[];
  /**
   * The ids in `candidates` that got here because their CV's own text named this area, rather than
   * because the applicant declared it. Empty on a catch-all, and empty on an area folder nobody
   * reached that way.
   *
   * IT EXISTS SO THE FOLDER CAN STAY HONEST WITHOUT BEING EMPTY. The owner's instruction was to
   * stop dumping readable CVs into "No area named", and the answer is to read the address — but an
   * address is still not an answer to "where do you want to work", and a manager ringing somebody
   * should know which of the two he is holding. So the CV goes in the right folder AND the folder
   * says which ones arrived that way; the alternative, a third folder kind, would just be "No area
   * named" again under a politer name.
   */
  fromCvText: string[];
  /**
   * The ids in `candidates` that got here because their CV named a GOVERNORATE served by exactly
   * one area — this one. Weaker evidence than `fromCvText` and kept apart from it for that reason.
   *
   * A folder cannot describe these two the same way without saying something false. "The address
   * on their CV places them here" is true of `fromCvText`; most of these have no address at all
   * and reached the folder because their governorate has only one area in it. Same folder, and the
   * screen says which is which.
   */
  fromGovernorate: string[];
};

/**
 * What the catch-all folder is called on screen.
 *
 * Read under the district's own heading — "Anti Infective · Cairo" — it says exactly what is in it.
 * Not "Other" and not "Unassigned": both of those read as a status somebody gave the CV, and this
 * is the absence of an answer, not a decision about one.
 */
export const REGION_FOLDER_LABEL = "No area named";

/** One district manager's whole shelf: every area he holds, each with what has arrived for it. */
export type DistrictManagerBoard<T = DistrictFolderCandidate> = {
  seatId: string;
  /** The organogram's own label for the seat, e.g. "ANTI_INFECTIVE Delta (1) DM". */
  seatLabel: string;
  lineName: string | null;
  regionName: string | null;
  /**
   * Who opens these folders. Null only when the seat is empty AND nothing above it is occupied —
   * the folders are then shown to nobody rather than to a guess.
   */
  managerHrId: string | null;
  /**
   * The vacant post whose folders these are, when the holder is standing in from above. Null in the
   * ordinary case. Set, a screen says so — a manager opening a district that is not his own should
   * be told why it is in front of him.
   */
  coveringVacantSeat: string | null;
  folders: DistrictAreaFolder<T>[];
  candidateCount: number;
};

/**
 * A CV that named a place and still reached no folder, and the reason — never a guess, never
 * silence. This list belongs to the recruitment team, not to a manager: every row is somebody who
 * told us where they are and whom nobody will ever see unless a person acts.
 */
export type UnplacedDeclaration = {
  candidateId: string;
  candidateName: string | null;
  /** The place they named — an area when they declared one, otherwise the region it resolved to. */
  declaredArea: string;
  reason:
    | "no-such-area"
    | "area-reads-two-ways"
    /** The region is real but no district covers it. "Others" is the whole of this case today: it
     *  exists as a sales bucket, its three seats are pseudo-DMs holding no areas, and nobody is
     *  hired into one. An applicant from Marsa Matrouh genuinely has no district manager. */
    | "no-district-for-region"
    /** Eligible, and their CV mentions no governorate, no region and no area at all. */
    | "no-place-named";
};

/**
 * One key for an area name, tolerant of how it was typed.
 *
 * Everything that is not a letter or a digit is dropped, so "Kafr El Sheikh 1" finds the
 * organogram's "Kafr El-Sheikh 1" — a real declaration in production that an exact match missed on
 * one hyphen. Case is folded for the same reason.
 *
 * IT DOES NOT GUESS BEYOND THAT, and the ones it refuses are the point. "Qena", "Qena north" and
 * "Minia Government" all name a governorate the organogram splits into two areas; a prefix or
 * fuzzy match would pick one of them, and a CV in the wrong district manager's folder is a CV the
 * right manager never sees. Those go to `unplaced` for a person to answer.
 */
export function areaFolderKey(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function text(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/** Shared empty set so the common no-suppressions call allocates nothing. */
const EMPTY_SUPPRESSIONS: ReadonlySet<string> = new Set<string>();

/**
 * One key for a REGION name, tolerant of the one way the organogram splits a region and the apply
 * flow does not.
 *
 * THIS EXISTS FOR A SINGLE MEASURED FAILURE. Production's districts carry nine distinct region
 * names — Alex-BHR, Cairo, Delta (1), Delta (2), Delta (3), Giza, Upper Egypt, Upper Egypt 1,
 * Upper Egypt 2 — while the apply flow offers eight regions, of which "Upper Egypt" is one. CNS and
 * Pedia hold a single "Upper Egypt" district each and match it exactly; Anti Infective splits the
 * same ground into "Upper Egypt 1" and "Upper Egypt 2", which match nothing. Under a plain
 * name comparison, all 62 Upper Egypt CVs in the historical pool reach the two lines that spell it
 * plainly and NEVER reach anti-infective — and the anti-infective manager reads an empty folder as
 * "nobody has applied from Upper Egypt", which is the opposite of the truth.
 *
 * SO A TRAILING BARE NUMBER IS DROPPED, AND A PARENTHESISED ONE IS NOT. That distinction is the
 * whole rule, and it is not cosmetic: "Upper Egypt 1" and "Upper Egypt 2" are two halves of one
 * region, so both belong to an Upper Egypt applicant, while "Delta (1)", "Delta (2)" and
 * "Delta (3)" are three DIFFERENT regions that an applicant picks between by name. Stripping the
 * number from those would collapse the three into one and hand every Delta CV to all three
 * districts at once — and Delta (3) is the anti-infective-only territory the owner moved five areas
 * into on 2026-09-01, so over-matching there is exactly the wrong direction to be wrong in.
 */
export function regionFamilyKey(value: string | null | undefined): string {
  const cleaned = String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
  if (!cleaned) return "";
  const family = cleaned.endsWith(")") ? cleaned : cleaned.replace(/\s+\d+$/, "");
  return family.replace(/[^a-z0-9]/g, "");
}

/**
 * Which region a CV routes to when it named no area, or null when it names no place at all.
 *
 * THREE SOURCES, STRONGEST FIRST, and they are not equally good evidence.
 *
 * A tapped region code and a typed region name are both ANSWERS — the applicant was asked where
 * they want to work and said. A governorate is not: it is where the CV says they live, read off the
 * document by the extractor, and someone living in Tanta may well be applying for Cairo. It is used
 * anyway because for the entire historical pool it is the only thing there is, and a CV nobody can
 * see helps no one — but that is precisely why everything this resolves lands in a folder labelled
 * "No area named" rather than beside people who asked for the area by name.
 *
 * The region NAME is returned rather than the code, because a district carries a name and the match
 * happens on `regionFamilyKey`. A code we do not recognise falls through to the next source rather
 * than being echoed back as if it were a region.
 */
export function districtRoutingRegion(candidate: DistrictFolderCandidate): string | null {
  const declaredCode = text(candidate.preferredRegionCode).toUpperCase();
  const codedLabel = declaredCode
    ? (candidateRegionLabels[declaredCode as CandidateRegionCode] as string | undefined)
    : undefined;
  if (codedLabel) return codedLabel;

  const declaredName = text(candidate.preferredRegionName);
  if (declaredName) return declaredName;

  const fromGovernorate = candidateRegionForGovernorate(candidate.governorate);
  return fromGovernorate ? candidateRegionLabels[fromGovernorate] : null;
}

function indexBySeatId(rows: readonly DistrictSeatRow[]): Map<string, DistrictSeatRow> {
  const index = new Map<string, DistrictSeatRow>();
  for (const row of rows) {
    const seatId = text(row.seat_id);
    if (seatId) index.set(seatId, row);
  }
  return index;
}

/**
 * Every district manager's folder set, empty of candidates.
 *
 * The "Others" pseudo-DM seats are excluded. There are three of them, one per line, and they exist
 * to carry sales that belong to no district — they hold no areas, nobody sits in them, and nobody is
 * ever hired into one. Listing them would put three permanently empty districts in front of an NSM.
 */
export function districtManagerBoards<T = DistrictFolderCandidate>(
  rows: readonly DistrictSeatRow[],
): DistrictManagerBoard<T>[] {
  const bySeatId = indexBySeatId(rows);

  // Areas hang off the REP seats beneath a district, so they are collected by parent rather than
  // read off the district row itself — a DM seat carries the region, not the areas.
  const areasBySeatId = new Map<string, Set<string>>();
  for (const row of rows) {
    const parentSeatId = text(row.parent_seat_id);
    const areaName = text(row.area_name);
    if (!parentSeatId || !areaName) continue;
    const areas = areasBySeatId.get(parentSeatId);
    if (areas) areas.add(areaName);
    else areasBySeatId.set(parentSeatId, new Set([areaName]));
  }

  const boards: DistrictManagerBoard<T>[] = [];
  for (const row of rows) {
    if (!DISTRICT_TIERS.has(text(row.seat_tier).toUpperCase())) continue;
    if (row.is_other_pseudo_dm === true) continue;

    const seatId = text(row.seat_id);
    if (!seatId) continue;

    const areaNames = [...(areasBySeatId.get(seatId) ?? new Set<string>())].sort((left, right) =>
      left.localeCompare(right),
    );
    // A district with no areas beneath it is a seat nobody could file into. It is not an error and
    // it is not worth a folder set; the pseudo-DMs above are the ordinary case of it.
    if (areaNames.length === 0) continue;

    // The occupant is trusted only when `is_vacant` does not veto it. Either signal alone has a
    // failure mode: a vacated seat can keep a stale occupant, and an occupied one can carry a blank
    // id — the same pairing the send path uses, for the same reason.
    const occupant = text(row.occupant_hr_id);
    const seated = occupant && row.is_vacant !== true;
    const standIn = seated ? null : climbToOccupiedSeat(seatId, bySeatId);

    // The label of the empty post being covered. The climb names the FIRST vacant seat it passed,
    // which is this one in the ordinary case; falling back to this row's own label keeps the note
    // truthful when the climb ran out of tree entirely and returned nobody.
    const vacantSeatLabel = standIn?.coveredSeatLabel ?? (text(row.seat_display_label) || null);

    boards.push({
      candidateCount: 0,
      coveringVacantSeat: seated ? null : vacantSeatLabel,
      // Every area he holds, then ONE catch-all closing the district. The catch-all is always
      // present, empty or not, for the same reason the empty area folders are: a manager has to be
      // able to SEE that nothing arrived, rather than infer it from a folder that is not on screen.
      folders: [
        ...areaNames.map((areaName) => ({
          areaName,
          candidates: [] as T[],
          fromCvText: [] as string[],
          fromGovernorate: [] as string[],
          kind: "area" as const,
        })),
        {
          areaName: REGION_FOLDER_LABEL,
          candidates: [] as T[],
          fromCvText: [] as string[],
          fromGovernorate: [] as string[],
          kind: "region" as const,
        },
      ],
      lineName: text(row.line_name) || null,
      managerHrId: seated ? occupant : (standIn?.hrId ?? null),
      regionName: text(row.region_name) || null,
      seatId,
      seatLabel: text(row.seat_display_label) || seatId,
    });
  }

  return boards.sort(
    (left, right) =>
      (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
      (left.regionName ?? "").localeCompare(right.regionName ?? ""),
  );
}

/**
 * One key for "manager M has handed candidate C back", shared by the placement rule below and by the
 * loader that reads the returns table (district-returns.ts). BOTH sides route the hr id through
 * `canonicalHrIdKey`, so the case stored in the table never has to agree with the case the org tree
 * carries — the same normalisation `boardsForManager` already leans on. The candidate id is a uuid
 * and stable, so it is used verbatim.
 *
 * A return is per MANAGER, not per CV: the same Nasr City CV sits in three managers' folders, and a
 * return by one of them must leave it untouched for the other two. Keying the suppression on the
 * manager as well as the candidate is what makes that true.
 */
export function districtReturnSuppressionKey(
  managerHrId: string | null | undefined,
  candidateId: string,
): string {
  return `${canonicalHrIdKey(managerHrId) ?? ""}::${text(candidateId)}`;
}

/**
 * The same boards, with every candidate dropped into every folder that should hold them.
 *
 * ── THREE WAYS IN, AND THE LAST TWO ARE THE BACKFILL ────────────────────────────────────────────
 *
 * BY AREA: the applicant went through the apply flow and named an area. `preferencesDeclaredAt` is
 * the gate rather than `preferredAreaName` alone, because that column is ALSO written by the CV
 * extractor reading a career off a PDF — filing on it would place people by where they once worked
 * rather than where they asked to work. candidate-folder-suggestion.ts makes the same choice.
 *
 * BY THE ADDRESS ON THEIR CV: the same archive, read properly. An address naming an area outright,
 * or naming a neighbourhood inside one, files into that AREA folder — see the tier itself below for
 * the owner's instruction and for why one match or none. It is marked `fromCvText` so the folder
 * can say which of its CVs arrived that way.
 *
 * BY REGION: the owner, 2026-08-31 — *"you will start backfilling from the historicals ... the two
 * hundred eligible, you will backfill them. But anyone non eligible, you will make the admin be
 * able to check first their CV and confirm."* NOT ONE of the 420 live historical CVs declared an
 * area; they predate the question being asked, so an area-only rule reaches exactly none of them.
 * What is left after the address has been read is a CV naming a governorate and nothing finer. Its
 * region resolves to every district covering it, and there it lands in that district's "No area
 * named" folder — a weaker answer, labelled as one, and now genuinely the weakest one there is.
 *
 * ── WHO IS HELD BACK, AND THE ASYMMETRY IS THE IMPORTANT LINE ───────────────────────────────────
 *
 * Refused on BOTH paths: a rejected CV (`canFileCandidate`, the recruiter's own rule imported
 * rather than restated — a manager opening a folder next March should not find people already
 * turned down sitting in it); a CV an admin has already shelved as paramedical; and a CV whose
 * STANDING is paramedical — an admin's confirmation when there is one, the judge's reading of the
 * faculty when there is not. The shelf check is here rather than inside `canFileCandidate`:
 * filing a paramedical CV onto the paramedical shelf must stay legal, and it is only ROUTING one to
 * a hiring manager that is wrong.
 *
 * Required on the REGION path ONLY: a positive `eligible` verdict. On the area path an applicant
 * asked us for a named area, and demanding a readable faculty on top of that would silently empty
 * folders that are populated today — most CVs sitting in district folders right now carry no
 * declared background at all, and fall to `unknown` on a faculty string the parser cannot read.
 * The region path is the opposite case: nobody asked to be routed, we are reaching into the archive
 * on the owner's instruction, and his instruction is explicit that anything not eligible waits for
 * an admin to open the CV and confirm. `unknown` there is not a refusal, it is a queue.
 */
export function placeCandidatesInDistrictFolders<T extends DistrictFolderCandidate>(input: {
  rows: readonly DistrictSeatRow[];
  candidates: readonly T[];
  /**
   * The returns a manager has made — keys from `districtReturnSuppressionKey`. A candidate carrying
   * a key for a given board's manager is dropped from THAT board only; every other line that shares
   * the area keeps him. Omitted by the whole-company report loader on purpose (a returned CV was
   * still received), and passed only by the manager-scoped folder loader. See district-returns.ts.
   */
  suppressedReturns?: ReadonlySet<string>;
}): { boards: DistrictManagerBoard<T>[]; unplaced: UnplacedDeclaration[]; placements: number } {
  const boards = districtManagerBoards<T>(input.rows);
  const suppressed = input.suppressedReturns ?? EMPTY_SUPPRESSIONS;

  type Target = { board: DistrictManagerBoard<T>; folder: DistrictAreaFolder<T> };

  // One key per area name, and any key two different areas would share is REMOVED rather than
  // resolved. No such collision exists in production today — all 40 area names key uniquely — but
  // the failure if one appeared is a CV silently filed under whichever area happened to be indexed
  // last, and "I could not tell these apart" is an answer a person can act on.
  //
  // The catch-alls are skipped throughout: every district's is called the same thing, so indexing
  // them by area name would mark that name ambiguous and then swallow any applicant who typed it.
  const areaByKey = new Map<string, string>();
  const ambiguousKeys = new Set<string>();
  for (const board of boards) {
    for (const folder of board.folders) {
      if (folder.kind !== "area") continue;
      const key = areaFolderKey(folder.areaName);
      if (!key) continue;
      const seen = areaByKey.get(key);
      if (seen === undefined) areaByKey.set(key, folder.areaName);
      else if (seen !== folder.areaName) ambiguousKeys.add(key);
    }
  }

  // Which folders hold a given area, across every district. An area is on up to three lines at once,
  // which is the whole reason this is a list rather than a lookup.
  const foldersByKey = new Map<string, Target[]>();
  for (const board of boards) {
    for (const folder of board.folders) {
      if (folder.kind !== "area") continue;
      const key = areaFolderKey(folder.areaName);
      if (!key || ambiguousKeys.has(key)) continue;
      const list = foldersByKey.get(key);
      if (list) list.push({ board, folder });
      else foldersByKey.set(key, [{ board, folder }]);
    }
  }

  // And the same for the catch-alls, keyed by region FAMILY so that one Upper Egypt applicant
  // reaches Upper Egypt 1 and Upper Egypt 2 as well as the two lines that spell it plainly.
  const catchAllsByRegion = new Map<string, Target[]>();
  for (const board of boards) {
    const key = regionFamilyKey(board.regionName);
    const folder = board.folders.find((entry) => entry.kind === "region");
    if (!key || !folder) continue;
    const list = catchAllsByRegion.get(key);
    if (list) list.push({ board, folder });
    else catchAllsByRegion.set(key, [{ board, folder }]);
  }

  const unplaced: UnplacedDeclaration[] = [];
  let placements = 0;

  const fileInto = (
    targets: readonly Target[],
    candidate: T,
    via: "declared" | "cv-text" | "governorate" = "declared",
  ): void => {
    for (const target of targets) {
      // A CV the board's own manager has returned is dropped HERE, at the single choke point every
      // placement passes through, so both the area path and the region catch-all honour it with no
      // second copy. The skip is silent by design: the CV is not "unplaced" (it matched a folder
      // fine — a person chose to hand it back), and it stays in every OTHER manager's folder because
      // the key carries this target's manager, not the candidate alone.
      if (
        suppressed.size > 0 &&
        suppressed.has(districtReturnSuppressionKey(target.board.managerHrId, candidate.id))
      ) {
        continue;
      }
      target.folder.candidates.push(candidate);
      if (via === "cv-text") target.folder.fromCvText.push(candidate.id);
      if (via === "governorate") target.folder.fromGovernorate.push(candidate.id);
      target.board.candidateCount += 1;
      placements += 1;
    }
  };

  // The company's area names, minus any two areas share — the same list `foldersByKey` was built
  // from, so an area this offers is always an area a folder exists for. Built once: the resolver
  // walks it per candidate, and rebuilding it 600 times would be the only slow thing here.
  const routableAreaNames = [...areaByKey.entries()]
    .filter(([key]) => !ambiguousKeys.has(key))
    .map(([, areaName]) => areaName);

  for (const candidate of input.candidates) {
    if (!canFileCandidate(candidate)) continue;
    if (candidate.folder?.kind === "paramedical") continue;

    // The STANDING, not the judge's verdict. An admin who has read the CV outranks the parser in
    // both directions: a confirmed-eligible graduate whose faculty string is unreadable routes, and
    // a confirmed-paramedical one stops routing even if "Faculty of Pharmacy" is printed on it.
    // Reading judgeBackground directly here would make the admin's answer decorative.
    const standing = resolveBackgroundStanding(candidate);
    if (standing.outcome === "paramedical") continue;

    // ── The area they named ────────────────────────────────────────────────────────────────────
    const declaredArea = text(candidate.preferencesDeclaredAt)
      ? text(candidate.preferredAreaName)
      : "";
    const areaKey = declaredArea ? areaFolderKey(declaredArea) : "";
    if (declaredArea) {
      const targets = areaKey && !ambiguousKeys.has(areaKey) ? foldersByKey.get(areaKey) : undefined;
      if (targets && targets.length > 0) {
        fileInto(targets, candidate);
        continue;
      }
    }

    // A named area that matched nothing is REPORTED whatever the verdict, which is what this list
    // was for before the region path existed. Only then is the eligible-only gate applied, so
    // adding the backfill did not quietly shorten the recruiter's list of people nobody can see.
    if (standing.outcome !== "eligible") {
      if (declaredArea) {
        unplaced.push({
          candidateId: candidate.id,
          candidateName: candidate.fullName ?? null,
          declaredArea,
          reason: ambiguousKeys.has(areaKey) ? "area-reads-two-ways" : "no-such-area",
        });
      }
      // Nothing is recorded for the rest. The admin queue IS their record, and repeating them here
      // would fill the "nobody can see these" list with people somebody is already looking at.
      continue;
    }

    // ── The area their own CV names, when they declared none ──────────────────────────────────
    //
    // The owner, 2026-09-03: *"do a fucking effort for the areas that you're putting in a folder
    // that you're calling a no area name. Do an effort that's extracted from the CV already."*
    //
    // He is right that it was already extracted. `address` has been on these rows the whole time,
    // and cv-address-place.ts has read an English address down to an Arabic brick name since
    // 2026-08-28 — a CV saying "Nasr City" or "Helmeyet El-Zeitoun" names an area outright or names
    // somewhere inside one. This rule read `governorate` and nothing else, so both of those landed
    // in the catch-all beside a CV that said only "Cairo", which is a strictly worse answer than the
    // evidence supported.
    //
    // IT SITS BELOW THE ELIGIBILITY GATE ON PURPOSE, in the region path's half of the function
    // rather than beside the declared-area path above. This is the archive being reached into, not
    // an applicant asking for something, and the owner's instruction on the archive was explicit:
    // "anyone non eligible, you will make the admin be able to check first their CV and confirm."
    // An address is a better answer than a governorate; it is not a reason to skip a person.
    //
    // ONE AREA OR NONE — `areaNamedByCv` refuses a tie rather than choosing, and the fallback is the
    // catch-all directly below, which is exactly where the CV would have gone anyway. So the whole
    // of the downside here is that a CV stays where it already was.
    if (routableAreaNames.length > 0) {
      const fromCv = areaNamedByCv(candidate, routableAreaNames);
      const cvTargets = fromCv ? foldersByKey.get(areaFolderKey(fromCv.areaName)) : undefined;
      if (cvTargets && cvTargets.length > 0) {
        fileInto(cvTargets, candidate, "cv-text");
        continue;
      }
    }

    // ── The governorate, when it holds exactly one area ────────────────────────────────────────
    //
    // The owner, 2026-09-03, asked the question directly and answered it: a candidate whose only
    // location is the governorate, where that governorate is served by ONE area, goes in that area's
    // folder. Beni Suef, Fayoum, Kafr El-Sheikh, Port Said, Suez and Damietta are the six where that
    // holds today; for the twelve governorates split across two or more areas this resolves to
    // nothing and the CV drops to the catch-all below, unchanged.
    //
    // It is the weakest of the three routes and it is last for that reason. What makes it right
    // rather than a guess is that the area and the governorate are the same ground: telling a
    // Fayoum candidate's manager "no area named" when Fayoum IS the area names nothing he does not
    // already know, and hides a person in a folder built for people who cannot be placed.
    if (routableAreaNames.length > 0) {
      const governed = areaGovernedByCv(candidate, routableAreaNames);
      const govTargets = governed ? foldersByKey.get(areaFolderKey(governed.areaName)) : undefined;
      if (govTargets && govTargets.length > 0) {
        fileInto(govTargets, candidate, "governorate");
        continue;
      }
    }

    // ── The region, when their CV names no area either ─────────────────────────────────────────
    // "Qena" is not an area here — the organogram splits it into Qena 1 and Qena 2 — but it is
    // unmistakably Upper Egypt, and a district's catch-all is a better answer than nobody at all.
    const regionName = districtRoutingRegion(candidate);
    if (!regionName) {
      unplaced.push({
        candidateId: candidate.id,
        candidateName: candidate.fullName ?? null,
        declaredArea,
        reason: declaredArea
          ? ambiguousKeys.has(areaKey)
            ? "area-reads-two-ways"
            : "no-such-area"
          : "no-place-named",
      });
      continue;
    }

    const catchAlls = catchAllsByRegion.get(regionFamilyKey(regionName));
    if (!catchAlls || catchAlls.length === 0) {
      unplaced.push({
        candidateId: candidate.id,
        candidateName: candidate.fullName ?? null,
        declaredArea: declaredArea || regionName,
        reason: "no-district-for-region",
      });
      continue;
    }

    fileInto(catchAlls, candidate);
  }

  return { boards, placements, unplaced };
}

/**
 * The boards this person opens.
 *
 * Matched through `canonicalHrIdKey` rather than a plain equality. HR_IDs here are mixed case and a
 * bare comparison has already under-returned by 28% elsewhere in this codebase; a district manager
 * whose id is spelled one way in the org tree and another in the session would see an empty screen
 * and read it as "no CVs", which is the wrong lesson entirely.
 *
 * More than one board can come back, and that is correct: a manager holding two district seats holds
 * two sets of areas, and merging them would hide which line an applicant is for.
 */
export function boardsForManager<T>(
  boards: readonly DistrictManagerBoard<T>[],
  managerHrId: string | null | undefined,
): DistrictManagerBoard<T>[] {
  const key = canonicalHrIdKey(managerHrId);
  if (!key) return [];
  return boards.filter((board) => canonicalHrIdKey(board.managerHrId) === key);
}
