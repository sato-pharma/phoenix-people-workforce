// Which operating areas a chosen business line may hire into.
//
// `public.areas` carries `line_id` NULL on 49 of its 60 live rows, because ONE area id is held by
// every line's field force there -- "Beni Suef" (UE9) is Anti Infective's, CNS's and Pedia's area
// at the same time, and the per-line rows that used to exist beside it (`bani_suef` on Anti
// Infective, `fayoum` on Pedia) were deactivated when the au geography took over. Only 11 legacy
// line-tagged rows are still active, and they are region-shaped seats (Anti Infective's "Upper
// Egypt 1", Pedia's "Egypt"), not the areas a rep sits in.
//
// So the Employee Master "Operating Area" picker must treat a line-agnostic area as belonging to
// EVERY line, and hide only a row that names a DIFFERENT line. Filtering on `line_id === lineId`
// alone emptied the list down to those 11 rows the moment a line was picked, which is why a Pedia
// hire into Beni Suef (Upper Egypt 1) had no area to choose at all (owner, 2026-09-30). The
// column guide in `employee-master-columns.ts` has said all along that Area is "NOT filtered by
// Line -- CNS, Anti-Infective and Pedia reps commonly share an area name"; this is that rule.
//
// The region the new record carries is still derived from the (line, area) pair by
// `region-resolver.ts` against the au crosswalk, so admitting a line-agnostic area here cannot
// put anyone in the wrong region: Pedia + UE9 resolves to Upper Egypt 1, CNS + UE9 to Others.

export type AreaLineOption = {
  lineId?: number | string | null;
};

function normalizeId(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * True when `area` may be chosen while `selectedLineId` is the picked business line. No line
 * picked yet admits every area; an area with no line of its own is held by every line.
 */
export function areaBelongsToLine(
  area: AreaLineOption,
  selectedLineId: number | string | null | undefined,
): boolean {
  const selected = normalizeId(selectedLineId);
  if (!selected) return true;

  const areaLine = normalizeId(area.lineId);
  if (!areaLine) return true;

  return areaLine === selected;
}

/** The operating-area options a chosen business line may hire into, in the given order. */
export function filterAreaOptionsForLine<T extends AreaLineOption>(
  areas: readonly T[],
  selectedLineId: number | string | null | undefined,
): T[] {
  return areas.filter((area) => areaBelongsToLine(area, selectedLineId));
}
