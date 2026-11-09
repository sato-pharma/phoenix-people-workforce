/**
 * How the Reps List boards arrange their rep cards — pure, so the order and the arithmetic are pinned by a test.
 *
 * A regional manager over three regions read his team as one alphabetical wall of thirteen cards (owner, 2026-11-09:
 * "premium polish … every single component", then "group reps by district manager"). The boards now group the cards
 * under their region and district manager, and each group says how many reps it holds and how its week stands.
 */

import type { RepsListContact } from "@/lib/crm/reps-list";
import { UNVISITED_STATUSES } from "@/lib/crm/reps-list-activity";
import { regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";

/** A group's heading: "Delta (2) · Sahar El Gallad", or the region alone when the manager is not known. */
export function teamHeading(team: TeamOfRep): string {
  return team.managerName ? regionManagerTitle(team.regionName, team.managerName) : team.regionName;
}

/** What a card needs to be grouped: its team, as the cascade resolved it (`RepsListRep.team`). */
export type TeamOfRep = { key: string; managerName: string | null; order: number; regionName: string };

export type RepRegionGroup<T> = {
  key: string;
  /** The heading — region and district manager (`teamHeading`). */
  label: string;
  reps: T[];
};

/**
 * The cards grouped by region and district manager, in the order `groupByRegionAndManager` gave each team — the order
 * every Regional Sales Manager screen reads in (owner, 2026-11-09: "group reps by district manager"). Nothing here
 * filters: every rep handed in comes back out exactly once, so the group sizes add up to the tile above. Inside a group
 * the incoming order is kept, so each board decides its own card order once.
 */
export function groupRepsByTeam<T extends { team: TeamOfRep }>(reps: readonly T[]): RepRegionGroup<T>[] {
  const groups = new Map<string, { order: number; group: RepRegionGroup<T> }>();
  for (const rep of reps) {
    const entry = groups.get(rep.team.key);
    if (entry) entry.group.reps.push(rep);
    else groups.set(rep.team.key, { group: { key: rep.team.key, label: teamHeading(rep.team), reps: [rep] }, order: rep.team.order });
  }
  return [...groups.values()]
    .sort((left, right) => left.order - right.order || left.group.label.localeCompare(right.group.label))
    .map((entry) => entry.group);
}

export type ShareSegment = {
  key: string;
  label: string;
  value: number;
};

export type ShareSlice = ShareSegment & {
  /** This segment's share of the total, 0–100, rounded to a whole percent for the legend. */
  percent: number;
  /** The bar width, 0–100, unrounded so the segments always fill the bar exactly. */
  width: number;
};

/**
 * A row of counts as the slices of one flat bar. Zero segments are kept (the legend still names them, with 0) but take
 * no width. A total of zero gives every slice zero width, and the bar draws empty rather than dividing by zero.
 */
export function shareSlices(segments: readonly ShareSegment[]): { slices: ShareSlice[]; total: number } {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  return {
    slices: segments.map((segment) => {
      const value = Math.max(0, segment.value);
      const width = total > 0 ? (value / total) * 100 : 0;
      return { ...segment, percent: Math.round(width), value, width };
    }),
    total,
  };
}

/**
 * A count against the largest in view, 0–100, for the thin meter under a card's figure. The largest card reads full;
 * a list of zeros reads empty, never NaN.
 */
export function meterPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, Math.round((value / max) * 100));
}

/**
 * The initials on a rep's square monogram: the first letter of the first two words, in capitals. An Arabic or a
 * one-word name gives what it has; an empty name gives a dash rather than an empty square.
 */
export function repInitials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toLocaleUpperCase("en");
  return initials || "–";
}

/**
 * How a brick's rows went in the month being scored, for the bar under its heading: visited (any visit, on or off the
 * plan), not visited (`UNVISITED_STATUSES`, the same set the Not visited tile counts) and not due yet — a doctor
 * planned for a later day is neither, so he is kept out of both. A row the month could not score is left out.
 */
export function brickCoverage(rows: readonly Pick<RepsListContact, "activity">[]): {
  notDue: number;
  scored: number;
  unvisited: number;
  visited: number;
} {
  let notDue = 0;
  let unvisited = 0;
  let visited = 0;
  for (const row of rows) {
    const status = row.activity?.status;
    if (!status) continue;
    if (status === "not_due") notDue += 1;
    else if (UNVISITED_STATUSES.has(status)) unvisited += 1;
    else visited += 1;
  }
  return { notDue, scored: notDue + unvisited + visited, unvisited, visited };
}
