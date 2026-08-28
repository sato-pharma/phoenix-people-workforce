// Recruitment / ATS — who receives a CV when the seat's own manager post is empty.
//
// A vacancy names the manager it reports to, and picking that vacancy pre-selects that person. One
// open seat in production names nobody: "Down town · Pedia" reports to the Cairo Pedia District
// Manager, and that post is itself vacant, so `position_vacancies.manager_hr_id` is null and the row
// reads "Vacant Cairo District Manager". Until now that left the send button disabled — the CV could
// be screened but not sent, on the one kind of seat where the hire is most overdue.
//
// The owner's instruction, 2026-08-28: "route him to the district manager's manager." So this climbs
// the organogram from the vacant post up through `parent_seat_id` until it reaches a seat somebody
// actually sits in. For Down town that is the Pedia National Sales Manager.
//
// IT CLIMBS THE TREE, IT DOES NOT ASSUME THE NSM. The five vacant manager seats in production do not
// all report to the same tier — measured 2026-08-28, PEDIA Alex-BHR reports to the Regional Sales
// Manager while PEDIA Cairo reports to the National Sales Manager — so a hard-coded "go to the NSM"
// would put an Alexandria CV in front of the wrong person. The parent link is the answer.
//
// NOTHING IS WRITTEN. This resolves at read time from `au_v_org_tree`, the public wrapper over the
// same authoritative tree the organogram reads. Stamping a stand-in into
// `position_vacancies.manager_hr_id` would be a production write that the next vacancy import
// silently reverts — and one that goes stale the moment the district manager is hired, which is the
// entire point of the seat being open.
//
// Pure selector plus an async loader elsewhere, the split `area-rep-resolver.ts` uses for the same
// reason: the rule that decides who receives a candidate's CV is worth testing without a database.

import { normalizeLineKey } from "@/lib/employees/area-rep-resolver";

/** One `au_v_org_tree` row, narrowed to what the climb reads. */
export type ManagerSeatRow = {
  seat_id?: string | null;
  parent_seat_id?: string | null;
  seat_tier?: string | null;
  line_name?: string | null;
  region_name?: string | null;
  is_vacant?: boolean | null;
  occupant_hr_id?: string | null;
  seat_display_label?: string | null;
};

export const MANAGER_SEAT_COLUMNS =
  "seat_id,parent_seat_id,seat_tier,line_name,region_name,is_vacant,occupant_hr_id,seat_display_label";

/**
 * The tiers that manage a medical rep.
 *
 * Read only when a vacancy carries no `seat_id` of its own, which is the case that needed solving:
 * vacancy 245's area, "Down town", has no PEDIA rep seat at all — the five Cairo PEDIA rep seats are
 * Cairo East 1, Cairo East 2, Cairo West, Heliopolis and Nasr City — so there is no seat to take a
 * parent from and the manager has to be found by territory instead.
 *
 * ACTING_DM belongs here beside DM. A rep acting as a district manager is a real seat in this tree —
 * ANTI_INFECTIVE Upper Egypt 1 is one — and leaving it out would make that region's CVs unroutable.
 */
const REP_MANAGER_TIERS = new Set(["DM", "ACTING_DM"]);

export type ManagerStandIn = {
  /** Whoever sits in the nearest occupied seat at or above the vacancy's manager post. */
  hrId: string;
  /**
   * The vacant post this person is covering, as the organogram labels it — or null when the manager
   * seat turned out to be occupied after all and nothing was climbed past. Null means "this IS the
   * manager", not "we do not know"; a caller shows the covering note only when it is set.
   */
  coveredSeatLabel: string | null;
};

/**
 * One key for a line or a region name.
 *
 * `normalizeLineKey` rather than a local lower-casing, and that is not tidiness: `au.lines` seeds the
 * Anti Infective line as 'Anti infective' while the application spells it "Anti Infective", so a
 * case-sensitive comparison silently drops a whole line's seats. A region needs the same collapse —
 * "Delta (1)" must survive its punctuation and spacing — so one function serves both rather than the
 * trap being re-learned in a second copy.
 */
function seatKey(value: string | null | undefined): string {
  return normalizeLineKey(value);
}

function indexBySeatId(rows: readonly ManagerSeatRow[]): Map<string, ManagerSeatRow> {
  const index = new Map<string, ManagerSeatRow>();
  for (const row of rows) {
    const seatId = String(row.seat_id ?? "").trim();
    if (seatId) index.set(seatId, row);
  }
  return index;
}

/**
 * Walk up from a manager seat until somebody is sitting in one.
 *
 * Returns null rather than a guess when the chain runs out, when a parent is named that the tree does
 * not contain, or when the links form a cycle. A cycle cannot occur in a tree that is built
 * correctly, which is exactly why it is worth refusing on: an org tree that has one is broken, and
 * the answer this would otherwise invent would be indistinguishable from a real one.
 */
function climbToOccupiedSeat(
  managerSeatId: string,
  bySeatId: Map<string, ManagerSeatRow>,
): ManagerStandIn | null {
  const visited = new Set<string>();
  let covered: { label: string | null } | null = null;
  let seatId: string | null = managerSeatId;

  while (seatId) {
    if (visited.has(seatId)) return null;
    visited.add(seatId);

    const seat = bySeatId.get(seatId);
    if (!seat) return null;

    // Occupancy is read from the occupant, with `is_vacant` as a veto. Either one alone has a failure
    // mode: a seat flagged vacant that still carries a stale occupant would route a CV to somebody
    // who has left, and a seat marked occupied with a blank id gives nobody to send to.
    const occupant = String(seat.occupant_hr_id ?? "").trim();
    if (occupant && seat.is_vacant !== true) {
      return { coveredSeatLabel: covered?.label ?? null, hrId: occupant };
    }

    // The first vacant seat is the post the recruiter believes they are sending to, so it is the one
    // worth naming. Recorded once, deliberately: after two empty levels the note must still read
    // "standing in for the district manager", not for whatever sits between.
    if (!covered) covered = { label: String(seat.seat_display_label ?? "").trim() || null };

    seatId = String(seat.parent_seat_id ?? "").trim() || null;
  }

  return null;
}

/** What a vacancy has to offer about where its manager sits. */
export type VacancySeatContext = {
  seatId?: string | null;
  lineName?: string | null;
  regionName?: string | null;
};

/**
 * The seat or seats that manage this vacancy, as ids to start climbing from.
 *
 * A vacancy that names its own seat hands over that seat's parent, which is the exact answer. One
 * that does not — because its area is not in the organogram at all — falls back to the district
 * manager for its line and region: the same answer, arrived at from the territory instead of from
 * the tree.
 *
 * A `seat_id` the tree does not contain is treated as absent rather than as a dead end. A seat can be
 * retired by a restructure while the vacancy row still names it, and refusing there would disable the
 * send for a reason that has nothing to do with the vacancy.
 */
function managerSeatIdsFor(
  vacancy: VacancySeatContext,
  rows: readonly ManagerSeatRow[],
  bySeatId: Map<string, ManagerSeatRow>,
): string[] {
  const ownSeatId = String(vacancy.seatId ?? "").trim();
  const ownSeat = ownSeatId ? bySeatId.get(ownSeatId) : undefined;
  if (ownSeat) {
    const parentSeatId = String(ownSeat.parent_seat_id ?? "").trim();
    return parentSeatId ? [parentSeatId] : [];
  }

  const line = seatKey(vacancy.lineName);
  const region = seatKey(vacancy.regionName);
  if (!line || !region) return [];

  return rows
    .filter((row) => REP_MANAGER_TIERS.has(String(row.seat_tier ?? "").trim().toUpperCase()))
    .filter((row) => seatKey(row.line_name) === line && seatKey(row.region_name) === region)
    .map((row) => String(row.seat_id ?? "").trim())
    .filter((seatId) => seatId.length > 0);
}

/**
 * Who should receive a CV for this vacancy, when the vacancy itself names nobody.
 *
 * Call only for a vacancy whose own `manager_hr_id` is empty. A vacancy that names a manager already
 * has its answer, and overriding it from the tree would quietly move CVs away from the person the
 * organogram deliberately put on the row.
 *
 * REFUSES WHEN TWO ROUTES DISAGREE. If a line and region resolve to more than one manager seat and
 * those seats climb to different people, this returns null and the send stays disabled — exactly
 * where a recruiter is today. Picking one of two managers by sort order is how a CV lands in front of
 * somebody who is not hiring; a disabled button asks a question, and a wrong answer does not.
 */
export function resolveVacancyManager(
  vacancy: VacancySeatContext,
  rows: readonly ManagerSeatRow[],
): ManagerStandIn | null {
  const bySeatId = indexBySeatId(rows);
  const startIds = managerSeatIdsFor(vacancy, rows, bySeatId);
  if (startIds.length === 0) return null;

  const climbs = startIds
    .map((seatId) => climbToOccupiedSeat(seatId, bySeatId))
    .filter((result): result is ManagerStandIn => result !== null);
  if (climbs.length === 0) return null;

  const [first] = climbs;
  if (climbs.some((result) => result.hrId !== first.hrId)) return null;
  return first;
}
