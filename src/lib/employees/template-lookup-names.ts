/**
 * Named ranges for the employee hiring template's Area -> Team cascade.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 *
 * The template writes one hidden named range per area ("here are that area's teams") and gives the
 * Team cell a data-validation formula that resolves to the right one from whatever Area the user
 * picked. That means TWO pieces of code have to agree on a name: the Node builder that creates it,
 * and the Excel formula that asks for it at the moment of the click.
 *
 * They used to derive the name INDEPENDENTLY, each doing its own string surgery on the area label:
 *
 *   builder  label.toUpperCase().replace(/[-\s]+/g,"_").replace(/[^A-Z0-9_]/g,"")   -> TEAMS_DELTA_3
 *   Excel    "TEAMS_"&SUBSTITUTE(SUBSTITUTE(UPPER(cell),"-","_")," ","_")           -> TEAMS_DELTA_(3)
 *
 * Those disagree for any label carrying a character the builder strips but Excel's SUBSTITUTE chain
 * keeps, and for any run of separators the builder collapses to one underscore and Excel does not.
 * Measured against the 58 live area names on 2026-08-28, ELEVEN disagreed -- including "Delta (1)",
 * "Delta (2)", "Delta (3)", "Gharbia 1 (Tanta)" and "Port said - Domiat". The Team dropdown on every
 * one of them resolved to a name that was never created, i.e. #REF!, i.e. a dead dropdown.
 *
 * It cannot be fixed by teaching Excel the same surgery. Parentheses are not legal in a defined
 * name, collapsing a run needs an unbounded loop, and an area named in Arabic would strip to nothing
 * at all -- there is no SUBSTITUTE chain that covers the general case.
 *
 * So the label stops being the key. The builder numbers the ranges by the area's POSITION in
 * AREAS_LIST, and Excel finds that same position with MATCH. Neither side does any string surgery,
 * so neither side can disagree with the other; the name is always a legal defined name, whatever the
 * area is called.
 *
 * The second half of the same defect: the builder only registered a name when the team list was
 * non-empty, so the 23 active areas with no team yet also resolved to #REF!. Every area now gets a
 * range, empty or not -- an empty dropdown is a correct answer, a broken one is not.
 */

/** Prefix shared by every per-area team range. */
const RANGE_PREFIX = "TEAMS";

/** The list of areas the Team cascade keys off. Kept here so both halves cite one constant. */
export const AREAS_LIST_NAME = "AREAS_LIST";

/**
 * Defined name for the team range at 1-based position `index` in AREAS_LIST.
 *
 * `TEAMS_0` is the fallback for "the Area cell is blank or holds something not in the list", which
 * is what IFERROR collapses MATCH's #N/A to. It always exists and is always empty.
 */
export function areaTeamRangeName(index: number): string {
  return `${RANGE_PREFIX}_${index}`;
}

/** The always-present empty range an unmatched Area falls back to. */
export const AREA_TEAM_FALLBACK_RANGE = areaTeamRangeName(0);

export type AreaTeamRange = {
  /** Defined-name token, e.g. "TEAMS_7". */
  name: string;
  /** Column header on the hidden sheet — human-readable, so the file stays debuggable by hand. */
  header: string;
  /** The area this range serves; null for the fallback range. */
  areaLabel: string | null;
  /** Team labels for that area, in the order supplied. Empty is legal and still gets a range. */
  teamLabels: string[];
};

/**
 * Excel's MATCH(...,0) is case-insensitive, so the builder must collapse case the same way or two
 * labels differing only in case would be given separate ranges while Excel resolved both to the
 * first. Trimmed too, since a label with trailing space is the same pick to a user.
 */
function matchKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * One range per distinct area label, at the position Excel's MATCH will report, plus the fallback.
 *
 * Areas are numbered by their position in the FULL areas array (1-based), because that array is what
 * gets written to AREAS_LIST verbatim. A label repeated later in the array collapses onto its first
 * position — the same one MATCH returns — and its teams merge into that single range.
 */
export function buildAreaTeamRanges(input: {
  areas: Array<{ label: string; value: string }>;
  teams: Array<{ label: string; areaId: number | null }>;
}): AreaTeamRange[] {
  const { areas, teams } = input;

  // Area id -> the 1-based AREAS_LIST position its label resolves to.
  const positionByMatchKey = new Map<string, number>();
  areas.forEach((area, arrayIndex) => {
    const key = matchKey(area.label);
    if (!positionByMatchKey.has(key)) positionByMatchKey.set(key, arrayIndex + 1);
  });

  const positionByAreaId = new Map<number, number>();
  for (const area of areas) {
    const id = Number(area.value);
    if (!Number.isFinite(id)) continue;
    const position = positionByMatchKey.get(matchKey(area.label));
    if (position != null && !positionByAreaId.has(id)) positionByAreaId.set(id, position);
  }

  const teamsByPosition = new Map<number, string[]>();
  for (const team of teams) {
    if (team.areaId == null) continue;
    const position = positionByAreaId.get(Number(team.areaId));
    if (position == null) continue;
    const bucket = teamsByPosition.get(position);
    if (bucket) bucket.push(team.label);
    else teamsByPosition.set(position, [team.label]);
  }

  const ranges: AreaTeamRange[] = [
    { areaLabel: null, header: "Teams (no area picked)", name: AREA_TEAM_FALLBACK_RANGE, teamLabels: [] },
  ];

  const emitted = new Set<number>();
  areas.forEach((area, arrayIndex) => {
    const position = positionByMatchKey.get(matchKey(area.label)) ?? arrayIndex + 1;
    if (emitted.has(position)) return;
    emitted.add(position);
    ranges.push({
      areaLabel: area.label,
      header: `Teams (${area.label})`,
      name: areaTeamRangeName(position),
      teamLabels: teamsByPosition.get(position) ?? [],
    });
  });

  return ranges;
}

/**
 * The live data-validation formula for a Team cell whose Area sits at `areaCellRef`.
 *
 * MATCH finds the picked area's position in AREAS_LIST; IFERROR turns "nothing picked yet" into the
 * always-empty fallback rather than letting #N/A poison INDIRECT. No string surgery on either side.
 */
export function areaTeamValidationFormula(areaCellRef: string): string {
  return `=INDIRECT("${RANGE_PREFIX}_"&IFERROR(MATCH(${areaCellRef},${AREAS_LIST_NAME},0),0))`;
}

/**
 * The range name Excel will actually resolve for `areaLabel`, derived the way Excel derives it.
 *
 * This is deliberately a SEPARATE implementation from `buildAreaTeamRanges` — it simulates MATCH
 * against the areas list rather than reading the builder's output. That independence is the whole
 * point: it lets a test assert the two halves agree without asking one of them what it thinks.
 */
export function areaTeamRangeNameResolvedByExcel(
  areaLabel: string,
  areas: Array<{ label: string }>,
): string {
  const target = matchKey(areaLabel);
  const position = areas.findIndex((area) => matchKey(area.label) === target) + 1;
  return areaTeamRangeName(position); // findIndex -1 => position 0 => the fallback, as IFERROR gives
}
