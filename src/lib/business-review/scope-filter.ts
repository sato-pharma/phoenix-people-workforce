// Business Review — "export what I am looking at", inside what I am allowed to see.
//
// Owner, 2026-09-26, after being shown that the pack was district-only and that HIS OWN account
// could not reach it: "I want everyone to be able to export as he is filtered or as his scope. For
// example, if a district manager wants to export for only one area, he can filter on the area and
// export, or export for his total region. He can do this. Super Admin, for example, wants to export
// CNS line only, or Pedia line only for the region of Dr. Hany Saad only. All of this must be
// applicable."
//
// So the pack stops having FIXED levels and follows the viewer's own filter — company, line,
// region, district or a single area — with the level resolved from what he actually narrowed to.
//
// ── 🔴 WHY A FILTER CANNOT WIDEN A SCOPE HERE, STRUCTURALLY ─────────────────────────────────────
//
// The dangerous version of this feature reads `?line=cns&dm=SEAT-...` and treats it as the scope.
// Then a medical rep edits a URL and exports his whole company.
//
// This module cannot do that, and not because it remembers to check. `territoriesInScope()` builds
// the list of territories from the SESSION's scope alone — the request is not a parameter of it —
// and `resolveReviewFilter()` only ever REMOVES entries from that list. There is no code path in
// which a filter adds a territory, so the widest a filter can resolve to is the scope itself. A
// value that names something outside the list is DROPPED, not obeyed and not refused: the parameter
// arrives in links people send each other, so a district manager opening a company-wide link should
// get his own district, and an error page teaches him nothing.
//
// Dropping silently would be its own defect, though — a pack that says "All company" while holding
// one district is a lie told in a meeting. So every drop is recorded in `dropped`, and the LABEL is
// always built from what was actually applied, never from what was asked for.

import type { ReviewLine } from "./canonical";
import type { PackLevel } from "./pack/metrics";
import type { ReviewPortalScope } from "./portal-scope";
import type { AreaSummary } from "./types";

const LINE_LABEL: Record<ReviewLine, string> = {
  anti: "Anti-Infective",
  cns: "CNS",
  pedia: "Pedia",
};

const LINE_BY_VALUE: Record<string, ReviewLine> = {
  anti: "anti",
  cns: "cns",
  pedia: "pedia",
};

/** The catalogue order the review itself uses, so two people get the same document. */
const LINE_ORDER: readonly ReviewLine[] = ["cns", "pedia", "anti"];

/**
 * One area, flattened with the things a viewer may filter on.
 *
 * Deliberately not `AreaSummary`: this module decides who may see what, and it should not be able
 * to read a sales figure while doing it.
 */
export type FilterableTerritory = {
  line: ReviewLine;
  areaCode: string | null;
  area: string;
  dmSeatId: string | null;
  dm: string;
  region: string;
};

/** What the filter UI may offer — never more than this viewer's own scope. */
export type ReviewFilterChoices = {
  lines: { value: ReviewLine; label: string }[];
  regions: string[];
  districts: { seatId: string; name: string; region: string; line: ReviewLine }[];
  areas: { code: string; name: string; dm: string; line: ReviewLine }[];
};

export type ReviewFilterRequest = {
  line?: string | null;
  /** One region or several — the owner exports "multiple regions and multiple areas" (2026-09-27). */
  region?: string | string[] | null;
  dm?: string | null;
  /** One area code or several. */
  area?: string | string[] | null;
};

export type AppliedReviewFilter = {
  line: ReviewLine | null;
  /** The regions actually applied (each was in scope). Empty when none narrowed. */
  regions: string[];
  dmSeatId: string | null;
  /** The area codes actually applied (each was in scope). Empty when none narrowed. */
  areaCodes: string[];
};

export type ResolvedReviewFilter = {
  /** Which metric catalogue applies. */
  level: PackLevel;
  /** The subject's own name, built from what was APPLIED. Never from what was asked for. */
  label: string;
  /** The territories that survived. The pack is built from exactly these. */
  territories: FilterableTerritory[];
  /** Lines still in play, in catalogue order. */
  lines: ReviewLine[];
  /** Distinct district seats still in play. */
  dmSeatIds: string[];
  applied: AppliedReviewFilter;
  /** Anything asked for and not honoured, in words a person can read. */
  dropped: string[];
};

/**
 * Every territory this SESSION may see. The request is not an input — that is the point.
 *
 * `byLine` holds the already-loaded per-line areas. A line the caller did not load simply is not
 * offered, which is how a company viewer who only loaded one line still gets a truthful answer.
 */
export function territoriesInScope(
  scope: ReviewPortalScope,
  byLine: Partial<Record<ReviewLine, readonly AreaSummary[]>>,
): FilterableTerritory[] {
  if (scope.kind === "none") return [];

  const flatten = (line: ReviewLine, areas: readonly AreaSummary[]): FilterableTerritory[] =>
    areas.map((area) => ({
      area: area.area,
      areaCode: area.areaCode,
      dm: area.dm,
      dmSeatId: area.dmSeatId,
      line,
      region: area.region,
    }));

  if (scope.kind === "company") {
    return LINE_ORDER.flatMap((line) => flatten(line, byLine[line] ?? []));
  }

  const areas = byLine[scope.line] ?? [];

  if (scope.kind === "line") return flatten(scope.line, areas);

  if (scope.kind === "seats") {
    const keep = new Set(scope.dmSeatIds);
    return flatten(scope.line, areas).filter((t) => t.dmSeatId != null && keep.has(t.dmSeatId));
  }

  // A rep: the areas he himself stands in. The caller has already narrowed `byLine[scope.line]`
  // with `applyRepScope`, because only the attribution map knows which areas are his.
  return flatten(scope.line, areas);
}

/** The choices a filter UI may show, derived from the scoped list and nothing else. */
export function filterChoices(territories: readonly FilterableTerritory[]): ReviewFilterChoices {
  const lines = LINE_ORDER.filter((line) => territories.some((t) => t.line === line)).map((line) => ({
    label: LINE_LABEL[line],
    value: line,
  }));

  const regions = [...new Set(territories.map((t) => t.region).filter((r) => r.trim() !== ""))].sort();

  const districtBySeat = new Map<string, { seatId: string; name: string; region: string; line: ReviewLine }>();
  for (const t of territories) {
    if (t.dmSeatId && !districtBySeat.has(t.dmSeatId)) {
      districtBySeat.set(t.dmSeatId, { line: t.line, name: t.dm, region: t.region, seatId: t.dmSeatId });
    }
  }

  // An area CODE repeats across lines — "Alex Center" exists on CNS and on Pedia — so the list is
  // keyed by line and code together, and the label carries the line. Collapsing them would offer
  // one entry that silently means two territories.
  const areaByKey = new Map<string, { code: string; name: string; dm: string; line: ReviewLine }>();
  for (const t of territories) {
    if (!t.areaCode) continue;
    const key = `${t.line}:${t.areaCode}`;
    if (!areaByKey.has(key)) areaByKey.set(key, { code: t.areaCode, dm: t.dm, line: t.line, name: t.area });
  }

  return {
    areas: [...areaByKey.values()].sort((a, b) => a.name.localeCompare(b.name)),
    districts: [...districtBySeat.values()].sort((a, b) => a.name.localeCompare(b.name)),
    lines,
    regions,
  };
}

/** A request value — one string, several, or none — as a clean list of trimmed non-empty values. */
function asList(value: string | string[] | null | undefined): string[] {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Narrow the scoped territories by what the viewer asked for.
 *
 * Applied outside-in — line, then region, then district, then area — so each step narrows what the
 * one before it left. A value that matches nothing in the surviving list is dropped and named.
 */
export function resolveReviewFilter(
  scope: ReviewPortalScope,
  scoped: readonly FilterableTerritory[],
  request: ReviewFilterRequest,
): ResolvedReviewFilter {
  const dropped: string[] = [];
  let territories = [...scoped];
  const applied: AppliedReviewFilter = { areaCodes: [], dmSeatId: null, line: null, regions: [] };

  // ── line ──
  const wantedLine = request.line ? LINE_BY_VALUE[request.line.trim().toLowerCase()] : undefined;
  if (request.line && !wantedLine) {
    dropped.push(`"${request.line}" is not one of the three lines this review covers.`);
  } else if (wantedLine) {
    const kept = territories.filter((t) => t.line === wantedLine);
    if (kept.length === 0) {
      dropped.push(`The ${LINE_LABEL[wantedLine]} line is not in your scope, so it was not applied.`);
    } else {
      territories = kept;
      applied.line = wantedLine;
    }
  }

  // ── region(s) ── one or several. Each narrows to the union of the regions actually in scope; an
  // out-of-scope region is dropped and named, never obeyed — the whole module can only ever remove.
  const wantedRegions = asList(request.region);
  if (wantedRegions.length > 0) {
    const inScope = new Set(territories.map((t) => t.region));
    const keep = wantedRegions.filter((r) => inScope.has(r));
    for (const r of wantedRegions) {
      if (!keep.includes(r)) dropped.push(`The ${r} region is not in your scope, so it was not applied.`);
    }
    if (keep.length > 0) {
      const set = new Set(keep);
      territories = territories.filter((t) => set.has(t.region));
      applied.regions = keep;
    }
  }

  // ── district ──
  if (request.dm?.trim()) {
    const wanted = request.dm.trim();
    const kept = territories.filter((t) => t.dmSeatId === wanted);
    if (kept.length === 0) {
      dropped.push("That district is not in your scope, so it was not applied.");
    } else {
      territories = kept;
      applied.dmSeatId = wanted;
    }
  }

  // ── area(s) ── one or several, matched case-insensitively. A code repeats across lines, so a
  // value keeps every territory that carries it (both lines' "AX1") unless a line was also chosen.
  const wantedAreas = asList(request.area).map((a) => a.toUpperCase());
  if (wantedAreas.length > 0) {
    const inScope = new Map(
      territories.filter((t) => t.areaCode).map((t) => [(t.areaCode as string).toUpperCase(), t.areaCode as string]),
    );
    const keepUpper = wantedAreas.filter((a) => inScope.has(a));
    for (const a of wantedAreas) {
      if (!keepUpper.includes(a)) dropped.push("That area is not in your scope, so it was not applied.");
    }
    if (keepUpper.length > 0) {
      const set = new Set(keepUpper);
      territories = territories.filter((t) => t.areaCode != null && set.has(t.areaCode.toUpperCase()));
      applied.areaCodes = [...new Set(keepUpper.map((a) => inScope.get(a) as string))];
    }
  }

  const lines = LINE_ORDER.filter((line) => territories.some((t) => t.line === line));
  const dmSeatIds = [...new Set(territories.map((t) => t.dmSeatId).filter((id): id is string => id != null))];

  return {
    applied,
    dmSeatIds,
    dropped,
    label: filterLabel(scope, territories, applied, lines),
    level: filterLevel(scope, applied),
    lines,
    territories,
  };
}

/**
 * Which metric catalogue applies.
 *
 * A rep is always "rep" — nothing he can tick widens him. Anything narrower than a line resolves to
 * "district", because a region, a district and a single area all answer the same questions: which
 * areas, which reps, which bricks, which customers.
 */
function filterLevel(scope: ReviewPortalScope, applied: AppliedReviewFilter): PackLevel {
  if (scope.kind === "rep") return "rep";
  if (applied.areaCodes.length > 0 || applied.dmSeatId || applied.regions.length > 0) return "district";
  if (scope.kind === "seats") return "district";
  if (applied.line || scope.kind === "line") return "line";
  return "company";
}

/** The subject's name, from what was APPLIED — so a pack never claims a scope it does not hold. */
function filterLabel(
  scope: ReviewPortalScope,
  territories: readonly FilterableTerritory[],
  applied: AppliedReviewFilter,
  lines: readonly ReviewLine[],
): string {
  if (territories.length === 0) return "Nothing in scope";

  const lineBit =
    applied.line != null
      ? LINE_LABEL[applied.line]
      : lines.length === 1
        ? LINE_LABEL[lines[0]]
        : "All lines";

  if (applied.areaCodes.length === 1) {
    const area = territories.find((t) => t.areaCode === applied.areaCodes[0]);
    return `${lineBit} · ${area?.area ?? applied.areaCodes[0]}`;
  }
  if (applied.areaCodes.length > 1) return `${lineBit} · ${applied.areaCodes.length} areas`;
  if (applied.dmSeatId) {
    const district = territories.find((t) => t.dmSeatId === applied.dmSeatId);
    return `${lineBit} · ${district?.dm ?? "District"}`;
  }
  if (applied.regions.length === 1) return `${lineBit} · ${applied.regions[0]} region`;
  if (applied.regions.length > 1) return `${lineBit} · ${applied.regions.length} regions`;
  if (applied.line || scope.kind === "line") return `${lineBit} line`;
  if (scope.kind === "seats") return scope.label;
  if (scope.kind === "rep") return scope.label;
  return "All company";
}

/** The line's human name. Names, never codes — the owner's standing rule, in files as on screen. */
export function lineLabelOf(line: ReviewLine): string {
  return LINE_LABEL[line];
}

/** Every line the review covers, in catalogue order. */
export const REVIEW_LINE_ORDER: readonly ReviewLine[] = LINE_ORDER;

/**
 * The filter as URL params, for a link that reproduces this view. Empty values are left out. A single
 * region or area stays a plain string (so existing one-value links are byte-identical); several become
 * an array, which the hidden-input plumbing renders as repeated params the route reads with `getAll`.
 */
export function filterParams(applied: AppliedReviewFilter): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  if (applied.line) params.line = applied.line;
  if (applied.dmSeatId) params.dm = applied.dmSeatId;
  if (applied.regions.length === 1) params.region = applied.regions[0];
  else if (applied.regions.length > 1) params.region = applied.regions;
  if (applied.areaCodes.length === 1) params.area = applied.areaCodes[0];
  else if (applied.areaCodes.length > 1) params.area = applied.areaCodes;
  return params;
}
