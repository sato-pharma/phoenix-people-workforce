// `public.areas.line_id` cannot narrow the Employee Master "Operating Area" picker, and this module
// is the one place that says so.
//
// Measured on production 2026-09-30, over all 60 live areas and every active employee:
//
//   * **49 of the 60 live areas carry `line_id` NULL.** One area id is held by every line's field
//     force there -- "Beni Suef" (UE9) is Anti Infective's, CNS's and Pedia's area at once. The
//     per-line rows that used to sit beside them were deactivated when the au geography took over.
//   * **The remaining 11 are shared across lines too, in live data.** They are DISTRICT and OFFICE
//     seats ("Alex-BHR", "Delta (1)", "Giza", "Upper Egypt 1", Pedia's "Egypt", "Head office"), and
//     `areas.line_id` on them names whichever line happened to create the row: **16 active managers
//     sit on one whose `line_id` names a DIFFERENT line** -- PD-0014 (Pedia) on Anti Infective's
//     "Upper Egypt 1", B-118 (CNS) on Anti Infective's "Upper Egypt", B-116 (CNS) and AI-0001 (Anti
//     Infective) on Pedia's "Cairo", OF-0002 (Head Office) on Pedia's "Egypt", and eleven more.
//
// So there is no subset of areas the column can correctly hide. Filtering on it emptied the picker
// down to those 11 rows the moment a line was chosen, which is why a Pedia hire into Beni Suef had
// no area to pick at all (owner, 2026-09-30, #4977); admitting only the line-agnostic 49 fixed that
// case and still hid "Upper Egypt 1" from the very line whose district manager sits on it. The
// column guide in `employee-master-columns.ts` has stated the rule all along -- Area is **"NOT
// filtered by Line -- CNS, Anti-Infective and Pedia reps commonly share an area name"** -- and this
// is that rule, with nothing left in front of it.
//
// Nothing is lost by showing them all. The region a new record carries is derived from the (line,
// area) pair by `region-resolver.ts` against the au crosswalk, never from `areas.line_id`; all 11
// line-tagged rows resolve to NO region code there, exactly as the 38 people already on them carry
// none. A vacancy-backed hire does not come through this picker at all -- it uses the open-vacancy
// list, which is scoped by the vacancy's own `line_id`.

export type AreaLineOption = {
  lineId?: number | string | null;
};

function normalizeId(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * The operating-area options to offer, whatever business line is chosen: all of them, in the given
 * order. Deliberately not narrowed — see the module header for the measurement behind that.
 */
export function operatingAreaOptions<T extends AreaLineOption>(areas: readonly T[]): T[] {
  return [...areas];
}

/**
 * The business line to hold after an area is picked.
 *
 * An area's own `line_id` may only FILL a line that has not been chosen — it must never overwrite
 * one that has. Selecting "Upper Egypt 1" for a Pedia district manager would otherwise silently
 * flip the form to Anti Infective, because that row is tagged to the line that created it, and the
 * hire would be filed on the wrong line with nothing on screen saying so.
 */
export function lineIdAfterAreaPick(
  area: AreaLineOption | undefined,
  currentLineId: number | string | null | undefined,
): string {
  const current = normalizeId(currentLineId);
  if (current) return current;

  return normalizeId(area?.lineId);
}
