// Org structure — a sales manager is recorded against his REGION, never against one of his
// own rep areas.
//
// WHY THIS EXISTS. `employees.area_id` means two different things depending on who holds it. For a
// medical rep it is his territory: one rep, one area, and `au.line_area_map` hangs his seat off it.
// For a district manager it is not a territory at all — he owns a whole region, and the area on his
// row is only the key the seating engine matches on
// (`phx_autofill_replacement_vacancy_for_employee` matches an open vacancy on area + line +
// position + manager, and never on region). Nothing in the schema says which of the two meanings a
// given row carries, so a manager sitting on a rep area looks exactly like a rep sitting on his own
// area, and every screen that groups people by area then shows the district manager occupying a
// rep's patch — which reads as "that area is covered" when the rep seat under it is vacant.
//
// MEASURED ON PRODUCTION 2026-09-11: six of eighteen occupied district-manager seats carried a rep
// area. Three Delta (1) managers on Menoufia 1, the Pedia Alex-BHR manager on Behira 1, the Pedia
// Upper Egypt 1 manager on Minia 1, and the Anti Infective Upper Egypt 2 manager on the old
// undivided Upper Egypt. The open Upper Egypt 2 vacancy carried Sohag 1, which the next hire would
// have inherited.
//
// TWO CAUSES, AND THE SECOND IS WHY IT SPREADS.
//
//   1. A REGION WITH NO AREA ROW. `public.areas` holds two families: region-shaped rows (Cairo,
//      Giza, Delta (1), Alex-BHR, Upper Egypt, Egypt) that exist so a manager has something to
//      point at, and true rep areas (UE1, D12, AB4, GZ6 …). The Upper Egypt split of 2026-09-01
//      created two regions in the seat model and no matching area rows, so the migration pinned
//      those vacancies to a member area and said so in its own note: "Area set to Sohag1, one of
//      its own areas." There was nothing else to point at.
//
//   2. COPY-FORWARD THROUGH A RESIGNATION. `phx_ensure_terminal_employee_vacancy` opens the
//      replacement vacancy by copying the LEAVER's `area_id`, and the next hire inherits it from
//      the vacancy through the Add Employee prefill. So a wrong area never self-corrects — it is
//      handed to the next person in the seat, forever. Delta (1) is the proof that this half is
//      independent of the first: the correct region-shaped area row has existed all along, and all
//      three Delta (1) managers were still carrying Menoufia 1.
//
// Cause 1 is what this module detects, because cause 2 cannot start without it and is silent by
// construction — a resignation is not the moment anyone inspects a geography.
//
// DELIBERATELY PURE. No database, no React: the nightly territory re-stamp loads the rows and this
// decides. A rule that must always hold is worth more as a function that can be tested against
// invented data than as a query nobody re-reads.

/** Job titles that own a REGION rather than an area. Matched case-insensitively as substrings. */
export const MANAGER_TITLE_PATTERNS = [
  "district sales manager",
  "district manager",
  "regional sales manager",
  "regional manager",
  "national sales manager",
] as const;

/**
 * Regions that legitimately have no area row of their own.
 *
 * `Others` is the pseudo-district: it carries sales and no target, has no manager seat anyone can
 * hold, and must never be reported as a missing area row. Adding a real region here would silence
 * the very thing this module exists to catch, so it stays a single named exception.
 */
export const REGIONS_WITHOUT_AN_AREA_ROW = new Set(["others"]);

export type ManagerRow = {
  hrId: string;
  fullName: string | null;
  jobTitle: string | null;
  regionName: string | null;
  areaId: number | null;
  areaName: string | null;
};

export type AreaRow = {
  areaId: number;
  areaName: string;
};

export type ManagerAreaFinding =
  | {
    kind: "region_has_no_area_row";
    regionName: string;
    managers: string[];
    detail: string;
  }
  | {
    kind: "manager_area_is_not_region";
    hrId: string;
    fullName: string | null;
    regionName: string;
    areaName: string | null;
    expectedAreaId: number;
    expectedAreaName: string;
    detail: string;
  };

function key(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** True when this title owns a region. A rep, a coordinator or a product manager does not. */
export function isRegionOwningTitle(jobTitle: string | null | undefined): boolean {
  const title = key(jobTitle);
  if (!title) return false;
  return MANAGER_TITLE_PATTERNS.some((pattern) => title.includes(pattern));
}

/** Region name -> the area row that represents it, keyed case- and whitespace-insensitively. */
export function indexRegionShapedAreas(areas: readonly AreaRow[]): Map<string, AreaRow> {
  const index = new Map<string, AreaRow>();
  for (const area of areas) {
    const name = key(area.areaName);
    if (!name) continue;
    // First writer wins: two rows with the same name is itself a data problem, and picking the
    // lower id keeps the answer stable run to run rather than depending on row order.
    const existing = index.get(name);
    if (!existing || area.areaId < existing.areaId) index.set(name, area);
  }
  return index;
}

/**
 * Every manager whose recorded area is not his region, and every region that has no area row for a
 * manager to point at.
 *
 * Returns findings rather than throwing: this runs inside the nightly re-stamp, and a geography
 * problem must never take down a job whose actual work is unrelated.
 */
export function detectManagerAreaDrift(
  managers: readonly ManagerRow[],
  areas: readonly AreaRow[],
): ManagerAreaFinding[] {
  const regionAreas = indexRegionShapedAreas(areas);
  const findings: ManagerAreaFinding[] = [];
  const regionsMissingAnArea = new Map<string, { regionName: string; managers: string[] }>();

  for (const manager of managers) {
    if (!isRegionOwningTitle(manager.jobTitle)) continue;

    const regionName = String(manager.regionName ?? "").trim();
    const regionKey = key(regionName);
    if (!regionKey || REGIONS_WITHOUT_AN_AREA_ROW.has(regionKey)) continue;

    const expected = regionAreas.get(regionKey);
    if (!expected) {
      const bucket = regionsMissingAnArea.get(regionKey) ?? { regionName, managers: [] };
      bucket.managers.push(manager.hrId);
      regionsMissingAnArea.set(regionKey, bucket);
      continue;
    }

    if (manager.areaId === expected.areaId) continue;

    findings.push({
      kind: "manager_area_is_not_region",
      hrId: manager.hrId,
      fullName: manager.fullName,
      regionName,
      areaName: manager.areaName,
      expectedAreaId: expected.areaId,
      expectedAreaName: expected.areaName,
      detail:
        `${manager.fullName ?? manager.hrId} runs ${regionName} but is recorded against `
        + `${manager.areaName ?? "(no area)"}. A manager owns a region; that area belongs to a rep, `
        + `and every screen that groups by area now shows him occupying it.`,
    });
  }

  for (const bucket of regionsMissingAnArea.values()) {
    findings.push({
      kind: "region_has_no_area_row",
      regionName: bucket.regionName,
      managers: bucket.managers.slice().sort(),
      detail:
        `${bucket.regionName} has no area row of its own, so a manager there has nothing to point `
        + `at and will be pinned to one of his rep areas instead. Create a region-shaped area row `
        + `named "${bucket.regionName}" before recording a manager against it.`,
    });
  }

  return findings;
}

/** One line for the audit row and the log, or null when the geography is clean. */
export function describeManagerAreaDrift(findings: readonly ManagerAreaFinding[]): string | null {
  if (findings.length === 0) return null;
  const missing = findings.filter((f) => f.kind === "region_has_no_area_row").length;
  const drifted = findings.length - missing;
  const parts: string[] = [];
  if (drifted > 0) parts.push(`${drifted} manager(s) recorded against a rep area instead of their region`);
  if (missing > 0) parts.push(`${missing} region(s) with no area row to point at`);
  return `Manager geography: ${parts.join("; ")}.`;
}
