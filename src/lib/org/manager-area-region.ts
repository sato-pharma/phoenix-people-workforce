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

/**
 * Job titles that own EXACTLY ONE region. Matched case-insensitively as substrings.
 *
 * DISTRICT LEVEL ONLY, AND THAT IS THE WHOLE POINT. The invariant this module enforces is "one
 * manager, one region, so his area and his team are that region's". Only a district manager
 * satisfies the premise.
 *
 * A REGIONAL manager does not, and the first version of this list wrongly included him. Measured on
 * production 2026-09-11: PD-0001 is Pedia's Regional Sales Manager and manages three district
 * managers across Alex-BHR, Delta (1) and Delta (2). His `region_name` reads Alex-BHR, which is an
 * approximation rather than a territory, and his team is named Alex-Delta, which describes his real
 * span more honestly than any single region name could. Checking him against "his" region reports a
 * defect that is not one.
 *
 * A NATIONAL manager is excluded for the same reason one rank higher: he owns a line, not a region.
 * He happens to pass today because his region reads Egypt and both an Egypt area and an Egypt team
 * exist, but that is a coincidence of the data and not the rule holding.
 *
 * DO NOT WIDEN THIS LIST on the reasoning that a regional manager also owns a region. He owns
 * several, and the check has no way to say which.
 */
export const MANAGER_TITLE_PATTERNS = [
  "district sales manager",
  "district manager",
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
  /** His team, and the area that team hangs off — the same drift, one table over. */
  teamId: number | null;
  teamName: string | null;
  teamAreaId: number | null;
  teamAreaName: string | null;
};

export type AreaRow = {
  areaId: number;
  areaName: string;
};

export type TeamRow = {
  teamId: number;
  teamName: string;
  areaId: number | null;
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
  }
  | {
    kind: "region_has_no_team_row";
    regionName: string;
    managers: string[];
    detail: string;
  }
  | {
    kind: "manager_team_is_not_region";
    hrId: string;
    fullName: string | null;
    regionName: string;
    teamName: string | null;
    teamAreaName: string | null;
    expectedTeamId: number;
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
export function indexRegionTeams(
  teams: readonly TeamRow[],
  regionAreas: ReadonlyMap<string, AreaRow>,
): Map<string, TeamRow> {
  const index = new Map<string, TeamRow>();
  for (const team of teams) {
    const name = key(team.teamName);
    if (!name) continue;
    const regionArea = regionAreas.get(name);
    // A region's team is the one NAMED for the region AND sitting on the region's own area. Both
    // halves are load-bearing: several rep-area teams carry a region's name (`ue9_upper_egypt_1`
    // hangs off Beni Suef), and matching on the name alone would accept one of those and call the
    // drift clean.
    if (!regionArea || team.areaId !== regionArea.areaId) continue;
    const existing = index.get(name);
    if (!existing || team.teamId < existing.teamId) index.set(name, team);
  }
  return index;
}

export function detectManagerAreaDrift(
  managers: readonly ManagerRow[],
  areas: readonly AreaRow[],
  /**
   * Omit to check areas only. Passing an empty array is NOT the same thing: it means "no teams
   * exist", which is a finding. A caller that cannot read teams must omit rather than pass [], or
   * it reports every manager as teamless.
   */
  teams?: readonly TeamRow[],
  /**
   * HR ids that hold a REP seat. A district-titled person in this set is an ACTING district manager
   * still sitting in his own rep seat, and the seat rule (the employee row equals the seat) keeps
   * his area and team on that rep area — so neither check applies to him. `seat-titles.ts` titles
   * an acting district manager "District Sales Manager" on purpose, which is why the title alone
   * cannot tell him apart. Measured on production 2026-10-25: Upper Egypt 1's acting manager on
   * Minia 1 was the only one, and the nightly check reported her as drifted every night.
   */
  repSeatHolders?: ReadonlySet<string>,
): ManagerAreaFinding[] {
  const regionAreas = indexRegionShapedAreas(areas);
  const regionTeams = teams === undefined ? null : indexRegionTeams(teams, regionAreas);
  const findings: ManagerAreaFinding[] = [];
  const regionsMissingAnArea = new Map<string, { regionName: string; managers: string[] }>();
  const regionsMissingATeam = new Map<string, { regionName: string; managers: string[] }>();

  for (const manager of managers) {
    if (!isRegionOwningTitle(manager.jobTitle)) continue;
    if (repSeatHolders?.has(manager.hrId)) continue;

    const regionName = String(manager.regionName ?? "").trim();
    const regionKey = key(regionName);
    if (!regionKey || REGIONS_WITHOUT_AN_AREA_ROW.has(regionKey)) continue;

    const expected = regionAreas.get(regionKey);
    if (!expected) {
      const bucket = regionsMissingAnArea.get(regionKey) ?? { regionName, managers: [] };
      bucket.managers.push(manager.hrId);
      regionsMissingAnArea.set(regionKey, bucket);
      // No area row means no region team either, and one finding per region is enough to act on.
      continue;
    }

    if (manager.areaId !== expected.areaId) {
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
          + `and every screen that groups by area now shows them occupying it.`,
      });
    }

    // The same drift, one table over. Checked independently of the area verdict: the two columns
    // are written by different paths and one was found correct while the other was not.
    if (regionTeams === null) continue;
    const expectedTeam = regionTeams.get(regionKey);
    if (!expectedTeam) {
      const bucket = regionsMissingATeam.get(regionKey) ?? { regionName, managers: [] };
      bucket.managers.push(manager.hrId);
      regionsMissingATeam.set(regionKey, bucket);
      continue;
    }

    if (manager.teamId === expectedTeam.teamId) continue;

    findings.push({
      kind: "manager_team_is_not_region",
      hrId: manager.hrId,
      fullName: manager.fullName,
      regionName,
      teamName: manager.teamName,
      teamAreaName: manager.teamAreaName,
      expectedTeamId: expectedTeam.teamId,
      detail:
        `${manager.fullName ?? manager.hrId} runs ${regionName} but sits on team `
        + `${manager.teamName ?? "(no team)"}, which hangs off ${manager.teamAreaName ?? "no area"}. `
        + `A manager's team belongs on their region's own area. The team NAME can read correctly while `
        + `this is wrong, so the screen shows nothing amiss.`,
    });
  }

  for (const bucket of regionsMissingAnArea.values()) {
    findings.push({
      kind: "region_has_no_area_row",
      regionName: bucket.regionName,
      managers: bucket.managers.slice().sort(),
      detail:
        `${bucket.regionName} has no area row of its own, so a manager there has nothing to point `
        + `at and will be pinned to one of their rep areas instead. Create a region-shaped area row `
        + `named "${bucket.regionName}" before recording a manager against it.`,
    });
  }

  for (const bucket of regionsMissingATeam.values()) {
    findings.push({
      kind: "region_has_no_team_row",
      regionName: bucket.regionName,
      managers: bucket.managers.slice().sort(),
      detail:
        `${bucket.regionName} has no team on its own area, so a manager there will be put on a `
        + `rep-area team instead. Create a team named "${bucket.regionName}" on that region's area.`,
    });
  }

  return findings;
}

/** One line for the audit row and the log, or null when the geography is clean. */
export function describeManagerAreaDrift(findings: readonly ManagerAreaFinding[]): string | null {
  if (findings.length === 0) return null;
  const count = (kind: ManagerAreaFinding["kind"]) => findings.filter((f) => f.kind === kind).length;
  const areaDrift = count("manager_area_is_not_region");
  const teamDrift = count("manager_team_is_not_region");
  const missingArea = count("region_has_no_area_row");
  const missingTeam = count("region_has_no_team_row");
  const parts: string[] = [];
  if (areaDrift > 0) parts.push(`${areaDrift} manager(s) recorded against a rep area instead of their region`);
  if (teamDrift > 0) parts.push(`${teamDrift} manager(s) on a team that hangs off a rep area`);
  if (missingArea > 0) parts.push(`${missingArea} region(s) with no area row to point at`);
  if (missingTeam > 0) parts.push(`${missingTeam} region(s) with no team on their own area`);
  return `Manager geography: ${parts.join("; ")}.`;
}
