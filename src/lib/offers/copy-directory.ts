import { HR_SEAT_JOB_TITLES } from "@/lib/auth/hr-functions";
import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * Who an offer can be copied to, picked from lists rather than typed (owner, 2026-11-10: "in the cc
 * email field and bcc make them a droplist cascading as per area line region"). He chose what the lists
 * hold — "Managers + HR team" — and that typing an address by hand stays.
 *
 * Line → Region → Area comes from the organogram's own map (`au_v_line_area_map`, its open rows that
 * have started on Cairo's calendar), and an area's people are the seats above it: its District Manager
 * (the map's `dm_seat_id`), then the Regional Manager and the National Sales Manager found by climbing
 * `parent_seat_id` in `au_v_org_tree`. A vacant seat is listed as vacant, so an empty list is never read
 * as "nobody manages this area". The HR team is every active holder of an HR team seat — the same roles
 * HR Reminders shares with — named by the company's job title.
 *
 * The database read is `copy-directory-loader.ts`; this file is pure, so the browser and the tests can
 * import it. Display only: picking somebody writes their WORK email into the CC or BCC box, where the existing
 * checks (`planOfferCopies`) still apply. Nothing is decided from these lists.
 */

export type OfferCopyPerson = {
  /** Work email; null when the record has none, so the person is shown but cannot be added. */
  email: string | null;
  /** Display name; null for a vacant seat. */
  name: string | null;
  /** "District Manager", "Regional Manager", "National Sales Manager", or an HR seat's job title. */
  role: string;
  vacant: boolean;
};

export type OfferCopyArea = { code: string; name: string; people: OfferCopyPerson[] };
export type OfferCopyRegion = { areas: OfferCopyArea[]; code: string; name: string };
export type OfferCopyLine = { code: string; name: string; regions: OfferCopyRegion[] };

export type OfferCopyDirectory = { hrTeam: OfferCopyPerson[]; lines: OfferCopyLine[] };

export const EMPTY_OFFER_COPY_DIRECTORY: OfferCopyDirectory = { hrTeam: [], lines: [] };

export type OfferCopyMapRow = {
  areaCode: string | null;
  areaName: string | null;
  dmSeatId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  lineCode: string | null;
  regionCode: string | null;
};

/** One row per OCCUPANT — a seat being handed over has two, a vacant seat one with no occupant. */
export type OfferCopySeatRow = {
  isOtherPseudoDm: boolean;
  occupantHrId: string | null;
  parentSeatId: string | null;
  seatId: string;
  seatTier: string | null;
};

export type OfferCopyPersonRecord = { active: boolean; email: string | null; name: string };

const SEAT_ROLE: Record<string, string> = {
  ACTING_DM: "District Manager",
  DM: "District Manager",
  NSM: "National Sales Manager",
  RSM: "Regional Manager",
};

/** The HR Manager is the Super Admin seat; the other HR seats show their company job titles. */
function hrRoleTitle(role: string): string {
  if (role === "Super Admin") return "HR Manager";
  return (HR_SEAT_JOB_TITLES as Record<string, string>)[role] ?? role;
}

type SeatNode = { isOtherPseudoDm: boolean; occupants: string[]; parentSeatId: string | null; tier: string };

function seatIndex(rows: readonly OfferCopySeatRow[]): Map<string, SeatNode> {
  const seats = new Map<string, SeatNode>();
  for (const row of rows) {
    const node = seats.get(row.seatId) ?? {
      isOtherPseudoDm: row.isOtherPseudoDm,
      occupants: [],
      parentSeatId: row.parentSeatId,
      tier: String(row.seatTier ?? ""),
    };
    const hrId = row.occupantHrId?.trim();
    if (hrId && !node.occupants.includes(hrId)) node.occupants.push(hrId);
    seats.set(row.seatId, node);
  }
  return seats;
}

/** Everybody (or the vacancy) on one seat, as the lists show them. A leaver counts as a vacancy. */
function seatPeople(
  seat: SeatNode,
  role: string,
  people: ReadonlyMap<string, OfferCopyPersonRecord>,
): OfferCopyPerson[] {
  const holders = seat.occupants
    .map((hrId) => people.get(canonicalHrIdKey(hrId) ?? ""))
    .filter((person): person is OfferCopyPersonRecord => Boolean(person?.active))
    .map((person) => ({ email: person.email, name: person.name, role, vacant: false }));
  return holders.length > 0 ? holders : [{ email: null, name: null, role, vacant: true }];
}

/** The District Manager, then every manager above up to the National Sales Manager, nearest first. */
function areaPeople(
  dmSeatId: string | null,
  seats: ReadonlyMap<string, SeatNode>,
  people: ReadonlyMap<string, OfferCopyPersonRecord>,
): OfferCopyPerson[] {
  const out: OfferCopyPerson[] = [];
  let seatId = dmSeatId;
  // A depth cap, so a cycle in the seat tree can never hang a page.
  for (let depth = 0; seatId && depth < 6; depth += 1) {
    const seat = seats.get(seatId);
    if (!seat || seat.tier === "CEO") break;
    const role = SEAT_ROLE[seat.tier];
    // An "Others" bucket is a pseudo district, not a person's seat: skip it and keep climbing.
    if (role && !seat.isOtherPseudoDm) out.push(...seatPeople(seat, role, people));
    if (seat.tier === "NSM") break;
    seatId = seat.parentSeatId;
  }
  return out;
}

/** The pure half: no database. Lines, regions and areas in name order; people nearest the area first. */
export function buildOfferCopyDirectory(input: {
  hrTeam: ReadonlyArray<{ hrId: string; role: string }>;
  lineNames: ReadonlyMap<string, string>;
  mapRows: readonly OfferCopyMapRow[];
  people: ReadonlyMap<string, OfferCopyPersonRecord>;
  regionNames: ReadonlyMap<string, string>;
  seats: readonly OfferCopySeatRow[];
  today: string;
}): OfferCopyDirectory {
  const seats = seatIndex(input.seats);
  const lines = new Map<string, OfferCopyLine>();
  for (const row of input.mapRows) {
    const lineCode = row.lineCode?.trim();
    const regionCode = row.regionCode?.trim();
    const areaCode = row.areaCode?.trim();
    if (!lineCode || !regionCode || !areaCode) continue;
    // Only what is in force today: a row opening next month is not yet anybody's area.
    if (row.effectiveFrom && row.effectiveFrom.slice(0, 10) > input.today) continue;
    if (row.effectiveTo && row.effectiveTo.slice(0, 10) < input.today) continue;

    const line = lines.get(lineCode) ?? { code: lineCode, name: input.lineNames.get(lineCode) ?? lineCode, regions: [] };
    lines.set(lineCode, line);
    let region = line.regions.find((entry) => entry.code === regionCode);
    if (!region) {
      region = { areas: [], code: regionCode, name: input.regionNames.get(regionCode) ?? regionCode };
      line.regions.push(region);
    }
    if (region.areas.some((entry) => entry.code === areaCode)) continue;
    region.areas.push({
      code: areaCode,
      name: row.areaName?.trim() || areaCode,
      people: areaPeople(row.dmSeatId?.trim() || null, seats, input.people),
    });
  }

  const byName = <T extends { name: string }>(left: T, right: T) => left.name.localeCompare(right.name);
  const sortedLines = [...lines.values()].sort(byName).map((line) => ({
    ...line,
    regions: [...line.regions].sort(byName).map((region) => ({ ...region, areas: [...region.areas].sort(byName) })),
  }));

  const hrTeam: OfferCopyPerson[] = [];
  const seen = new Set<string>();
  for (const member of input.hrTeam) {
    const key = canonicalHrIdKey(member.hrId);
    const person = key ? input.people.get(key) : undefined;
    if (!key || seen.has(key) || !person?.active) continue;
    seen.add(key);
    hrTeam.push({ email: person.email, name: person.name, role: hrRoleTitle(member.role), vacant: false });
  }
  // The HR Manager first, then the rest by name.
  hrTeam.sort((left, right) => Number(right.role === "HR Manager") - Number(left.role === "HR Manager") || String(left.name).localeCompare(String(right.name)));

  return { hrTeam, lines: sortedLines };
}
