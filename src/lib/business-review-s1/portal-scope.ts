// S1 Business Review — employee-portal scope resolution.
//
// Answers one question: for this signed-in viewer, WHICH part of the S1 review may they see?
// Everything here is read-only and resolves against data/access-map.json, which is generated
// from the live seat map by ingest/build_access_map_from_db.mjs.
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
// WHAT CHANGED WHEN THE REVIEW MOVED ONTO CANONICAL SoS
//
// Territory used to be resolved in two hops — seat map → workbook DM label → the workbook's
// own area list — because the committed workbook was the only thing that knew which areas a
// district carried during Jan–Jun. That hop needed a 1:1 seat↔label relation in both
// directions and fell back to a "confirmed subset" when it could not get one (Pedia's
// Giza/Cairo pair), and it once understated CNS DM Saad Salama's territory by two areas.
//
// The canonical engine attributes every sales row to a DM SEAT directly, using seat
// occupancy as of each period end. So the second hop is gone: the access map resolves the
// viewer's seat, and the canonical dataset already says which areas that seat carried. No
// label matching, no reconciliation, no partial subsets.
//
// Two different timeframes still meet here and are deliberately not merged: the S1 numbers
// are Jan–Jun history, while access is decided by who sits where today.

import accessMapRaw from "./data/access-map.json";
import type { S1Line } from "./canonical";
import type { AreaSummary, DmSummary, S1Dataset } from "./types";

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
      kind: "seats";
      line: S1Line;
      /** Exact DM seats this viewer may see. Already the post-scope set. */
      dmSeatIds: string[];
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

  // ---- seat-level scopes (DSM = own seat, RM = the DM seats under their RSM node) ----
  const line = viewer.line;
  if (!line) return { kind: "none", reason: "No line is recorded against your seat." };
  if (!accessMap.lines[line]) return { kind: "none", reason: "Your line has no S1 dataset." };

  const seatIds =
    viewer.scope === "ownDm"
      ? (viewer.dmSeatId ? [viewer.dmSeatId] : [])
      : (viewer.dmSeatIds ?? []);
  if (!seatIds.length) {
    return { kind: "none", reason: "No DM seat is attached to your account in the live org tree, so no territory can be resolved." };
  }

  const label =
    viewer.scope === "ownDm"
      ? `${viewer.role} · own district`
      : `${viewer.role} · ${seatIds.length} districts`;
  return { kind: "seats", line, dmSeatIds: seatIds, viewerName: viewer.name, label };
}

/**
 * Areas + DM rows filtered to a seat-level scope.
 *
 * Filtering happens here, before any ranking or truncation (PR #1487). The seat id is the
 * canonical engine's own attribution key, so this is an exact match rather than a name
 * reconciliation — an area either was attributed to that seat during S1 or it was not.
 */
export function applySeatScope(ds: S1Dataset, dmSeatIds: readonly string[]): { areas: AreaSummary[]; dms: DmSummary[] } {
  const keep = new Set(dmSeatIds);
  return {
    areas: ds.areas.filter((a) => a.dmSeatId && keep.has(a.dmSeatId)),
    dms: ds.dms.filter((d) => d.dmSeatId && keep.has(d.dmSeatId)),
  };
}

export function s1AccessMapGeneratedAt(): string {
  return accessMap.generatedAt;
}
