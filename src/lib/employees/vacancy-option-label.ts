/**
 * Label for one open vacancy in the Employee Master "Operating Area" picker.
 *
 * A vacancy carries the area the LEAVER personally sat in, which for a manager
 * seat is one arbitrary area out of the district the seat actually runs. The
 * Pedia district manager post covering Alex East / Alex Center / Alex West /
 * Behira 1 / Behira 2 / Kafr El-Sheikh 1 opened as "Behira 1", so the owner --
 * who knows that seat as Alex-BHR-KFS -- read the list as not containing it at
 * all and could not hire the replacement (2026-09-09). The region is already on
 * the vacancy row; it was simply never printed.
 *
 * Pure and dependency-free so the shape is unit-testable without a Supabase
 * client (AGENTS.md: domain-first -- the component renders, it does not decide).
 */

export type VacancyOptionLabelInput = {
  areaName?: string | null;
  managerName?: string | null;
  positionTitle?: string | null;
  regionName?: string | null;
};

export type VacancyOptionLabelOptions = {
  /**
   * Drop the position from the row. The picker only offers vacancies for the
   * position already chosen two fields above it, so repeating that on every row
   * buys nothing and costs the width that pushed the panel into a sideways
   * scroll -- 708px of row inside a 491px panel, measured 2026-09-09.
   *
   * It is NOT unconditionally redundant, which is why this is a flag and not a
   * deletion: with a Title typed and no Job Position picked, the picker's own
   * filter matches EVERY open vacancy on the line, so the list then holds a mix
   * of positions and the position is the half that tells the rows apart. The
   * caller decides, by looking at what it is about to render.
   */
  omitPositionTitle?: boolean;
};

function clean(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

/**
 * `Behira 1 (Alex-BHR) - District Sales Manager - Manager: Hany Saad Mohamed Omar`,
 * or `Behira 1 (Alex-BHR) - Manager: Hany Saad Mohamed Omar` under
 * `omitPositionTitle`.
 *
 * The region is appended only when it says something the area does not: a
 * single-area district ("Cairo" inside region "Cairo") would otherwise print
 * its own name twice. Every segment is dropped when its value is missing, so a
 * vacancy with no manager yet reads `Behira 1 (Alex-BHR) - District Sales
 * Manager` rather than trailing an empty "Manager:".
 */
export function formatVacancyOptionLabel(
  vacancy: VacancyOptionLabelInput,
  options: VacancyOptionLabelOptions = {},
): string {
  const areaName = clean(vacancy.areaName);
  const regionName = clean(vacancy.regionName);
  const positionTitle = options.omitPositionTitle ? "" : clean(vacancy.positionTitle);
  const managerName = clean(vacancy.managerName);

  const sameAsArea = regionName.toLowerCase() === areaName.toLowerCase();
  const place = areaName
    ? regionName && !sameAsArea
      ? `${areaName} (${regionName})`
      : areaName
    : regionName;

  const segments = [place, positionTitle, managerName ? `Manager: ${managerName}` : ""];

  return segments.filter(Boolean).join(" - ");
}
