import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCoverageFilterTree,
  coverageRepKey,
  describeCoverageSelection,
  narrowCoverageOptions,
  pruneCoverageSelection,
  repKeysMatching,
  repsMatching,
  resolveCoverageSelection,
  restrictCoverageFilterTree,
  vacanciesMatching,
  type CoverageFilterMapRow,
  type CoverageFilterSeatRow,
} from "../src/lib/crm/coverage-filters.ts";

// The Region → Line → Area → Rep cascade shared by both CRM coverage boards.
//
// Each block below pins a failure that was REAL against production, not a hypothetical:
//
//   1. Dead-end combinations. Narrowing each dimension independently offered "Giza + Anti Infective
//      + Beni Suef", which no rep satisfies — Beni Suef sits in one region on one line and another
//      on a different line. The board came back empty, reading as "this team covered nothing".
//   2. Vacant territories. About a third of target-carrying seats have nobody in them; offering
//      those produced the same empty board for the same misleading reason.
//   3. Raw line codes. The picker showed `anti_infective`, against the owner's standing rule that
//      the UI shows human-readable names and never raw codes.
//   4. Rep-key convention drift. The two boards key the same rep differently; a filter whose keys
//      are shaped wrong matches NOTHING while looking entirely correct.

const lineNames = new Map([
  ["anti_infective", "Anti Infective"],
  ["pedia", "Pedia"],
]);
const regionNames = new Map([
  ["giza", "Giza"],
  ["upper", "Upper Egypt"],
]);

// Beni Suef is the real shape: Upper Egypt on Anti Infective, Giza on Pedia. No rep is in both.
const cell = (regionCode: string, lineCode: string, areaCode: string, areaName: string, repSeatId: string): CoverageFilterMapRow => ({
  areaCode,
  areaName,
  lineCode,
  regionCode,
  repSeatId,
});

const MAP_ROWS: CoverageFilterMapRow[] = [
  cell("giza", "anti_infective", "dokki", "Dokki", "SEAT-1"),
  cell("upper", "anti_infective", "beni", "Beni Suef", "SEAT-2"),
  cell("giza", "pedia", "beni", "Beni Suef", "SEAT-3"),
  cell("upper", "anti_infective", "sohag", "Sohag", "SEAT-4"),
  // Carries a target, but SEAT-9 is nobody's seat — the vacancy case.
  cell("giza", "pedia", "haram", "Haram", "SEAT-9"),
];

const SEATS: CoverageFilterSeatRow[] = [
  { fullName: "Omayma Wael", hrId: "AI-0009", seatId: "SEAT-1", seatTier: "REP" },
  { fullName: "Bishoy Nabil", hrId: "B-143", seatId: "SEAT-2", seatTier: "REP" },
  { fullName: "Mona Adel", hrId: "CN-0006", seatId: "SEAT-3", seatTier: "REP" },
  { fullName: "Karim Fouad", hrId: "B-58", seatId: "SEAT-4", seatTier: "REP" },
  // A manager sitting on a target-carrying seat must NOT show up as a rep.
  { fullName: "A District Manager", hrId: "DM-1", seatId: "SEAT-1", seatTier: "DM" },
];

const tree = () => buildCoverageFilterTree({ lineNames, mapRows: MAP_ROWS, regionNames, seats: SEATS });

function testBuildsFromRealCombinations() {
  const t = tree();
  assert.equal(t.droppedRows, 0, "no fixture row is missing a dimension");
  assert.equal(t.cells.length, 4, "four filled cells; the vacant one is held out");
  assert.equal(t.reps.length, 4, "four reps — the DM on a rep seat is not one of them");
  assert.deepEqual(
    t.reps.map((rep) => rep.repName),
    ["Bishoy Nabil", "Karim Fouad", "Mona Adel", "Omayma Wael"],
    "reps come back sorted by name",
  );
}

function testDroppedRowsAreCountedNotGuessed() {
  const t = buildCoverageFilterTree({
    lineNames,
    mapRows: [...MAP_ROWS, cell("giza", "", "nowhere", "Nowhere", "SEAT-1")],
    regionNames,
    seats: SEATS,
  });
  assert.equal(t.droppedRows, 1, "a row with no line code is dropped, and SAID to be dropped");
  assert.ok(
    !t.areas.some((area) => area.code === "nowhere"),
    "and it never becomes a filter option — no invented home for an unplaceable row",
  );
}

/** BUG 1 — the one this module exists to prevent. */
function testNoDeadEndCombination() {
  const t = tree();

  // The exact pairing that failed in production.
  const gizaAnti = narrowCoverageOptions(t, { line: "anti_infective", region: "giza" });
  assert.ok(
    !gizaAnti.areas.some((area) => area.code === "beni"),
    "Beni Suef is NOT offered under Giza + Anti Infective — no rep is in both",
  );
  assert.deepEqual(gizaAnti.areas.map((a) => a.code), ["dokki"], "only the area that really exists there");

  // And exhaustively: no combination the dropdowns can reach may resolve to zero reps.
  const deadEnds: string[] = [];
  for (const region of [undefined, ...narrowCoverageOptions(t, {}).regions.map((r) => r.code)]) {
    for (const line of [undefined, ...narrowCoverageOptions(t, { region }).lines.map((l) => l.code)]) {
      for (const area of [undefined, ...narrowCoverageOptions(t, { line, region }).areas.map((a) => a.code)]) {
        for (const rep of [undefined, ...narrowCoverageOptions(t, { area, line, region }).reps.map((r) => r.code)]) {
          const selection = { area, line, region, rep };
          if (repKeysMatching(t, selection).size === 0) {
            deadEnds.push(describeCoverageSelection(t, selection) || "(no filter)");
          }
        }
      }
    }
  }
  assert.deepEqual(deadEnds, [], "every combination the picker offers resolves to at least one rep");
}

/** BUG 2 — a vacant territory must vanish from the picker but stay visible as a fact. */
function testVacantTerritoriesAreHeldOutAndReported() {
  const t = tree();
  assert.ok(
    !narrowCoverageOptions(t, {}).areas.some((area) => area.code === "haram"),
    "an area whose only seat is empty is never offered — it could only ever score zero",
  );
  assert.equal(t.vacancies.length, 1, "and it is reported rather than silently dropped");
  assert.deepEqual(
    { areaName: t.vacancies[0].areaName, lineName: t.vacancies[0].lineName, regionName: t.vacancies[0].regionName },
    { areaName: "Haram", lineName: "Pedia", regionName: "Giza" },
    "the vacancy carries NAMES, so a board can state the gap in words",
  );
}

/** BUG 3 — the owner's standing rule: names on screen, never raw codes. */
function testOptionsAndLabelsUseNames() {
  const t = tree();
  assert.deepEqual(
    t.lines.map((line) => line.name),
    ["Anti Infective", "Pedia"],
    "line options are humanized from public.lines, not title-cased from the code",
  );

  const label = describeCoverageSelection(t, { area: "dokki", line: "anti_infective", region: "giza", rep: "hr:ai-0009" });
  assert.equal(label, "Giza · Anti Infective · Dokki · Omayma Wael", "the on-screen scope line reads in names");
  for (const code of ["anti_infective", "giza", "dokki", "hr:ai-0009"]) {
    assert.ok(!label.includes(code), `the label must not leak the raw code ${code}`);
  }
}

/** BUG 4 — the silent one. Wrong-shaped keys match nothing and look perfectly fine doing it. */
function testRepKeyMatchesTheBoardConvention() {
  assert.equal(coverageRepKey("AI-0009"), "hr:ai-0009", "prefixed and lowercased, like every CRM board");
  assert.equal(coverageRepKey("  b-143 "), "hr:b-143", "surrounding whitespace never reaches the key");

  // Fingerprint the convention at its source. If the rep key in sfe-doctor-coverage.ts is ever
  // changed, the cascade's keys stop matching the board's and EVERY territory filter silently
  // returns nothing — so that edit has to come here and be made deliberately, in both places.
  //
  // The expression MOVED on 2026-08-27 (`repKeyOf(visit)` → `repKeyFor(hrId, crmId)`) when the
  // panel became the rep's assigned list: the key now has to be resolvable from a PLAN row too,
  // and a crm id seen with an hr id in either mirror pins that crm id's key. The convention itself
  // — `hr:` plus the lower-cased hr id — is unchanged, which is the whole point of this check.
  const source = readFileSync("src/lib/crm/sfe-doctor-coverage.ts", "utf8");
  assert.ok(
    source.includes("return `hr:${hrId.toLowerCase()}`;"),
    "sfe-doctor-coverage still keys mapped agents as hr:<lowercased id> — update coverageRepKey together with it",
  );
  assert.ok(
    source.includes("const key = `hr:${hrId.toLowerCase()}`;"),
    "the identity reconciler must mint the SAME shape of key — a second spelling here is how one rep ends up under two keys and reads 0% on a full list",
  );

  const t = tree();
  assert.deepEqual(
    [...repKeysMatching(t, { region: "giza" })].sort(),
    ["hr:ai-0009", "hr:cn-0006"],
    "the cascade emits the keys the doctor board's rows actually carry",
  );
}

function testCascadeNarrowsWithoutTrappingTheViewer() {
  const t = tree();
  const all = narrowCoverageOptions(t, {});
  assert.equal(all.reps.length, 4, "no filter offers every rep");

  const inGiza = narrowCoverageOptions(t, { region: "giza" });
  assert.equal(inGiza.regions.length, all.regions.length, "picking a region never hides the other regions");
  assert.deepEqual(inGiza.reps.map((rep) => rep.name), ["Mona Adel", "Omayma Wael"], "and it narrows the reps");

  assert.equal(repKeysMatching(t, {}).size, 4, "an empty selection keeps everyone, rather than no one");
}

function testRepsMatchingCarriesHrIdForTheOtherBoard() {
  const t = tree();
  // Brick Coverage keys reps by bare canonical hr id, so it needs the id, not this module's key.
  assert.deepEqual(
    repsMatching(t, { region: "upper" }).map((rep) => rep.hrId).sort(),
    ["B-143", "B-58"],
    "the raw hr id survives, so each board can key it its own way",
  );
}

function testVacanciesFollowWhatIsOnScreen() {
  const t = tree();
  // Haram is the fixture's one vacancy: Giza, Pedia, seat nobody holds.
  assert.equal(vacanciesMatching(t, {}).length, 1, "with no filter, every vacancy is reported");
  assert.equal(vacanciesMatching(t, { region: "giza" }).length, 1, "Giza contains it");
  assert.equal(vacanciesMatching(t, { region: "upper" }).length, 0, "Upper Egypt does not — gaps follow the filter");

  // A selected rep is read as a place: gaps beside HIM, never the whole country's.
  assert.equal(
    vacanciesMatching(t, { rep: "hr:cn-0006" }).length,
    1,
    "Mona works Giza/Pedia, so the Giza/Pedia gap stands beside her",
  );
  assert.equal(
    vacanciesMatching(t, { rep: "hr:ai-0009" }).length,
    0,
    "Omayma works Giza/Anti Infective, so a Giza/PEDIA gap is not hers to answer for",
  );
  assert.equal(
    vacanciesMatching(t, { rep: "hr:b-143" }).length,
    0,
    "and a rep in another region entirely sees none of it",
  );
}

function testPruningRepairsAStaleUrl() {
  const t = tree();

  // Sohag is Upper Egypt only; pairing it with Giza is a link that has gone stale.
  assert.deepEqual(
    pruneCoverageSelection(t, { area: "sohag", region: "giza" }),
    { area: undefined, line: undefined, region: "giza", rep: undefined },
    "the impossible level is dropped and the possible one kept — not everything thrown away",
  );

  assert.deepEqual(
    pruneCoverageSelection(t, { region: "atlantis" }),
    { area: undefined, line: undefined, region: undefined, rep: undefined },
    "a code that does not exist at all resolves to no filter",
  );

  const intact = { area: "dokki", line: "anti_infective", region: "giza", rep: "hr:ai-0009" };
  assert.deepEqual(pruneCoverageSelection(t, intact), intact, "a valid selection passes through untouched");
}

/**
 * BUG 5 — the picker was wider than the viewer.
 *
 * Owner, 2026-08-28: "Anyone can filter by any line… and can choose any region and anything."
 *
 * The tree is read company-wide and cached under ONE key for everybody, and both boards handed it
 * straight to the filter bar. So a Medical Rep scoped to his own panel was offered every region,
 * every line, every area and all ~73 rep NAMES in the company, and a District Manager scoped to his
 * own team could pick any region in the country. The board's DATA was never wide — the access scope
 * is applied inside the service and the territory filter is intersected after it — so picking
 * somebody else's region returned an EMPTY board, which is precisely the "this team covered
 * nothing" misreading the whole cell model at the top of this module exists to prevent.
 */
function testRestrictionNarrowsThePickerToTheViewersOwnReps() {
  const t = tree();

  assert.equal(restrictCoverageFilterTree(t, null), t, "a company-scoped viewer is not restricted at all");

  // Omayma works Giza / Anti Infective / Dokki, and nothing else.
  const hers = restrictCoverageFilterTree(t, ["AI-0009"]);
  assert.deepEqual(hers.reps.map((rep) => rep.repName), ["Omayma Wael"], "THE HEADLINE: the rep picker names only the people in scope — not the whole roster");
  assert.deepEqual(hers.regions.map((r) => r.code), ["giza"], "and only the region she actually works");
  assert.deepEqual(hers.lines.map((l) => l.code), ["anti_infective"], "and only her line — no other line is offered at all");
  assert.deepEqual(hers.areas.map((a) => a.code), ["dokki"], "and only her area");

  // Casing and padding: hr ids arrive from a scope resolver in the session's own spelling.
  assert.deepEqual(
    restrictCoverageFilterTree(t, ["  ai-0009 "]).reps.map((rep) => rep.hrId),
    ["AI-0009"],
    "an hr id is matched case- and whitespace-insensitively, or a scoped viewer silently gets an empty picker",
  );

  // Whatever survives must still be reachable — a restricted tree that offers a dead end is the
  // same defect as the one the cell model was built to remove, just in a smaller box.
  for (const restricted of [hers, restrictCoverageFilterTree(t, ["CN-0006", "B-58"])]) {
    for (const region of [undefined, ...restricted.regions.map((r) => r.code)]) {
      for (const line of [undefined, ...narrowCoverageOptions(restricted, { region }).lines.map((l) => l.code)]) {
        for (const area of [undefined, ...narrowCoverageOptions(restricted, { line, region }).areas.map((a) => a.code)]) {
          assert.ok(
            repKeysMatching(restricted, { area, line, region }).size > 0,
            `a restricted picker must never offer a dead end: ${describeCoverageSelection(restricted, { area, line, region })}`,
          );
        }
      }
    }
  }

  // A gap is reported when it stands next to work the viewer owns, and hidden when it does not —
  // the same region+line adjacency rule `vacanciesMatching` already applies to a selected rep.
  assert.deepEqual(
    restrictCoverageFilterTree(t, ["CN-0006"]).vacancies.map((v) => v.areaCode),
    ["haram"],
    "Mona works Giza/Pedia, so the vacant Giza/Pedia territory beside her is hers to see",
  );
  assert.deepEqual(hers.vacancies, [], "Omayma is on another line, so that same gap is not offered to her");

  // A stale or hand-edited URL must not walk back out of the restriction.
  assert.deepEqual(
    pruneCoverageSelection(hers, { area: "beni", line: "pedia", region: "upper", rep: "hr:cn-0006" }),
    { area: undefined, line: undefined, region: undefined, rep: undefined },
    "a hand-typed URL pointing at somebody else's territory is pruned away, not honoured into an empty board",
  );

  // Both boards share this tree, so both pages must apply the restriction — and both must take the
  // allow-list from the access SCOPE, never from anything the browser sent.
  for (const page of [
    "app/(admin)/admin/doctor-coverage/page.tsx",
    "app/employee-portals/doctor-coverage/page.tsx",
    "app/(admin)/admin/brick-coverage/page.tsx",
  ]) {
    const source = readFileSync(page, "utf8");
    assert.match(
      source,
      /restrictCoverageFilterTree\(\s*await loadCoverageFilterTree\(\),\s*scope\.kind === "agents" \? scope\.agentHrIds : null,\s*\)/,
      `${page} must narrow the cached company-wide tree to the viewer's own scope before it reaches the filter bar`,
    );
  }
}

function testSelectionResolutionTreatsBlanksAsAbsent() {
  assert.deepEqual(
    resolveCoverageSelection({ area: "", line: "   ", region: "giza", rep: undefined }),
    { area: undefined, line: undefined, region: "giza", rep: undefined },
    "an empty query parameter is no filter at all, not a filter on the empty string",
  );
}

export function runCrmCoverageFilterTests() {
  testBuildsFromRealCombinations();
  testDroppedRowsAreCountedNotGuessed();
  testNoDeadEndCombination();
  testVacantTerritoriesAreHeldOutAndReported();
  // Key convention BEFORE the label check: a broken key also breaks the label (the rep name stops
  // resolving), and the label failing first would send the reader looking at the wrong thing.
  testRepKeyMatchesTheBoardConvention();
  testOptionsAndLabelsUseNames();
  testCascadeNarrowsWithoutTrappingTheViewer();
  testRepsMatchingCarriesHrIdForTheOtherBoard();
  testVacanciesFollowWhatIsOnScreen();
  testPruningRepairsAStaleUrl();
  testRestrictionNarrowsThePickerToTheViewersOwnReps();
  testSelectionResolutionTreatsBlanksAsAbsent();
}
