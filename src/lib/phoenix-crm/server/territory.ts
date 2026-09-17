/**
 * Phoenix CRM — how a territory reads on screen: its name, its rep and its reviewing manager, by name.
 */

import { nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { territoryName, territoryReviewer, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";

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

const SEAT_TIER_TITLES: Record<string, string> = {
  REP: "Medical Rep",
  DM: "District Manager",
  ACTING_DM: "Acting District Manager",
  RSM: "Regional Manager",
  NSM: "National Sales Manager",
};

/** A seat's title on screen, from the organogram tier (never the tier code). */
export function seatTierTitle(tier: string): string {
  return SEAT_TIER_TITLES[tier] ?? "Manager";
}
