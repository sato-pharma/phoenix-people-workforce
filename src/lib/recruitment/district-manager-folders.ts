// Recruitment / ATS — a folder per district manager, and inside it a folder per area he holds; plus,
// since 2026-09-09, a folder per district for the sales manager ABOVE him, holding the people
// applying for his job.
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
import { areaGovernedByCv, areaNamedByCv, governorateNamedBy } from "@/lib/recruitment/cv-address-place";
import {
  candidateRegionForGovernorate,
  candidateRegionLabels,
  type CandidateRegionCode,
} from "@/lib/recruitment/candidate-region";
import {
  candidateManagerSeatTier,
  managerSeatCanReceive,
  type CandidateManagerSeatTier,
} from "@/lib/recruitment/candidate-seat-rank";
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
  // The two title columns, and the resolved answer when a richer loader has already filled it. They
  // decide WHICH manager may receive this CV, never which folder it lands in — see
  // candidate-seat-rank.ts. `mapCandidate` fills both columns straight off the row, so the folder
  // loader pays nothing extra for them.
  | "appliedForJobTitle"
  | "currentJobTitle"
  | "appliedFor"
  | "preferencesDeclaredAt"
  | "preferredAreaName"
  | "status"
  | "folder"
  | "preferredRegionCode"
  | "preferredRegionName"
  | "address"
  | "governorate"
  | "faculty"
  // The degree line joins the eligibility rule here for the same reason it joined it in
  // candidate-background.ts (2026-09-28): this routing reads `resolveBackgroundStanding`, so a Pick
  // without `degree` would judge a CV on its faculty alone while every other screen judged it on
  // both — the same candidate routing in one place and not the other. The typechecker caught exactly
  // that, and `degree` is already in CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS, so the loader that
  // fills these rows pays nothing for it.
  | "degree"
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
   *
   * "district" is a WHOLE DISTRICT, and it appears only on the manager boards added 2026-09-09 — the
   * folders in which a national or regional sales manager reads applications for a district manager
   * post. A person applying to RUN Delta (1) is not applying for a rep seat inside it, so splitting
   * those CVs across the district's areas would be a distinction the applicant never made. The
   * evidence markers below still apply: the area they named is what places them in this district.
   */
  kind: "area" | "region" | "district";
  /**
   * The district seat this folder stands for. Set on a "district" folder and on nothing else — it is
   * what lets the placement rule send an applicant for Delta (1) to every manager above Delta (1)
   * without either side re-deriving which district an area belongs to.
   */
  districtSeatId?: string | null;
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
  /**
   * WHOSE JOB THE APPLICANTS IN HERE ARE APPLYING FOR — the one field that keeps a district manager
   * out of his own succession.
   *
   * "reps" is every board that existed before 2026-09-09: a district's areas, held by its district
   * manager, filled with people applying for a rep seat inside it.
   *
   * "district_managers" is the board added that day, held by the regional or national sales manager
   * ABOVE a district and filled with applications for the district manager post itself. The owner:
   * *"a district manager never receives district manager."* The two are separate boards rather than
   * one board with a filter because they have different HOLDERS, and the holder is what every scope
   * check on this data keys on.
   */
  intake: "reps" | "district_managers";
  /**
   * The org tree's own tier for the seat this board belongs to — "DM"/"ACTING_DM" on a rep board,
   * "RSM"/"NSM" on a manager board. Carried so the rank comparison happens against the seat rather
   * than against a job title somebody typed.
   */
  seatTier: string | null;
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

/**
 * Every region this candidate could reasonably be routed to, best answer first.
 *
 * WHY THIS IS A LIST AND NOT ONE ANSWER. `districtRoutingRegion` returns the region they NAMED
 * before it will look at their governorate, which is right — an answer somebody gave outranks one
 * read off a CV. But `preferred_region_name` is free text, and when what was typed matches no
 * district at all the old code stopped there and reported "no district for region", with the
 * governorate sitting unread on the same row. Seven candidates were invisible to every district
 * manager that way on 2026-09-03, and all seven had named Upper Egypt: "UE ( 1 )", "Upper (1)",
 * "Uper Egypt 1", '"Upper Egypt 1 "' quotes included, and three who typed a governorate ("Qena",
 * "Minya", "Minia Government ( Minia North )") into the region box. Upper Egypt has four boards.
 *
 * So the typed answer is still tried FIRST and still wins whenever it names a real district. The
 * legs below it only ever run when it names none, which is precisely when the alternative is
 * nobody. The last leg reads the governorate out of the address, because one of the seven had no
 * `governorate` column at all and an address that said "El-Minia Governorate".
 *
 * ORDERED, DE-DUPLICATED BY REGION FAMILY, and never empty-padded: a caller takes the first entry
 * that has a district, and falls back to the first entry overall so the unplaced report still names
 * what the person actually said rather than something inferred underneath it.
 */
export function districtRoutingRegionOptions(candidate: DistrictFolderCandidate): string[] {
  const options: string[] = [];
  const push = (value: string | null | undefined): void => {
    const name = text(value);
    if (!name) return;
    const family = regionFamilyKey(name);
    if (options.some((existing) => regionFamilyKey(existing) === family)) return;
    options.push(name);
  };

  push(districtRoutingRegion(candidate));

  const fromGovernorate = candidateRegionForGovernorate(candidate.governorate);
  push(fromGovernorate ? candidateRegionLabels[fromGovernorate] : null);

  const addressGovernorate = governorateNamedBy(candidate.address);
  const fromAddress = addressGovernorate ? candidateRegionForGovernorate(addressGovernorate) : null;
  push(fromAddress ? candidateRegionLabels[fromAddress] : null);

  return options;
}

export function indexBySeatId(rows: readonly DistrictSeatRow[]): Map<string, DistrictSeatRow> {
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
      intake: "reps",
      managerHrId: seated ? occupant : (standIn?.hrId ?? null),
      regionName: text(row.region_name) || null,
      seatId,
      seatLabel: text(row.seat_display_label) || seatId,
      seatTier: text(row.seat_tier).toUpperCase() || null,
    });
  }

  return boards.sort(
    (left, right) =>
      (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
      (left.regionName ?? "").localeCompare(right.regionName ?? ""),
  );
}

/**
 * Every seat id above `seatId`, nearest first. Stops on a cycle rather than looping — an org tree
 * with one is broken, and a chain invented out of it would be indistinguishable from a real one.
 */
export function ancestorSeatIds(seatId: string, bySeatId: Map<string, DistrictSeatRow>): string[] {
  const chain: string[] = [];
  const visited = new Set<string>([seatId]);
  let current = text(bySeatId.get(seatId)?.parent_seat_id ?? "");
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.push(current);
    current = text(bySeatId.get(current)?.parent_seat_id ?? "");
  }
  return chain;
}

/**
 * The boards on which a regional or national sales manager reads applications for a DISTRICT MANAGER
 * post — one board per manager, one folder per district beneath him.
 *
 * ── WHY THESE EXIST ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner, 2026-09-09: *"the district managers receive medical reps and the national sales
 * managers receive district managers and medical reps. A district manager never receives district
 * manager."* Until that day a district-manager application landed in the folders of the district
 * managers whose post it was for — 135 of them in production, on up to three lines at once. Simply
 * dropping those CVs from the rep boards would have fixed the wrong half: they would then have
 * reached nobody at all, which is the failure that reads as "no one applied".
 *
 * ── ONE BOARD PER MANAGER, NOT ONE PER DISTRICT ─────────────────────────────────────────────────
 *
 * The rep boards are per district because a rep applies for an AREA, and an area belongs to exactly
 * one district per line. A district manager applies for a DISTRICT, so the district is the folder
 * and the manager above is the board. That also keeps the screen honest: the Anti Infective national
 * sales manager reads one heading with eight district folders under it, not eight more headings
 * competing with the district folders he already has.
 *
 * ── EVERY DISTRICT BENEATH HIM, NOT ONLY HIS DIRECT REPORTS ─────────────────────────────────────
 *
 * Pedia has a regional sales manager holding Alex-BHR, Delta (1) and Delta (2), and the national
 * sales manager sits above him. Both of them are entitled to an application for one of those three
 * districts — the standing rule is that scope runs downward, all the way down — so the walk is the
 * whole ancestor chain rather than the parent link. Reading it as direct reports only would hide
 * three of Pedia's seven districts from the one person accountable for the whole line.
 *
 * A CEO seat never gets a board. He is above every district in the company, so he would otherwise
 * receive every application there is, and nothing here is ever routed to him.
 */
export function managerApplicantBoards<T = DistrictFolderCandidate>(
  rows: readonly DistrictSeatRow[],
): DistrictManagerBoard<T>[] {
  const bySeatId = indexBySeatId(rows);
  // The districts, taken from the rep boards rather than re-derived: a district with no areas under
  // it is one nobody can be hired into, and it is excluded there for that reason. Asking the same
  // builder means the two screens can never disagree about which districts exist.
  const districts = districtManagerBoards<T>(rows);

  // Which manager seats hold which districts. One pass over the districts rather than one walk per
  // manager, so this stays linear on a tree of any depth.
  const districtsByManagerSeat = new Map<string, DistrictManagerBoard<T>[]>();
  for (const district of districts) {
    for (const ancestorId of ancestorSeatIds(district.seatId, bySeatId)) {
      const seat = bySeatId.get(ancestorId);
      if (!seat) continue;
      const tier = text(seat.seat_tier).toUpperCase();
      // Only the tiers that can receive a district manager's application, and never the CEO. A REP
      // or DM ancestor cannot happen in a well-formed tree and is skipped rather than trusted.
      if (tier !== "RSM" && tier !== "NSM") continue;
      // An empty manager seat gets no board: there is nobody to open it, and climbing further would
      // hand a whole line's succession to somebody the organogram did not put over it.
      if (!text(seat.occupant_hr_id) || seat.is_vacant === true) continue;
      const held = districtsByManagerSeat.get(ancestorId);
      if (held) held.push(district);
      else districtsByManagerSeat.set(ancestorId, [district]);
    }
  }

  const boards: DistrictManagerBoard<T>[] = [];
  for (const [managerSeatId, held] of districtsByManagerSeat) {
    const seat = bySeatId.get(managerSeatId);
    if (!seat) continue;

    // A folder is named for the district's REGION, which is how the company says it out loud —
    // "Cairo", "Delta (1)", "Upper Egypt 1" — read under the line's own heading. The seat label is
    // the fallback, and it also settles the (currently impossible) case of two districts under one
    // manager sharing a region name: a folder that silently absorbed the other district's applicants
    // would be worse than a long name.
    const used = new Set<string>();
    const folders: DistrictAreaFolder<T>[] = held
      .map((district) => {
        const preferred = district.regionName ?? district.seatLabel;
        const areaName = used.has(preferred) ? district.seatLabel : preferred;
        used.add(areaName);
        return {
          areaName,
          candidates: [] as T[],
          districtSeatId: district.seatId,
          fromCvText: [] as string[],
          fromGovernorate: [] as string[],
          kind: "district" as const,
        };
      })
      .sort((left, right) => left.areaName.localeCompare(right.areaName));

    boards.push({
      candidateCount: 0,
      coveringVacantSeat: null,
      folders,
      intake: "district_managers",
      lineName: text(seat.line_name) || null,
      managerHrId: text(seat.occupant_hr_id),
      regionName: text(seat.region_name) || null,
      seatId: managerSeatId,
      seatLabel: text(seat.seat_display_label) || managerSeatId,
      seatTier: text(seat.seat_tier).toUpperCase() || null,
    });
  }

  return boards.sort(
    (left, right) =>
      (left.lineName ?? "").localeCompare(right.lineName ?? "") ||
      left.seatLabel.localeCompare(right.seatLabel),
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
 * ── AND WHOSE JOB THEY ARE APPLYING FOR DECIDES WHICH BOARDS THEY LAND ON ───────────────────────
 *
 * The owner, 2026-09-09: *"the district managers receive medical reps and the national sales
 * managers receive district managers and medical reps. A district manager never receives district
 * manager."* Everything above resolves WHERE somebody wants to work and is unchanged by that;
 * `candidateManagerSeatTier` decides WHO gets to read them. An applicant for a district manager post
 * is filed into that district's folder on every manager board above it — same district, same
 * evidence, different reader — and never into the district's own area folders. Everyone else, which
 * is most of the pool and every CV with no readable title, routes exactly as before.
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
  const repBoards = districtManagerBoards<T>(input.rows);
  // The boards a national or regional sales manager reads district-manager applications on. They
  // carry NO "area" or "region" folders, which is why every index below can keep asking for those
  // kinds and stay rep-only without a second filter.
  const managerBoards = managerApplicantBoards<T>(input.rows);
  const boards = [...repBoards, ...managerBoards];
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

  // ── THE SAME TWO INDEXES AGAIN, FOR THE MANAGERS' BOARDS ─────────────────────────────────────
  //
  // A district-manager applicant is placed by exactly the same evidence as a rep — the area he named,
  // the address on his CV, his governorate, his region — and only the DESTINATION differs: the
  // district's folder on every manager board above it, rather than the area's folder on the district
  // itself. So the resolution below is untouched and only these lookups change hands, which is what
  // keeps the two intakes from drifting into two different rules about where somebody lives.
  //
  // Keyed off the DISTRICT boards rather than re-derived: a district folder names its seat, and each
  // district board already knows which areas and which region it holds.
  const managerFoldersByDistrictSeat = new Map<string, Target[]>();
  for (const board of managerBoards) {
    for (const folder of board.folders) {
      const seatId = text(folder.districtSeatId);
      if (!seatId) continue;
      const list = managerFoldersByDistrictSeat.get(seatId);
      if (list) list.push({ board, folder });
      else managerFoldersByDistrictSeat.set(seatId, [{ board, folder }]);
    }
  }

  const managerFoldersByArea = new Map<string, Target[]>();
  const managerFoldersByRegion = new Map<string, Target[]>();
  // The same district folder can be reached twice — two of a manager's districts holding one area
  // name, or two spelling the same region family — and a folder listed twice files the applicant
  // twice and counts him twice. Deduplicated on the Target object, which is created once per
  // (board, folder) above and shared by every key that reaches it.
  const addManagerTargets = (index: Map<string, Target[]>, key: string, targets: readonly Target[]): void => {
    const list = index.get(key);
    if (!list) {
      index.set(key, [...targets]);
      return;
    }
    for (const target of targets) if (!list.includes(target)) list.push(target);
  };

  for (const district of repBoards) {
    const targets = managerFoldersByDistrictSeat.get(district.seatId) ?? [];
    if (targets.length === 0) continue;

    for (const folder of district.folders) {
      if (folder.kind !== "area") continue;
      const key = areaFolderKey(folder.areaName);
      if (!key || ambiguousKeys.has(key)) continue;
      addManagerTargets(managerFoldersByArea, key, targets);
    }

    const regionKey = regionFamilyKey(district.regionName);
    if (regionKey) addManagerTargets(managerFoldersByRegion, regionKey, targets);
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

  /** True when at least one board on this tree sits high enough to receive this application. */
  const someoneCanReceive = (tier: CandidateManagerSeatTier): boolean =>
    managerBoards.some((board) => managerSeatCanReceive(board.seatTier, tier));

  for (const candidate of input.candidates) {
    if (!canFileCandidate(candidate)) continue;
    if (candidate.folder?.kind === "paramedical") continue;

    // ── WHOSE POST IS THIS PERSON APPLYING FOR ────────────────────────────────────────────────
    //
    // The owner, 2026-09-09: *"a district manager never receives district manager."* Null — nobody
    // is applying over a district manager's head — is the ordinary case and routes exactly as it
    // always did. A tier sends the CV up instead: the district's folder on every manager board
    // above it, which is the same district, resolved from the same evidence, read by the person who
    // would actually be hiring.
    const managerTier = candidateManagerSeatTier(candidate);
    if (managerTier && !someoneCanReceive(managerTier)) {
      // Nobody on this tree outranks the post they are applying for. A national sales manager's own
      // application is the whole of this case today: the only seat above him is the CEO, and nothing
      // here is ever routed to the CEO. He stays with Talent Acquisition, where he already is — and
      // he is NOT reported as unplaced, because that list is for people whose PLACE could not be
      // resolved, and his was never the problem.
      continue;
    }
    const areaTargetsFor = (key: string): readonly Target[] => {
      if (!managerTier) return foldersByKey.get(key) ?? [];
      return (managerFoldersByArea.get(key) ?? []).filter((target) =>
        managerSeatCanReceive(target.board.seatTier, managerTier),
      );
    };
    const regionTargetsFor = (regionName: string | null | undefined): readonly Target[] => {
      const key = regionFamilyKey(regionName);
      if (!key) return [];
      if (!managerTier) return catchAllsByRegion.get(key) ?? [];
      return (managerFoldersByRegion.get(key) ?? []).filter((target) =>
        managerSeatCanReceive(target.board.seatTier, managerTier),
      );
    };

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
      const targets = areaKey && !ambiguousKeys.has(areaKey) ? areaTargetsFor(areaKey) : undefined;
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

    // ── THE CATCH-ALLS FIRST, BECAUSE THE TWO TIERS BELOW UPGRADE THEM RATHER THAN REPLACE ────
    //
    // Reading an area out of a CV must never COST that CV a board. Both tiers below narrow to the
    // districts holding that particular area NAME, and area names are per line: Anti Infective
    // splits Upper Egypt into Qena 1 and Qena 2 where CNS covers the same ground from Sohag. Filing
    // a Qena CV into "Qena 1" and stopping there took it off the CNS manager's board altogether —
    // a manager who could see that CV yesterday could not see it today, which is strictly worse
    // than the catch-all it replaced, and invisible from the folder that gained it.
    //
    // So the region's catch-alls are resolved first and each tier below is an upgrade OVER them,
    // district by district: the manager who has a folder for that ground gets the CV in it, and
    // every other district in the region keeps it exactly where it already was.
    // The region they named comes first and wins whenever it names a real district; the legs
    // behind it run only when it names none, which is the difference between a manager and nobody.
    const regionOptions = districtRoutingRegionOptions(candidate);
    const routableRegion = regionOptions.find((name) => regionTargetsFor(name).length > 0);
    // No leg found a district: keep the FIRST, so the unplaced row still reports what they said.
    const regionName = routableRegion ?? regionOptions[0] ?? null;
    const catchAlls = regionName ? regionTargetsFor(regionName) : [];

    // The catch-alls the area folders did not already reach — keyed by SEAT, so a district is never
    // handed the same CV twice, once in an area folder and once in its own "No area named".
    const upgrading = (areaTargets: readonly Target[]): Target[] => {
      const reached = new Set(areaTargets.map((target) => target.board.seatId));
      return catchAlls.filter((target) => !reached.has(target.board.seatId));
    };

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
      const cvTargets = fromCv ? areaTargetsFor(areaFolderKey(fromCv.areaName)) : undefined;
      if (cvTargets && cvTargets.length > 0) {
        fileInto(cvTargets, candidate, "cv-text");
        fileInto(upgrading(cvTargets), candidate);
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
      const govTargets = governed ? areaTargetsFor(areaFolderKey(governed.areaName)) : undefined;
      if (govTargets && govTargets.length > 0) {
        fileInto(govTargets, candidate, "governorate");
        fileInto(upgrading(govTargets), candidate);
        continue;
      }
    }

    // ── The region, when their CV names no area either ─────────────────────────────────────────
    // "Qena" is not an area here — the organogram splits it into Qena 1 and Qena 2 — but it is
    // unmistakably Upper Egypt, and a district's catch-all is a better answer than nobody at all.
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

    if (catchAlls.length === 0) {
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
