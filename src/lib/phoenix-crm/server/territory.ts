/**
 * Phoenix CRM — how a territory reads on screen: its name, its rep and its reviewing manager, by name.
 */

import { highestSeatTitle, orgSeatTitle } from "@/lib/org/seat-titles";
import { nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { personKey, territoryName, territoryReviewer, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";

export type TerritorySummary = {
  seatId: string;
  name: string;
  lineCode: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  /** Null for a vacant territory. */
  repHrId: string | null;
  repName: string | null;
  reviewerHrId: string | null;
  reviewerName: string | null;
};

/** The HR ids a territory summary names, for one batched name read. */
export function territoryPeople(org: OrgIndex, seats: Iterable<OrgSeat>): string[] {
  const ids: string[] = [];
  for (const seat of seats) {
    if (seat.occupantHrId) ids.push(seat.occupantHrId);
    const reviewer = territoryReviewer(org, seat.seatId);
    if (reviewer) ids.push(reviewer.hrId);
  }
  return ids;
}

export function describeTerritory(org: OrgIndex, seat: OrgSeat, names: PeopleNames): TerritorySummary {
  const reviewer = territoryReviewer(org, seat.seatId);
  return {
    seatId: seat.seatId,
    name: territoryName(seat),
    lineCode: seat.lineCode,
    lineName: seat.lineName,
    areaName: seat.areaName,
    regionName: seat.regionName,
    repHrId: seat.occupantHrId,
    repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
    reviewerHrId: reviewer?.hrId ?? null,
    reviewerName: reviewer ? nameOf(names, reviewer.hrId) : null,
  };
}

/**
 * A seat's title on screen, from the organogram tier (never the tier code).
 *
 * 🔴 IT IS THE ORGANOGRAM'S OWN WORDING SINCE 2026-10-01, at the owner's instruction (*"put actual
 * titles from the organogram"*): "Medical Representative", "District Sales Manager", "Regional Sales
 * Manager", "National Sales Manager". It used to carry a shorter set of its own ("Medical Rep",
 * "District Manager", "Acting District Manager", "Regional Manager"), which meant the same person
 * read one way on the organogram and another on his own visit card. Do not shorten them back.
 *
 * The fallback stays "Manager" rather than the raw tier: a tier the view grows later would otherwise
 * print `ACTING_DM` on a card, which is the names-never-codes rule broken in the one place it shows.
 */
export function seatTierTitle(tier: string): string {
  return orgSeatTitle(tier) ?? "Manager";
}

/**
 * The organogram title of the person on this HR id, or null when the organogram has no seat for them.
 *
 * NULL, never a guess: the tree is SALES-only, so a Super Admin or a head-office person who appears
 * on a visit genuinely has no seat, and the screen says what it already said about them instead.
 * A person on two seats (an acting district manager holds his ACTING_DM seat AND the REP seat under
 * it) reads at the HIGHER one, which is the single node the organogram draws him as.
 */
export function personSeatTitle(org: OrgIndex, hrId: string | null | undefined): string | null {
  const key = personKey(hrId);
  if (!key) return null;
  return highestSeatTitle((org.seatsByOccupant.get(key) ?? []).map((seat) => seat.tier));
}
