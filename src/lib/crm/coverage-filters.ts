/**
 * Region → Line → Area → Rep, the one filter model both CRM coverage boards share.
 *
 * The owner asked for the same four filters on Doctor Coverage and on Brick Coverage, so the
 * cascade lives HERE and neither board owns a copy. Two boards that filter "the same way" by each
 * implementing it are two boards that disagree the first time one is edited — and these two are
 * deliberately built to read as one module.
 *
 * Everything resolves from `au_v_line_area_map`, the same view the boards already read for
 * territories, so a filter can never disagree with the numbers it filters. Measured against
 * production 2026-08-21: 107 map rows → 8 regions, 3 lines, 39 areas, ~73 filled rep seats, with
 * ZERO rows missing a region, line or area code. There is no "unassigned" bucket and no fallback —
 * if that ever stops being true `buildCoverageFilterTree` drops the row rather than inventing a
 * home for it, and `droppedRows` reports how many, so the gap is visible instead of silently
 * shrinking the denominator.
 *
 * ── Why this is built on CELLS and not on four sets ──────────────────────────────────────────────
 * The obvious implementation collects regions, lines and areas into three sets and narrows each
 * independently. That produces DEAD ENDS, and production has a real one: Beni Suef belongs to Giza
 * on one line and to a different region on another, so "Giza" and "Anti Infective" each match it
 * while no rep satisfies both at once — the picker offered the combination and the board came back
 * empty, looking like a rep with no work rather than an impossible filter. (This is the same
 * per-line Fayoum/Beni Suef split that has bitten Source of Sales.)
 *
 * So the tree keeps the actual (region, line, area, seat) COMBINATIONS and every option list is
 * derived by filtering those. An option is offered only if at least one real cell backs it, which
 * makes an empty board mean "nobody there", never "that pairing never existed".
 *
 * ── Why the cascade uses FILLED cells only ───────────────────────────────────────────────────────
 * A territory can carry a sales target and still have nobody in the seat. Sampled twice on
 * 2026-08-21 that is not an edge case: 34 then 33 of the 107 target-carrying cells were VACANT
 * (roughly a third, spread across all three lines), and Beni Suef had no rep on any line at all.
 * The figure MOVES — a seat was filled between those two reads — so treat it as a live measurement,
 * never as a constant to assert from. Offering vacant territories in the picker
 * produced a filter that resolved to zero reps, which on a coverage board reads as "this team
 * covered nothing" rather than "there is no team". So the cascade is derived from cells whose seat
 * is actually filled by a REP.
 *
 * This derivation was cross-checked against the org model on 2026-08-21 and agrees EXACTLY: the
 * cells with no seated REP are precisely the `area_state = 'vacant_will_hire'` ones (33), and every
 * `occupied` cell has somebody in it (74), with zero rows disagreeing either way. That is the
 * expected relationship — `au.line_area_map.carries_target` is generated as
 * `area_state in ('occupied','vacant_will_hire')`, so "carries a target with an empty seat" is a
 * state the org model defines rather than an anomaly. Worth re-running that comparison if this ever
 * looks wrong, because hires do NOT flow into the seat model automatically.
 *
 * They are not swept under the rug: the vacant cells come back as `tree.vacancies` so a board can
 * state the gap as the business fact it is. Dropping a territory from a picker is only honest if
 * something else says it exists — this is the same reason the brick board lists reps with no GPS
 * feed as unscored instead of as zero.
 *
 * ── This module is PURE and must stay that way ───────────────────────────────────────────────────
 * The filter bar runs `narrowCoverageOptions` in the BROWSER so the dropdowns re-narrow as you pick
 * instead of after a server round trip per select. That only works while this file imports nothing
 * server-only — the loader lives in `coverage-filters-data.ts` for exactly that reason. Adding an
 * import of `next/cache`, the Supabase client, or anything reaching for `process.env` here drags
 * the server bundle into the client and breaks the build. Put it in the data module instead.
 */

/**
 * The agent-key convention every CRM board already uses — `hr:<lowercased hr id>` when the agent is
 * mapped to an employee, `crm:<id>` when it is not. Copied from `repKeyOf` in sfe-doctor-coverage.ts
 * (itself shared with sfe-field-analytics.ts) because the keys this module produces are matched
 * against the keys THOSE produce, and a filter whose keys are shaped differently matches nothing at
 * all — it would look like a rep with no doctors rather than like a bug.
 *
 * Deliberately NOT `canonicalHrIdKey`: that also folds the legacy `aaa` → `aa` alias, which the
 * boards do not, so canonicalizing here could only invent a key no board row carries.
 */
export const coverageRepKey = (hrId: string): string => `hr:${hrId.trim().toLowerCase()}`;

/** One selectable value. `code` rides in the URL; `name` is the only thing ever shown. */
export type CoverageFilterOption = { code: string; name: string };

/** One real combination that exists in the org today. The unit the whole cascade is derived from. */
export type CoverageFilterCell = {
  areaCode: string;
  lineCode: string;
  regionCode: string;
  seatId: string;
};

/** A territory that carries a target but has nobody in the seat. Reported, never filtered on. */
export type CoverageFilterVacancy = CoverageFilterCell & { areaName: string; lineName: string; regionName: string };

export type CoverageFilterRep = {
  hrId: string;
  repKey: string;
  repName: string;
  seatId: string;
};

export type CoverageFilterTree = {
  /** Every known area name, including vacant ones — a lookup, NOT the offered list. */
  areas: CoverageFilterOption[];
  /** Target-carrying territories whose seat is FILLED. The cascade's whole domain. */
  cells: CoverageFilterCell[];
  /** Map rows that carried no region/line/area/seat code and were dropped. Expected 0. */
  droppedRows: number;
  lines: CoverageFilterOption[];
  regions: CoverageFilterOption[];
  reps: CoverageFilterRep[];
  /** Target-carrying territories with an empty seat. Roughly a third of 107 in production. */
  vacancies: CoverageFilterVacancy[];
};

/** What the viewer picked. Absent/empty means "all" at that level. */
export type CoverageFilterSelection = {
  area?: string;
  line?: string;
  region?: string;
  rep?: string;
};

/** The option lists to render, each narrowed by the levels ABOVE it. */
export type CoverageFilterOptions = {
  areas: CoverageFilterOption[];
  lines: CoverageFilterOption[];
  regions: CoverageFilterOption[];
  reps: CoverageFilterOption[];
};

/** Raw shapes the pure core consumes — also the test-fixture shapes. */
export type CoverageFilterMapRow = {
  areaCode: string | null;
  areaName: string | null;
  lineCode: string | null;
  regionCode: string | null;
  repSeatId: string | null;
};

export type CoverageFilterSeatRow = {
  fullName: string | null;
  hrId: string | null;
  seatId: string | null;
  seatTier: string | null;
};

const clean = (value: string | null | undefined): string => (value ?? "").trim();

/** PURE CORE — fixture-testable, no IO. */
export function buildCoverageFilterTree({
  areaNames: areaNameOverrides,
  lineNames,
  mapRows,
  regionNames,
  seats,
}: {
  areaNames?: Map<string, string>;
  lineNames: Map<string, string>;
  mapRows: CoverageFilterMapRow[];
  regionNames: Map<string, string>;
  seats: CoverageFilterSeatRow[];
}): CoverageFilterTree {
  const allCells: CoverageFilterCell[] = [];
  const areaNames = new Map<string, string>(areaNameOverrides ?? []);
  const seatIdsWithWork = new Set<string>();
  let droppedRows = 0;

  for (const row of mapRows) {
    const areaCode = clean(row.areaCode);
    const lineCode = clean(row.lineCode);
    const regionCode = clean(row.regionCode);
    const seatId = clean(row.repSeatId);

    // A row missing any dimension cannot be placed in the cascade. Counted, never guessed.
    if (!areaCode || !lineCode || !regionCode || !seatId) {
      droppedRows += 1;
      continue;
    }
    allCells.push({ areaCode, lineCode, regionCode, seatId });
    seatIdsWithWork.add(seatId);
    if (!areaNames.has(areaCode)) areaNames.set(areaCode, clean(row.areaName) || areaCode);
  }

  const reps: CoverageFilterRep[] = [];
  const filledSeatIds = new Set<string>();
  for (const seat of seats) {
    const seatId = clean(seat.seatId);
    const hrId = clean(seat.hrId);
    // A seat with no cell carries no target anywhere, so it can never match a filter.
    if (seat.seatTier !== "REP" || !seatId || !hrId || !seatIdsWithWork.has(seatId)) continue;
    filledSeatIds.add(seatId);
    reps.push({
      hrId,
      repKey: coverageRepKey(hrId),
      repName: clean(seat.fullName) || hrId,
      seatId,
    });
  }

  // The split that keeps the picker dead-end free. `cells` drives every option list; the rest is
  // real, target-carrying, and empty — so it is handed back to be reported, not discarded.
  const name = (names: Map<string, string>, code: string) => names.get(code) ?? code;
  const cells = allCells.filter((cell) => filledSeatIds.has(cell.seatId));
  const vacancies = allCells
    .filter((cell) => !filledSeatIds.has(cell.seatId))
    .map((cell) => ({
      ...cell,
      areaName: name(areaNames, cell.areaCode),
      lineName: name(lineNames, cell.lineCode),
      regionName: name(regionNames, cell.regionCode),
    }))
    .sort((a, b) => a.lineName.localeCompare(b.lineName) || a.areaName.localeCompare(b.areaName));

  // Name lookups span EVERY cell, vacant included, so a hand-typed URL still resolves to a name.
  const distinct = (pick: (cell: CoverageFilterCell) => string, names: Map<string, string>) =>
    [...new Set(allCells.map(pick))]
      .map((code) => ({ code, name: name(names, code) }))
      .sort((a, b) => a.name.localeCompare(b.name));

  return {
    areas: distinct((c) => c.areaCode, areaNames),
    cells,
    droppedRows,
    lines: distinct((c) => c.lineCode, lineNames),
    regions: distinct((c) => c.regionCode, regionNames),
    reps: reps.sort((a, b) => a.repName.localeCompare(b.repName)),
    vacancies,
  };
}

/** Does this cell satisfy every geography level that is selected? */
const cellMatches = (cell: CoverageFilterCell, selection: CoverageFilterSelection): boolean =>
  (!selection.region || cell.regionCode === selection.region) &&
  (!selection.line || cell.lineCode === selection.line) &&
  (!selection.area || cell.areaCode === selection.area);

/**
 * The reps a selection resolves to. Empty selection → every rep in the tree.
 *
 * A rep survives when at least one of HIS cells satisfies all the selected levels AT ONCE — which
 * is exactly what makes the Beni Suef pairing impossible to reach rather than silently empty.
 *
 * Returns the REPS rather than a key set because the two CRM coverage boards key reps differently
 * and there is no single right answer to hand back. Doctor Coverage (and sfe-field-analytics) use
 * `hr:<lowercased id>`; Brick Coverage uses the bare `canonicalHrIdKey` with no prefix. Each caller
 * maps `rep.hrId` into its own convention — handing back one board's keys and letting the other
 * "just use them" is how a filter ends up matching nothing while looking perfectly correct.
 */
export function repsMatching(
  tree: CoverageFilterTree,
  selection: CoverageFilterSelection,
): CoverageFilterRep[] {
  const seatIds = new Set(tree.cells.filter((cell) => cellMatches(cell, selection)).map((cell) => cell.seatId));
  return tree.reps.filter((rep) => seatIds.has(rep.seatId) && (!selection.rep || rep.repKey === selection.rep));
}

/**
 * The vacant territories inside the current selection — target-carrying, and nobody in the seat.
 *
 * Filtered by the same geography the board is filtered by, so "3 territories have no rep" always
 * means three inside what the viewer is looking at, never three somewhere else in the country.
 *
 * A vacancy has no rep, so a selected rep cannot be matched against it directly — but ignoring the
 * rep level would answer a question about one person with 33 gaps from across the country. Instead
 * the rep is read as a PLACE: the vacancies kept are the ones sharing a region and line with the
 * territory that rep actually works, which is the gap standing next to him.
 */
export function vacanciesMatching(
  tree: CoverageFilterTree,
  selection: CoverageFilterSelection,
): CoverageFilterVacancy[] {
  const geography = { area: selection.area, line: selection.line, region: selection.region };
  const inGeography = tree.vacancies.filter((vacancy) => cellMatches(vacancy, geography));
  if (!selection.rep) return inGeography;

  const rep = tree.reps.find((candidate) => candidate.repKey === selection.rep);
  if (!rep) return inGeography;
  // Compared field by field rather than through a joined key: any separator character could in
  // principle turn up inside a region or line code, and a collision would surface the wrong gaps.
  const beside = tree.cells.filter((cell) => cell.seatId === rep.seatId);
  return inGeography.filter((vacancy) =>
    beside.some((cell) => cell.regionCode === vacancy.regionCode && cell.lineCode === vacancy.lineCode),
  );
}

/** The matching reps as {@link coverageRepKey} keys — the Doctor Coverage / field-analytics form. */
export function repKeysMatching(tree: CoverageFilterTree, selection: CoverageFilterSelection): Set<string> {
  return new Set(repsMatching(tree, selection).map((rep) => rep.repKey));
}

/**
 * The four dropdowns, each narrowed by the levels ABOVE it only.
 *
 * Region always shows everything: narrowing the top of the cascade by the bottom would mean picking
 * a rep hides the region you would switch to, turning "change my mind" into "clear everything and
 * start again".
 */
export function narrowCoverageOptions(
  tree: CoverageFilterTree,
  selection: CoverageFilterSelection,
): CoverageFilterOptions {
  const name = (options: CoverageFilterOption[], code: string) =>
    options.find((o) => o.code === code)?.name ?? code;

  const optionsFrom = (
    all: CoverageFilterOption[],
    level: CoverageFilterSelection,
    pick: (cell: CoverageFilterCell) => string,
  ) => {
    const codes = new Set(tree.cells.filter((cell) => cellMatches(cell, level)).map(pick));
    return [...codes]
      .map((code) => ({ code, name: name(all, code) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const lines = optionsFrom(tree.lines, { region: selection.region }, (c) => c.lineCode);
  const areas = optionsFrom(tree.areas, { line: selection.line, region: selection.region }, (c) => c.areaCode);

  const repSeatIds = new Set(
    tree.cells
      .filter((cell) => cellMatches(cell, { area: selection.area, line: selection.line, region: selection.region }))
      .map((cell) => cell.seatId),
  );
  const reps = tree.reps
    .filter((rep) => repSeatIds.has(rep.seatId))
    .map((rep) => ({ code: rep.repKey, name: rep.repName }));

  return { areas, lines, regions: tree.regions, reps };
}

/**
 * Human-readable description of the current filter — names only, never codes (owner's standing
 * rule), for the on-screen "whose numbers are these" line.
 */
export function describeCoverageSelection(
  tree: CoverageFilterTree,
  selection: CoverageFilterSelection,
): string {
  const name = (options: CoverageFilterOption[], code: string | undefined) =>
    code ? (options.find((o) => o.code === code)?.name ?? code) : null;

  const parts = [
    name(tree.regions, selection.region),
    name(tree.lines, selection.line),
    name(tree.areas, selection.area),
    selection.rep ? (tree.reps.find((r) => r.repKey === selection.rep)?.repName ?? selection.rep) : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join(" · ");
}

/** Normalizes raw searchParams into a selection, dropping blanks so "" never reads as a filter. */
export function resolveCoverageSelection(params: {
  area?: string;
  line?: string;
  region?: string;
  rep?: string;
}): CoverageFilterSelection {
  const take = (value: string | undefined) => {
    const trimmed = clean(value);
    return trimmed.length > 0 ? trimmed : undefined;
  };
  return { area: take(params.area), line: take(params.line), region: take(params.region), rep: take(params.rep) };
}

/** True when anything is in force — so the UI offers "clear" only when it would do something. */
export const coverageSelectionIsActive = (selection: CoverageFilterSelection): boolean =>
  Boolean(selection.region || selection.line || selection.area || selection.rep);

/**
 * Drops any level the levels above it no longer offer, top down.
 *
 * Needed in BOTH directions. In the browser: switching region while an area is selected would
 * otherwise leave an area from the old region sitting in the form, showing a combination the
 * dropdowns never offered. On the server: a bookmarked, shared, or hand-edited URL can carry any
 * pair of codes at all, and `?region=giza&area=<an Alexandria area>` must resolve to "Giza" rather
 * than to a contradiction that renders as an empty board.
 *
 * Pruning rather than rejecting is the deliberate choice — a stale link keeps as much of what it
 * asked for as still makes sense instead of silently dumping the viewer back to everything.
 */
export function pruneCoverageSelection(
  tree: CoverageFilterTree,
  selection: CoverageFilterSelection,
): CoverageFilterSelection {
  const keep = (value: string | undefined, offered: CoverageFilterOption[]) =>
    value && offered.some((option) => option.code === value) ? value : undefined;

  const region = keep(selection.region, tree.regions);
  const line = keep(selection.line, narrowCoverageOptions(tree, { region }).lines);
  const area = keep(selection.area, narrowCoverageOptions(tree, { line, region }).areas);
  const rep = keep(selection.rep, narrowCoverageOptions(tree, { area, line, region }).reps);

  return { area, line, region, rep };
}
