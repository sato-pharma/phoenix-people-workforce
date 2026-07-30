// S1 Business Review — employee-portal scope resolution.
//
// Answers one question: for this signed-in viewer, WHICH areas of the S1 review may they
// see? Everything here is read-only and resolves against data/access-map.json, which is
// generated from the live seat map by ingest/build_access_map_from_db.mjs.
//
// Design constraints, each of them learned from a real defect in this repo:
//
//  - Scope comes from the SEAT MAP, never a region label. PR #1479: six live areas sit in
//    an operational region different from their geographic one, and region-label scoping
//    hid 1,194 of one DM's own sales rows.
//  - A Regional Manager gets the DM seats under their RSM node — the full set, not one
//    level. PR #1486: resolving a HIERARCHY scope with a one-level manager check made an
//    RM see their DSMs but none of the reps beneath them, so a semester rolled up to
//    "0.0%" and EGP 0 payout while the region was actually near 105% — wrong and silent.
//  - Scope is applied BEFORE any truncation or ranking. PR #1487: truncating company-wide
//    first and filtering after silently emptied a scoped viewer's list.
//  - Every failure path returns NO access, never a wider one. A stale access map can only
//    ever grant less than reality.
//  - The baked role is cross-checked against the live session role. The map is a snapshot;
//    the session is the truth. On disagreement we deny, because the safe direction when
//    two sources conflict about a permission is "no".
//
// Two sources, two different jobs — this is the part that is easy to get wrong:
//
//  - The ORG TREE answers *identity*: which DM seat is this signed-in HR_ID sitting in? Only
//    the seat map can answer that, and nothing else may.
//  - The S1 WORKBOOK answers *attribution*: which areas did that district actually carry during
//    Jan–Jun? It is the authority here, because S1 is history and the workbook is what the
//    business signed off on.
//
// Resolving areas from the seat map alone understated real territory: for CNS DM Saad Salama the
// workbook attributes 6 areas, but only 4 of them had been mapped to his seat, so his own review
// showed 4 areas and a total short by two areas' sales. So the seat map resolves the seat, and
// then the workbook's own DM column decides the area list. Where the two cannot be reconciled
// 1:1 the resolution falls back to the confirmed subset and says so, rather than guessing.

import accessMapRaw from "./data/access-map.json";
import { getS1Dataset, type S1Line } from "./service";
import type { AreaSummary, DmSummary } from "./types";

type AreaEntry = {
  seatId: string;
  areaCode: string | null;
  repHrId: string | null;
  repName: string | null;
  seatVacantToday: boolean | null;
  dmSeatId: string | null;
  dmHrId: string | null;
  s1Dm: string;
  s1Region: string;
};
type ViewerEntry = {
  hrId: string;
  name: string;
  role: string;
  scope: "company" | "line" | "ownDm" | "dmSeats";
  line: S1Line | null;
  dmSeatId: string | null;
  rsmSeatId: string | null;
  dmSeatIds?: string[];
  note?: string;
};
type AccessMap = {
  generatedAt: string;
  sourceRef: string;
  lines: Record<string, {
    label: string;
    lineCode: string;
    dmSeats: { seatId: string; regionCode: string | null; hrId: string | null; name: string | null; isVacant: boolean }[];
    rsmSeats: { seatId: string; hrId: string | null; name: string | null; dmSeatIds: string[] }[];
    areas: Record<string, AreaEntry>;
    unmappedAreas: string[];
  }>;
  viewers: Record<string, ViewerEntry>;
};

const accessMap = accessMapRaw as unknown as AccessMap;

/** Same normalisation the rest of Phoenix uses for HR_ID comparison — never compare raw. */
function hrKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

export type S1PortalScope =
  | { kind: "company"; viewerName: string; label: string }
  | { kind: "line"; line: S1Line; viewerName: string; label: string }
  | {
      kind: "areas";
      line: S1Line;
      /** Exact S1 area names this viewer may see. Already the post-scope set. */
      areaNames: string[];
      dmSeatIds: string[];
      /** Seats whose S1 attribution could not be reconciled 1:1 with a single workbook DM, so
       *  their area list is the confirmed subset and may be short. Empty for every seat today
       *  except Pedia's Giza/Cairo pair. Drives the one warning the viewer sees; when it is
       *  empty the territory is exactly what the workbook says the district carried, so there is
       *  nothing to warn about. */
      partialSeats: string[];
      viewerName: string;
      label: string;
    }
  | { kind: "none"; reason: string };

/**
 * Resolve what this viewer may see. `sessionRole` must be the role from the live
 * AccessContext, not from any client input.
 */
export function resolveS1PortalScope(input: { hrId: string | null; sessionRole: string }): S1PortalScope {
  const key = hrKey(input.hrId);
  if (!key) return { kind: "none", reason: "No HR ID on the session." };

  const viewer = accessMap.viewers[key];
  if (!viewer) {
    return {
      kind: "none",
      reason: "Your HR ID is not in the S1 Business Review access map. Medical Representatives have no access to this module by design.",
    };
  }
  // Snapshot vs live session. Deny on disagreement rather than trusting either blindly.
  if (viewer.role !== input.sessionRole) {
    return {
      kind: "none",
      reason: `Your Phoenix role ("${input.sessionRole}") no longer matches the access map ("${viewer.role}"). Access is withheld until the map is regenerated.`,
    };
  }

  if (viewer.scope === "company") {
    return { kind: "company", viewerName: viewer.name, label: `${viewer.role} · all three lines` };
  }

  if (viewer.scope === "line") {
    if (!viewer.line) return { kind: "none", reason: "No line is recorded against your employee record, so a whole-line scope cannot be granted." };
    return { kind: "line", line: viewer.line, viewerName: viewer.name, label: `${viewer.role} · ${accessMap.lines[viewer.line]?.label ?? viewer.line} line` };
  }

  // ---- area-level scopes (DSM = own seat, RM = the DM seats under their RSM node) ----
  const line = viewer.line;
  if (!line) return { kind: "none", reason: "No line is recorded against your seat." };
  const lineMap = accessMap.lines[line];
  if (!lineMap) return { kind: "none", reason: "Your line has no S1 dataset." };

  const seatIds =
    viewer.scope === "ownDm"
      ? (viewer.dmSeatId ? [viewer.dmSeatId] : [])
      : (viewer.dmSeatIds ?? []);
  if (!seatIds.length) {
    return { kind: "none", reason: "No DM seat is attached to your account in the live org tree, so no territory can be resolved." };
  }

  const { areaNames, partialSeats } = resolveSeatAreas(line, seatIds);

  if (!areaNames.length) {
    return {
      kind: "none",
      reason:
        `No S1 area could be linked to your DM seat${seatIds.length > 1 ? "s" : ""} (${seatIds.join(", ")}). ` +
        `${lineMap.unmappedAreas.length} area(s) on your line are still awaiting a confirmed mapping, so this may be a mapping gap rather than an empty territory.`,
    };
  }

  const seatLabel =
    viewer.scope === "ownDm"
      ? `${viewer.role} · own district`
      : `${viewer.role} · ${seatIds.length} districts`;
  return { kind: "areas", line, areaNames, dmSeatIds: seatIds, partialSeats, viewerName: viewer.name, label: seatLabel };
}

/**
 * The S1 areas belonging to a set of DM seats.
 *
 * The seat map tells us which workbook DM label sits on each seat; the workbook then decides the
 * area list, because it is the authority on who carried what during S1. Resolving from the seat
 * map's own area rows alone left real territory out — see the header note on Saad Salama.
 *
 * Fail-closed condition: the seat↔workbook-DM relation must be 1:1 in BOTH directions. If a seat
 * carries two DM labels, or one DM label spans two seats, we cannot tell whose areas are whose,
 * so that seat keeps only its confirmed rows and is reported back as partial. Today that is
 * exactly Pedia's Giza/Cairo pair, where the workbook attributes areas to both "Taha Mohamed"
 * and a "Cairo (vacant)" placeholder across the two seats. Guessing there would hand one manager
 * the other's district.
 */
function resolveSeatAreas(line: S1Line, seatIds: readonly string[]): { areaNames: string[]; partialSeats: string[] } {
  const lineMap = accessMap.lines[line];
  const wanted = new Set(seatIds);

  // Whole-line relation, not just this viewer's seats: a DM label shared with a seat outside the
  // viewer's scope is just as ambiguous as one shared inside it.
  const dmsBySeat = new Map<string, Set<string>>();
  const seatsByDm = new Map<string, Set<string>>();
  const confirmedBySeat = new Map<string, string[]>();
  for (const [areaName, entry] of Object.entries(lineMap.areas)) {
    const seat = entry.dmSeatId;
    if (!seat) continue;
    if (!dmsBySeat.has(seat)) dmsBySeat.set(seat, new Set());
    dmsBySeat.get(seat)!.add(entry.s1Dm);
    if (!seatsByDm.has(entry.s1Dm)) seatsByDm.set(entry.s1Dm, new Set());
    seatsByDm.get(entry.s1Dm)!.add(seat);
    if (!confirmedBySeat.has(seat)) confirmedBySeat.set(seat, []);
    confirmedBySeat.get(seat)!.push(areaName);
  }

  const areas = getS1Dataset(line).areas;
  const names = new Set<string>();
  const partialSeats: string[] = [];
  for (const seat of wanted) {
    const dms = dmsBySeat.get(seat);
    if (!dms?.size) continue;
    const oneToOne = dms.size === 1 && seatsByDm.get([...dms][0])?.size === 1;
    if (oneToOne) {
      const dm = [...dms][0];
      for (const area of areas) if (area.dm === dm) names.add(area.area);
    } else {
      partialSeats.push(seat);
      for (const areaName of confirmedBySeat.get(seat) ?? []) names.add(areaName);
    }
  }
  return { areaNames: [...names].sort((a, b) => a.localeCompare(b)), partialSeats: partialSeats.sort() };
}

/** Areas + DM rows filtered to an area-level scope. Filtering happens here, before any
 *  ranking or truncation downstream, per PR #1487. */
export function applyAreaScope(line: S1Line, areaNames: readonly string[]): { areas: AreaSummary[]; dms: DmSummary[] } {
  const ds = getS1Dataset(line);
  const keep = new Set(areaNames);
  const areas = ds.areas.filter((a) => keep.has(a.area));
  const dmNames = new Set(areas.map((a) => a.dm));
  const dms = ds.dms.filter((d) => dmNames.has(d.dm));
  return { areas, dms };
}

export function s1AccessMapGeneratedAt(): string {
  return accessMap.generatedAt;
}
