import {
  calculateOrganogramStructureKpis,
  classifyOrganogramStructureLevel,
  organogramSeatCountKey,
} from "@/lib/reports/organogram-safety";
import {
  buildOrganogramLanes,
  type ManagerLane,
  type OrganogramRow,
  type TopManagerLane,
} from "@/lib/reports/organogram-view-model";

/**
 * EVERY NUMBER THE ORGANOGRAM PRINTS, FROM ONE PLACE (2026-10-26).
 *
 * The Pedia chart said "37 employees" in its header and "Total structure 32 / 47" under it, "6 lanes"
 * in the header and "4 lanes" over the National Sales Manager's tier, and a lane read "5 team
 * members · 5 vacant" — five seats, none of them filled. Each figure was counted by a different
 * component with a different rule, and none of them said what it counted. They are all counted here
 * now, and every label names its unit:
 *
 *  - SALES SEATS are the structure: one per seat (`organogramSeatCountKey`), filled when anyone sits
 *    on it. The same figures as the KPI cards, because they ARE the KPI cards' figures.
 *  - PEOPLE SHOWN are the distinct employees drawn, including the CEO and Head Office staff who hold
 *    no sales seat, and both people on a seat in handover. That is why it can exceed the filled seats.
 *  - DISTRICT LANES are the district managers' columns: those reporting straight to the National
 *    Sales Manager plus those under each Regional Manager. Other reporting groups are counted apart.
 */

export type OrganogramLaneSeatCount = {
  /** Team seats with someone on them. */
  filled: number;
  /** The lane's own manager seat is empty — its header already says "Vacant". */
  managerVacant: boolean;
  /** Team seats in the lane, the manager's own seat not included. */
  seats: number;
  /** Team seats with nobody on them. */
  vacant: number;
};

export type OrganogramChartCounts = {
  lanes: {
    /** District lanes reporting straight to the National Sales Manager. */
    direct: number;
    /** Every district lane on the chart: `direct` + `underRegional`. */
    district: number;
    /** Groups that are not a district manager's lane (marketing, an unplaced manager). */
    other: number;
    regionalManagers: number;
    /** District lanes under a Regional Manager. */
    underRegional: number;
  };
  people: {
    /** People on a sales seat (a person on two seats is one person). */
    onSalesSeats: number;
    /** People with no sales seat: the CEO, Head Office and marketing. */
    outsideSalesSeats: number;
    /** Every distinct person drawn. */
    shown: number;
  };
  seats: {
    filled: number;
    /** Seats drawn with two people on them — a leaver still on the seat until her last day, and her successor. */
    inHandover: number;
    open: number;
    total: number;
  };
};

/** One lane's team seats, each seat counted once and filled when anyone sits on it. */
export function countLaneSeats(lane: Pick<ManagerLane, "dsm" | "members">): OrganogramLaneSeatCount {
  const filledBySeat = new Map<string, boolean>();
  for (const member of lane.members) {
    const key = organogramSeatCountKey(member);
    filledBySeat.set(key, (filledBySeat.get(key) ?? false) || member.type !== "vacancy");
  }
  let filled = 0;
  filledBySeat.forEach((isFilled) => {
    if (isFilled) filled += 1;
  });
  return {
    filled,
    managerVacant: lane.dsm?.type === "vacancy",
    seats: filledBySeat.size,
    vacant: filledBySeat.size - filled,
  };
}

/** A Regional Manager's open seats: every child lane's empty team seats plus its empty manager seats. */
export function countRegionOpenSeats(childLanes: ManagerLane[]): number {
  return childLanes.reduce((total, lane) => {
    const count = countLaneSeats(lane);
    return total + count.vacant + (count.managerVacant ? 1 : 0);
  }, 0);
}

function personKey(row: OrganogramRow): string {
  return row.hrId.trim().toUpperCase();
}

export function buildOrganogramChartCounts(
  rows: OrganogramRow[],
  groups: TopManagerLane[] = buildOrganogramLanes(rows).groups,
): OrganogramChartCounts {
  const kpis = calculateOrganogramStructureKpis(rows);

  const people = new Set<string>();
  const onSeats = new Set<string>();
  const employeesBySeat = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.type !== "employee") continue;
    const person = personKey(row);
    people.add(person);
    if (!classifyOrganogramStructureLevel(row)) continue;
    onSeats.add(person);
    if (row.seatId) {
      const holders = employeesBySeat.get(row.seatId) ?? new Set<string>();
      holders.add(person);
      employeesBySeat.set(row.seatId, holders);
    }
  }
  let inHandover = 0;
  employeesBySeat.forEach((holders) => {
    if (holders.size > 1) inHandover += 1;
  });

  const direct = groups.filter((group) => group.dsm && !group.rsm).length;
  const regional = groups.filter((group) => group.rsm);
  const underRegional = regional.reduce((total, group) => total + (group.childLanes?.length ?? 0), 0);
  const other = groups.filter((group) => !group.dsm && !group.rsm).length;

  return {
    lanes: {
      direct,
      district: direct + underRegional,
      other,
      regionalManagers: regional.length,
      underRegional,
    },
    people: {
      onSalesSeats: onSeats.size,
      outsideSalesSeats: people.size - onSeats.size,
      shown: people.size,
    },
    seats: {
      filled: kpis.total.actual,
      inHandover,
      open: kpis.total.vacant,
      total: kpis.total.total,
    },
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 lane", "3 district lanes" — the one spelling of a lane count. */
export function formatDistrictLaneCount(count: number): string {
  return plural(count, "district lane", "district lanes");
}

/** "3 of 5 seats filled" — the one spelling of a lane's team. */
export function formatLaneSeatSummary(count: OrganogramLaneSeatCount): string {
  return `${count.filled} of ${plural(count.seats, "seat", "seats")} filled`;
}

/**
 * The sentence under the chart that reconciles the figures, so a reader who sees people shown above
 * the filled seats is told why instead of left to guess.
 */
export function describeOrganogramCounts(counts: OrganogramChartCounts): string {
  const parts = [
    `${counts.seats.filled} of ${plural(counts.seats.total, "sales seat", "sales seats")} filled, ${counts.seats.open} open.`,
  ];
  const peopleParts: string[] = [];
  if (counts.people.outsideSalesSeats > 0) {
    peopleParts.push(`${plural(counts.people.outsideSalesSeats, "person holds", "people hold")} no sales seat (CEO, Head Office, marketing)`);
  }
  if (counts.seats.inHandover > 0) {
    peopleParts.push(
      `${plural(counts.seats.inHandover, "seat is", "seats are")} in handover and ${counts.seats.inHandover === 1 ? "shows" : "show"} both the leaver and the successor`,
    );
  }
  parts.push(
    `${plural(counts.people.shown, "person", "people")} shown${peopleParts.length > 0 ? `: ${peopleParts.join("; ")}` : ""}.`,
  );
  return parts.join(" ");
}
